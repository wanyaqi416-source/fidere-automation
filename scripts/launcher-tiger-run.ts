import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Decimal from 'decimal.js';

export type TigerPreflightResult = {
  status: 'READY' | 'INSUFFICIENT_BALANCE' | 'ALREADY_OPEN' | 'EXISTING_APPLICATION';
  email: string;
  brokerStatus: string;
  currentBalance?: string;
  requiredBalance?: string;
  shortfall?: string;
};

type TigerPointer = {
  runId: string;
  sourceId: string;
  email: string;
  authorizedFee: string;
};

type TigerState = {
  stage?: string;
  adminReference?: string;
  clientSubmittedAt?: string;
};

export function evaluateTigerPreflight(input: {
  email: string;
  brokerStatus: string;
  currentBalance?: string;
  requiredBalance?: string;
}): TigerPreflightResult {
  if (/^(?:已开通|已开户)$/.test(input.brokerStatus)) {
    return { ...input, status: 'ALREADY_OPEN' };
  }
  if (input.brokerStatus !== '待开户') {
    return { ...input, status: 'EXISTING_APPLICATION' };
  }
  if (input.currentBalance === undefined || input.requiredBalance === undefined) {
    throw new Error('TIGER_PREFLIGHT_BALANCE_OR_FEE_MISSING');
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

export function parseTigerPreflightOutput(output: string): TigerPreflightResult {
  const line = output.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/)
    .find(value => value.startsWith('TIGER_MENU_PREFLIGHT '));
  if (!line) throw new Error('TIGER_PREFLIGHT_RESULT_UNAVAILABLE');
  return JSON.parse(line.slice('TIGER_MENU_PREFLIGHT '.length)) as TigerPreflightResult;
}

export function tigerPreflightEnvironment(email: string): Record<string, string> {
  const sourceId = `TIGER-USER-${createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 12).toUpperCase()}`;
  return {
    CLIENT_USERNAME: email.toLowerCase(),
    TIGER_TEST_EMAIL: email.toLowerCase(),
    BROKER_SOURCE_RUN_ID: sourceId,
    ALLOW_MONEY_TESTS: 'false',
    ALLOW_ADMIN_MUTATION_TESTS: 'false'
  };
}

export function tigerManualDepositEnvironment(
  preflight: TigerPreflightResult
): Record<string, string> {
  if (preflight.status !== 'INSUFFICIENT_BALANCE' || !preflight.shortfall || new Decimal(preflight.shortfall).lessThanOrEqualTo(0)) {
    throw new Error('TIGER_MANUAL_DEPOSIT_NOT_REQUIRED');
  }
  return {
    CLIENT_USERNAME: preflight.email,
    MANUAL_DEPOSIT_USER_EMAIL: preflight.email,
    MANUAL_DEPOSIT_MENU_AMOUNT: preflight.shortfall
  };
}

export function tigerOpeningEnvironment(
  preflight: TigerPreflightResult,
  rootDirectory = resolve('.'),
  now = new Date()
): Record<string, string> {
  if (!['READY', 'EXISTING_APPLICATION'].includes(preflight.status) || !preflight.requiredBalance) {
    throw new Error('TIGER_OPENING_PREFLIGHT_NOT_READY');
  }
  const preflightEnvironment = tigerPreflightEnvironment(preflight.email);
  const sourceId = preflightEnvironment.BROKER_SOURCE_RUN_ID;
  const pointerPath = resolve(rootDirectory, '.flow-state', 'launcher', 'tiger-opening.json');
  let active: { pointer: TigerPointer; state?: TigerState } | undefined;
  if (existsSync(pointerPath)) {
    const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as TigerPointer;
    const statePath = resolve(rootDirectory, '.flow-state', 'broker-journeys', pointer.sourceId,
      'tiger-broker-opening', `${pointer.runId}.json`);
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) as TigerState : undefined;
    if ((!state || state.stage === 'PREPARED') && pointer.email === preflight.email) active = { pointer, state };
    else if (state && state.stage !== 'COMPLETED') {
      if (pointer.email !== preflight.email) throw new Error('TIGER_OPENING_RESUME_REQUIRED_FOR_OTHER_USER');
      active = { pointer, state };
    }
  }

  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const pointer = active?.pointer ?? {
    runId: `OPEN-TIGER-MENU13-${stamp}`,
    sourceId,
    email: preflight.email,
    authorizedFee: preflight.requiredBalance
  };
  if (pointer.authorizedFee !== preflight.requiredBalance || pointer.sourceId !== sourceId) {
    throw new Error('TIGER_OPENING_RESUME_IDENTITY_OR_FEE_MISMATCH');
  }
  const stage = active?.state?.stage;
  const resumeAdmin = stage === 'ADMIN_LOCATED' || stage === 'ADMIN_APPROVAL_CONFIRMATION_REQUIRED';
  const resumeSecuritySetup = stage === 'SECURITY_KEY_VERIFICATION_ATTEMPTED';
  if (preflight.status === 'EXISTING_APPLICATION' && !resumeAdmin) {
    throw new Error('TIGER_OPENING_EXISTING_APPLICATION_RECONCILIATION_REQUIRED');
  }
  if (stage && !['PREPARED', 'SECURITY_KEY_VERIFICATION_ATTEMPTED', 'ADMIN_LOCATED', 'ADMIN_APPROVAL_CONFIRMATION_REQUIRED'].includes(stage)) {
    throw new Error('TIGER_OPENING_RECONCILIATION_REQUIRED');
  }
  mkdirSync(dirname(pointerPath), { recursive: true });
  writeFileSync(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8');
  const accountSuffix = createHash('sha256').update(pointer.runId).digest('hex').slice(0, 12).toUpperCase();
  return {
    ...preflightEnvironment,
    BROKER_OPENING_RUN_ID: pointer.runId,
    BROKER_AUTHORIZED_FEE: pointer.authorizedFee,
    BROKER_OPENING_ACCOUNT_NUMBER: `SBX${accountSuffix}`,
    BROKER_OPENING_DATE: now.toISOString().slice(0, 10),
    BROKER_OPENING_MODE: resumeAdmin ? 'resume-admin' : resumeSecuritySetup ? 'resume-security-setup' : 'fresh',
    ALLOW_MONEY_TESTS: resumeAdmin ? 'false' : 'true',
    ALLOW_ADMIN_MUTATION_TESTS: 'true'
  };
}
