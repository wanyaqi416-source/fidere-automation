import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launcherManualDepositEnvironment } from '../../scripts/launcher-manual-deposit-run';
import {
  evaluateTigerPreflight,
  parseTigerPreflightOutput,
  tigerManualDepositEnvironment,
  tigerOpeningEnvironment,
  tigerPreflightEnvironment
} from '../../scripts/launcher-tiger-run';

test('Tiger preflight distinguishes opened, ready and insufficient balances', () => {
  expect(evaluateTigerPreflight({
    email: 'opened@example.test', brokerStatus: '已开户', currentBalance: '100.00', requiredBalance: '50.00'
  }).status).toBe('ALREADY_OPEN');

  expect(evaluateTigerPreflight({
    email: 'ready@example.test', brokerStatus: '待开户', currentBalance: '100.00', requiredBalance: '100.00'
  })).toMatchObject({ status: 'READY', currentBalance: '100.00', requiredBalance: '100.00', shortfall: '0.00' });

  expect(evaluateTigerPreflight({
    email: 'low@example.test', brokerStatus: '待开户', currentBalance: '42.125', requiredBalance: '100.00'
  })).toMatchObject({ status: 'INSUFFICIENT_BALANCE', currentBalance: '42.13', requiredBalance: '100.00', shortfall: '57.88' });
});

test('Tiger manual deposit receives the same email and only the calculated shortfall', () => {
  const preflight = evaluateTigerPreflight({
    email: 'Tiger.User@example.test', brokerStatus: '待开户', currentBalance: '80.01', requiredBalance: '100.00'
  });
  expect(tigerManualDepositEnvironment(preflight)).toEqual({
    CLIENT_USERNAME: 'Tiger.User@example.test',
    MANUAL_DEPOSIT_USER_EMAIL: 'Tiger.User@example.test',
    MANUAL_DEPOSIT_MENU_AMOUNT: '19.99'
  });
  expect(() => tigerManualDepositEnvironment({ ...preflight, status: 'READY' })).toThrow('TIGER_MANUAL_DEPOSIT_NOT_REQUIRED');
});

test('Tiger launcher creates one fresh Run and resumes only the original Admin stage', () => {
  const root = mkdtempSync(join(tmpdir(), 'tiger-menu13-'));
  try {
    const preflight = evaluateTigerPreflight({
      email: 'tiger@example.test', brokerStatus: '待开户', currentBalance: '150.00', requiredBalance: '100.00'
    });
    const now = new Date('2026-09-15T10:20:30.000Z');
    const fresh = tigerOpeningEnvironment(preflight, root, now);
    expect(fresh).toMatchObject({
      CLIENT_USERNAME: 'tiger@example.test',
      TIGER_TEST_EMAIL: 'tiger@example.test',
      BROKER_OPENING_RUN_ID: 'OPEN-TIGER-MENU13-20260915102030',
      BROKER_AUTHORIZED_FEE: '100.00',
      BROKER_OPENING_MODE: 'fresh',
      ALLOW_MONEY_TESTS: 'true',
      ALLOW_ADMIN_MUTATION_TESTS: 'true'
    });

    const sourceId = fresh.BROKER_SOURCE_RUN_ID;
    const stateRoot = join(root, '.flow-state', 'broker-journeys', sourceId, 'tiger-broker-opening');
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(join(stateRoot, `${fresh.BROKER_OPENING_RUN_ID}.json`), JSON.stringify({
      stage: 'ADMIN_LOCATED', adminReference: '29', clientSubmittedAt: '2026-09-15T10:21:00.000Z'
    }));
    const pending = { ...preflight, status: 'EXISTING_APPLICATION' as const, brokerStatus: '审核中' };
    expect(tigerOpeningEnvironment(pending, root, now)).toMatchObject({
      BROKER_OPENING_RUN_ID: fresh.BROKER_OPENING_RUN_ID,
      BROKER_OPENING_MODE: 'resume-admin',
      ALLOW_MONEY_TESTS: 'false'
    });

    writeFileSync(join(stateRoot, `${fresh.BROKER_OPENING_RUN_ID}.json`), JSON.stringify({ stage: 'SECURITY_KEY_VERIFICATION_ATTEMPTED' }));
    expect(tigerOpeningEnvironment(preflight, root, now)).toMatchObject({
      BROKER_OPENING_RUN_ID: fresh.BROKER_OPENING_RUN_ID,
      BROKER_OPENING_MODE: 'resume-security-setup',
      ALLOW_MONEY_TESTS: 'true'
    });

    writeFileSync(join(stateRoot, `${fresh.BROKER_OPENING_RUN_ID}.json`), JSON.stringify({ stage: 'CLIENT_CREATED' }));
    expect(() => tigerOpeningEnvironment(pending, root, now)).toThrow('TIGER_OPENING_EXISTING_APPLICATION_RECONCILIATION_REQUIRED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Tiger preflight output is machine-readable and uses read-only switches', () => {
  const parsed = parseTigerPreflightOutput('noise\nTIGER_MENU_PREFLIGHT {"status":"READY","email":"t@example.test","brokerStatus":"待开户","currentBalance":"100.00","requiredBalance":"100.00","shortfall":"0.00"}\n');
  expect(parsed.status).toBe('READY');
  expect(tigerPreflightEnvironment('T@Example.test')).toMatchObject({
    CLIENT_USERNAME: 't@example.test',
    TIGER_TEST_EMAIL: 't@example.test',
    ALLOW_MONEY_TESTS: 'false',
    ALLOW_ADMIN_MUTATION_TESTS: 'false'
  });
});

test('Menu 18 standalone default amount remains independent from Tiger shortfall', () => {
  const root = mkdtempSync(join(tmpdir(), 'manual-deposit-independent-'));
  try {
    const standalone = launcherManualDepositEnvironment({ MANUAL_DEPOSIT_USER_EMAIL: 'standalone@example.test' }, root,
      new Date('2026-09-15T11:00:00.000Z'));
    expect(standalone.MANUAL_DEPOSIT_AUTHORIZED_AMOUNT).toBe('200.00');
    expect(standalone.MANUAL_DEPOSIT_USER_EMAIL).toBe('standalone@example.test');
    const pointer = JSON.parse(readFileSync(join(root, '.flow-state', 'launcher', 'admin-manual-deposit.json'), 'utf8')) as { email: string };
    expect(pointer.email).toBe('standalone@example.test');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
