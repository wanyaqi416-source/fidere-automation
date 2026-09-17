import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Decimal from 'decimal.js';

export type WebullPreflightResult = {
  status: 'READY' | 'INSUFFICIENT_BALANCE' | 'ALREADY_OPEN' | 'EXISTING_APPLICATION';
  email: string;
  brokerStatus: string;
  currentBalance?: string;
  requiredBalance?: string;
  shortfall?: string;
};

type WebullPointer = {
  runId: string;
  sourceId: string;
  email: string;
  authorizedFee: string;
};

type WebullState = {
  stage?: string;
  adminReference?: string;
  clientSubmittedAt?: string;
};

export function evaluateWebullPreflight(input: {
  email: string;
  brokerStatus: string;
  currentBalance?: string;
  requiredBalance?: string;
}): WebullPreflightResult {
  if (/^(?:已开通|已开户)$/.test(input.brokerStatus)) return { ...input, status: 'ALREADY_OPEN' };
  if (input.brokerStatus !== '待开户') return { ...input, status: 'EXISTING_APPLICATION' };
  if (input.currentBalance === undefined || input.requiredBalance === undefined) {
    throw new Error('WEBULL_PREFLIGHT_BALANCE_OR_FEE_MISSING');
  }
  const current = new Decimal(input.currentBalance);
  const required = new Decimal(input.requiredBalance);
  const shortfall = Decimal.max(0, required.minus(current)).toDecimalPlaces(2, Decimal.ROUND_UP).toFixed(2);
  return {
    ...input,
    currentBalance: current.toFixed(2),
    requiredBalance: required.toFixed(2),
    shortfall,
    status: current.greaterThanOrEqualTo(required) ? 'READY' : 'INSUFFICIENT_BALANCE'
  };
}

export function parseWebullPreflightOutput(output: string): WebullPreflightResult {
  const line = output.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/)
    .find(value => value.startsWith('WEBULL_MENU_PREFLIGHT '));
  if (!line) throw new Error('WEBULL_PREFLIGHT_RESULT_UNAVAILABLE');
  return JSON.parse(line.slice('WEBULL_MENU_PREFLIGHT '.length)) as WebullPreflightResult;
}

export function webullPreflightEnvironment(email: string): Record<string, string> {
  const normalized = email.trim().toLowerCase();
  const sourceId = `WEBULL-USER-${createHash('sha256').update(normalized).digest('hex').slice(0, 12).toUpperCase()}`;
  return {
    CLIENT_USERNAME: normalized,
    WEBULL_TEST_EMAIL: normalized,
    BROKER_SOURCE_RUN_ID: sourceId,
    ALLOW_MONEY_TESTS: 'false',
    ALLOW_CLIENT_MUTATION_TESTS: 'false',
    ALLOW_ADMIN_MUTATION_TESTS: 'false'
  };
}

export function webullManualDepositEnvironment(preflight: WebullPreflightResult): Record<string, string> {
  if (preflight.status !== 'INSUFFICIENT_BALANCE' || !preflight.shortfall
    || new Decimal(preflight.shortfall).lessThanOrEqualTo(0)) {
    throw new Error('WEBULL_MANUAL_DEPOSIT_NOT_REQUIRED');
  }
  return {
    CLIENT_USERNAME: preflight.email,
    MANUAL_DEPOSIT_USER_EMAIL: preflight.email,
    MANUAL_DEPOSIT_MENU_AMOUNT: preflight.shortfall
  };
}

export function webullOpeningEnvironment(
  preflight: WebullPreflightResult,
  rootDirectory = resolve('.'),
  now = new Date()
): Record<string, string> {
  if (!['READY', 'EXISTING_APPLICATION'].includes(preflight.status) || !preflight.requiredBalance) {
    throw new Error('WEBULL_OPENING_PREFLIGHT_NOT_READY');
  }
  const base = webullPreflightEnvironment(preflight.email);
  const sourceId = base.BROKER_SOURCE_RUN_ID;
  const pointerPath = resolve(rootDirectory, '.flow-state', 'launcher', 'webull-opening.json');
  let active: { pointer: WebullPointer; state?: WebullState } | undefined;
  if (existsSync(pointerPath)) {
    const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as WebullPointer;
    const statePath = resolve(rootDirectory, '.flow-state', 'broker-journeys', pointer.sourceId,
      'webull-broker-opening', `${pointer.runId}.json`);
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) as WebullState : undefined;
    if ((!state || state.stage === 'PREPARED') && pointer.email === preflight.email) active = { pointer, state };
    else if (state && state.stage !== 'COMPLETED') {
      if (pointer.email !== preflight.email) throw new Error('WEBULL_OPENING_RESUME_REQUIRED_FOR_OTHER_USER');
      active = { pointer, state };
    }
  }

  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const pointer = active?.pointer ?? {
    runId: `OPEN-WEBULL-MENU14-${stamp}`,
    sourceId,
    email: preflight.email,
    authorizedFee: preflight.requiredBalance
  };
  if (pointer.authorizedFee !== preflight.requiredBalance || pointer.sourceId !== sourceId) {
    throw new Error('WEBULL_OPENING_RESUME_IDENTITY_OR_FEE_MISMATCH');
  }
  const stage = active?.state?.stage;
  if (preflight.status === 'EXISTING_APPLICATION' && !['ADMIN_LOCATED', 'ADMIN_APPROVAL_CONFIRMATION_REQUIRED'].includes(stage ?? '')) {
    throw new Error('WEBULL_OPENING_EXISTING_APPLICATION_RECONCILIATION_REQUIRED');
  }
  if (stage && ![
    'PREPARED', 'DOCUMENT_SIGNED', 'SECURITY_KEY_VERIFICATION_ATTEMPTED',
    'ADMIN_LOCATED', 'ADMIN_APPROVAL_CONFIRMATION_REQUIRED'
  ].includes(stage)) throw new Error('WEBULL_OPENING_RECONCILIATION_REQUIRED');

  mkdirSync(dirname(pointerPath), { recursive: true });
  writeFileSync(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8');
  const suffix = createHash('sha256').update(pointer.runId).digest('hex').slice(0, 12).toUpperCase();
  return {
    ...base,
    BROKER_OPENING_RUN_ID: pointer.runId,
    BROKER_AUTHORIZED_FEE: pointer.authorizedFee,
    BROKER_OPENING_ACCOUNT_NUMBER: `SBX${suffix}`,
    BROKER_OPENING_DATE: now.toISOString().slice(0, 10),
    BROKER_OPENING_MODE: ['ADMIN_LOCATED', 'ADMIN_APPROVAL_CONFIRMATION_REQUIRED'].includes(stage ?? '')
      ? 'resume-admin'
      : stage === 'SECURITY_KEY_VERIFICATION_ATTEMPTED' ? 'resume-security-setup' : 'fresh',
    ALLOW_CLIENT_MUTATION_TESTS: 'true',
    ALLOW_MONEY_TESTS: stage === 'ADMIN_LOCATED' || stage === 'ADMIN_APPROVAL_CONFIRMATION_REQUIRED' ? 'false' : 'true',
    ALLOW_ADMIN_MUTATION_TESTS: 'true'
  };
}
