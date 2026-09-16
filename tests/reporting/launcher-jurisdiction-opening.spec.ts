import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  evaluateJurisdictionOpeningPreflight,
  jurisdictionManualDepositInput,
  jurisdictionOpeningEnvironment,
  jurisdictionOpeningPreflightEnvironment,
  markJurisdictionTopUpAttempt,
  parseJurisdictionOpeningPreflightOutput
} from '../../scripts/launcher-jurisdiction-opening-run';
import { launcherManualDepositEnvironment } from '../../scripts/launcher-manual-deposit-run';

test('巴林和新加坡分别判断已开户、余额充足及余额不足', () => {
  expect(evaluateJurisdictionOpeningPreflight({
    target: 'BH', email: 'Opened@example.test', accountStatus: '已开通'
  })).toMatchObject({ status: 'ALREADY_OPEN', email: 'opened@example.test' });
  expect(evaluateJurisdictionOpeningPreflight({
    target: 'BH', email: 'ready@example.test', accountStatus: '可申请', currentBalance: '100', requiredBalance: '100'
  })).toMatchObject({ status: 'READY', shortfall: '0.00' });
  expect(evaluateJurisdictionOpeningPreflight({
    target: 'SG', email: 'low@example.test', accountStatus: '可申请', currentBalance: '7.111', requiredBalance: '10.00'
  })).toMatchObject({ status: 'INSUFFICIENT_BALANCE', currentBalance: '7.11', requiredBalance: '10.00', shortfall: '2.89' });
});

test('只读预检环境使用本次邮箱且关闭所有Mutation', () => {
  expect(jurisdictionOpeningPreflightEnvironment('BH', 'User@Example.test')).toEqual({
    CLIENT_USERNAME: 'user@example.test',
    OPENING_TEST_EMAIL: 'user@example.test',
    JURISDICTION_OPENING_TARGET: 'BH',
    ALLOW_MONEY_TESTS: 'false',
    ALLOW_CLIENT_MUTATION_TESTS: 'false',
    ALLOW_ADMIN_MUTATION_TESTS: 'false'
  });
  expect(parseJurisdictionOpeningPreflightOutput(
    'noise\nJURISDICTION_MENU_PREFLIGHT {"target":"SG","status":"ALREADY_OPEN","email":"x@example.test","accountStatus":"已开通"}\n'
  ).status).toBe('ALREADY_OPEN');
});

test('巴林和新加坡创建独立命名Run并传入原Runner变量', () => {
  const root = mkdtempSync(join(tmpdir(), 'jurisdiction-opening-'));
  try {
    const now = new Date('2026-09-15T12:34:56.000Z');
    const bh = jurisdictionOpeningEnvironment(evaluateJurisdictionOpeningPreflight({
      target: 'BH', email: 'bh@example.test', accountStatus: '可申请', currentBalance: '110', requiredBalance: '100'
    }), root, now);
    const sg = jurisdictionOpeningEnvironment(evaluateJurisdictionOpeningPreflight({
      target: 'SG', email: 'sg@example.test', accountStatus: '可申请', currentBalance: '1200', requiredBalance: '1000'
    }), root, now);
    expect(bh).toMatchObject({
      OPENING_TEST_EMAIL: 'bh@example.test',
      BAHRAIN_OPENING_RUN_ID: 'OPEN-BH-MENU15-20260915123456',
      BAHRAIN_OPENING_AUTHORIZED_EMAIL: 'bh@example.test'
    });
    expect(sg).toMatchObject({
      OPENING_TEST_EMAIL: 'sg@example.test',
      SINGAPORE_OPENING_RUN_ID: 'OPEN-SG-MENU17-20260915123456',
      SINGAPORE_OPENING_AUTHORIZED_EMAIL: 'sg@example.test'
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('余额不足仅补精确缺口并阻止第二次补款', () => {
  const root = mkdtempSync(join(tmpdir(), 'jurisdiction-topup-'));
  try {
    const preflight = evaluateJurisdictionOpeningPreflight({
      target: 'BH', email: 'same@example.test', accountStatus: '可申请', currentBalance: '80.01', requiredBalance: '100'
    });
    expect(jurisdictionManualDepositInput(preflight)).toEqual({
      CLIENT_USERNAME: 'same@example.test',
      MANUAL_DEPOSIT_USER_EMAIL: 'same@example.test',
      MANUAL_DEPOSIT_MENU_AMOUNT: '19.99'
    });
    const manual = launcherManualDepositEnvironment(jurisdictionManualDepositInput(preflight), root,
      new Date('2026-09-15T12:59:59.000Z'));
    expect(manual).toMatchObject({
      CLIENT_USERNAME: 'same@example.test',
      MANUAL_DEPOSIT_USER_EMAIL: 'same@example.test',
      MANUAL_DEPOSIT_AUTHORIZED_AMOUNT: '19.99'
    });
    const opening = jurisdictionOpeningEnvironment(preflight, root, new Date('2026-09-15T13:00:00.000Z'));
    markJurisdictionTopUpAttempt({
      target: 'BH', openingRunId: opening.BAHRAIN_OPENING_RUN_ID,
      manualDepositRunId: manual.MANUAL_DEPOSIT_RUN_ID, amount: '19.99', rootDirectory: root
    });
    expect(() => jurisdictionOpeningEnvironment(preflight, root)).toThrow('MANUAL_DEPOSIT_RESULT_UNCONFIRMED');
    expect(() => markJurisdictionTopUpAttempt({
      target: 'BH', openingRunId: opening.BAHRAIN_OPENING_RUN_ID,
      manualDepositRunId: 'ADMIN-MD-TWO', amount: '19.99', rootDirectory: root
    })).toThrow('MANUAL_DEPOSIT_DUPLICATE_ATTEMPT_BLOCKED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Client已创建时只Resume原Run并恢复原开户前余额', () => {
  const root = mkdtempSync(join(tmpdir(), 'jurisdiction-resume-'));
  try {
    const preflight = evaluateJurisdictionOpeningPreflight({
      target: 'SG', email: 'resume@example.test', accountStatus: '可申请', currentBalance: '1000', requiredBalance: '1000'
    });
    const fresh = jurisdictionOpeningEnvironment(preflight, root, new Date('2026-09-15T14:00:00.000Z'));
    const stateDirectory = join(root, '.flow-state', 'account-opening-singapore-approve');
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(stateDirectory, `${fresh.SINGAPORE_OPENING_RUN_ID}.json`), JSON.stringify({ stage: 'CLIENT_CREATED' }));
    const resume = jurisdictionOpeningEnvironment({
      target: 'SG', status: 'EXISTING_APPLICATION', email: 'resume@example.test', accountStatus: '申请中'
    }, root);
    expect(resume).toMatchObject({
      SINGAPORE_OPENING_RUN_ID: fresh.SINGAPORE_OPENING_RUN_ID,
      SINGAPORE_OPENING_BALANCE_BEFORE: '1000.00',
      JURISDICTION_OPENING_MODE: 'resume-client-created'
    });
    expect(readFileSync(join(root, '.flow-state', 'launcher', 'singapore-opening.json'), 'utf8')).toContain('resume@example.test');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
