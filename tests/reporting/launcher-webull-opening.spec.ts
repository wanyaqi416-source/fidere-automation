import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect } from '@playwright/test';

import {
  evaluateWebullPreflight,
  parseWebullPreflightOutput,
  webullManualDepositEnvironment,
  webullOpeningEnvironment,
  webullPreflightEnvironment
} from '../../scripts/launcher-webull-run';

const createTemporaryDirectory = (name: string) => mkdtempSync(join(tmpdir(), `${name}-`));
const removeTemporaryDirectory = (directory: string) => rmSync(directory, { recursive: true, force: true });

test('Webull launcher evaluates exact funding requirements', () => {
  expect(evaluateWebullPreflight({
    email: 'user@example.test', brokerStatus: '待开户', currentBalance: '99.99', requiredBalance: '100'
  })).toMatchObject({ status: 'INSUFFICIENT_BALANCE', shortfall: '0.01' });
  expect(evaluateWebullPreflight({
    email: 'user@example.test', brokerStatus: '待开户', currentBalance: '100', requiredBalance: '100'
  }).status).toBe('READY');
  expect(evaluateWebullPreflight({
    email: 'user@example.test', brokerStatus: '已开通', currentBalance: '100', requiredBalance: '100'
  }).status).toBe('ALREADY_OPEN');
});

test('Webull launcher parses preflight and passes the same user to manual deposit', () => {
  const result = parseWebullPreflightOutput('noise\nWEBULL_MENU_PREFLIGHT {"status":"INSUFFICIENT_BALANCE","email":"user@example.test","brokerStatus":"待开户","currentBalance":"0.00","requiredBalance":"100.00","shortfall":"100.00"}\n');
  expect(webullManualDepositEnvironment(result)).toEqual({
    CLIENT_USERNAME: 'user@example.test',
    MANUAL_DEPOSIT_USER_EMAIL: 'user@example.test',
    MANUAL_DEPOSIT_MENU_AMOUNT: '100.00'
  });
  expect(webullPreflightEnvironment('USER@EXAMPLE.TEST')).toMatchObject({
    CLIENT_USERNAME: 'user@example.test',
    WEBULL_TEST_EMAIL: 'user@example.test',
    ALLOW_MONEY_TESTS: 'false',
    ALLOW_CLIENT_MUTATION_TESTS: 'false'
  });
});

test('Webull launcher creates one named fresh Run and enables all required mutation switches', () => {
  const root = createTemporaryDirectory('webull-launcher');
  try {
    const ready = evaluateWebullPreflight({
      email: 'user@example.test', brokerStatus: '待开户', currentBalance: '100', requiredBalance: '100'
    });
    const environment = webullOpeningEnvironment(ready, root, new Date('2026-09-16T08:00:00Z'));
    expect(environment).toMatchObject({
      CLIENT_USERNAME: 'user@example.test',
      WEBULL_TEST_EMAIL: 'user@example.test',
      BROKER_OPENING_RUN_ID: 'OPEN-WEBULL-MENU14-20260916080000',
      BROKER_AUTHORIZED_FEE: '100.00',
      BROKER_OPENING_MODE: 'fresh',
      ALLOW_CLIENT_MUTATION_TESTS: 'true',
      ALLOW_MONEY_TESTS: 'true',
      ALLOW_ADMIN_MUTATION_TESTS: 'true'
    });
    expect(existsSync(join(root, '.flow-state', 'launcher', 'webull-opening.json'))).toBe(true);
    expect(webullOpeningEnvironment(ready, root, new Date('2026-09-16T09:00:00Z')).BROKER_OPENING_RUN_ID)
      .toBe(environment.BROKER_OPENING_RUN_ID);
  } finally {
    removeTemporaryDirectory(root);
  }
});

test('Webull launcher refuses a different user while an unfinished mutation exists', () => {
  const root = createTemporaryDirectory('webull-launcher-resume');
  try {
    const first = evaluateWebullPreflight({
      email: 'first@example.test', brokerStatus: '待开户', currentBalance: '100', requiredBalance: '100'
    });
    const environment = webullOpeningEnvironment(first, root, new Date('2026-09-16T08:00:00Z'));
    const sourceId = environment.BROKER_SOURCE_RUN_ID;
    const stateDirectory = join(root, '.flow-state', 'broker-journeys', sourceId, 'webull-broker-opening');
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(stateDirectory, `${environment.BROKER_OPENING_RUN_ID}.json`), JSON.stringify({
      schemaVersion: 1,
      runId: environment.BROKER_OPENING_RUN_ID,
      flowId: 'webull-broker-opening',
      preparedAt: '2026-09-16T08:00:00.000Z',
      updatedAt: '2026-09-16T08:01:00.000Z',
      stage: 'DOCUMENT_SIGNED'
    }), 'utf8');
    const second = evaluateWebullPreflight({
      email: 'second@example.test', brokerStatus: '待开户', currentBalance: '100', requiredBalance: '100'
    });
    expect(() => webullOpeningEnvironment(second, root, new Date('2026-09-16T09:00:00Z')))
      .toThrow('WEBULL_OPENING_RESUME_REQUIRED_FOR_OTHER_USER');
  } finally {
    removeTemporaryDirectory(root);
  }
});

test('Webull launcher resumes the same Run at first-time Security Key setup', () => {
  const root = createTemporaryDirectory('webull-launcher-security-resume');
  try {
    const ready = evaluateWebullPreflight({
      email: 'user@example.test', brokerStatus: '待开户', currentBalance: '100', requiredBalance: '100'
    });
    const fresh = webullOpeningEnvironment(ready, root, new Date('2026-09-16T08:00:00Z'));
    const stateDirectory = join(root, '.flow-state', 'broker-journeys', fresh.BROKER_SOURCE_RUN_ID,
      'webull-broker-opening');
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(stateDirectory, `${fresh.BROKER_OPENING_RUN_ID}.json`), JSON.stringify({
      schemaVersion: 1,
      runId: fresh.BROKER_OPENING_RUN_ID,
      flowId: 'webull-broker-opening',
      preparedAt: '2026-09-16T08:00:00.000Z',
      updatedAt: '2026-09-16T08:01:00.000Z',
      stage: 'SECURITY_KEY_VERIFICATION_ATTEMPTED'
    }), 'utf8');

    const resumed = webullOpeningEnvironment(ready, root, new Date('2026-09-16T09:00:00Z'));
    expect(resumed).toMatchObject({
      BROKER_OPENING_RUN_ID: fresh.BROKER_OPENING_RUN_ID,
      BROKER_OPENING_MODE: 'resume-security-setup',
      ALLOW_CLIENT_MUTATION_TESTS: 'true',
      ALLOW_MONEY_TESTS: 'true',
      ALLOW_ADMIN_MUTATION_TESTS: 'true'
    });
  } finally {
    removeTemporaryDirectory(root);
  }
});
