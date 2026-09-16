import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Decimal from 'decimal.js';

export type LauncherJurisdiction = 'BH' | 'SG';

export type JurisdictionOpeningPreflightResult = {
  target: LauncherJurisdiction;
  status: 'READY' | 'INSUFFICIENT_BALANCE' | 'ALREADY_OPEN' | 'EXISTING_APPLICATION';
  email: string;
  accountStatus: string;
  currentBalance?: string;
  requiredBalance?: string;
  shortfall?: string;
};

type JurisdictionPointer = {
  runId: string;
  email: string;
  requiredBalance: string;
  balanceBefore: string;
  manualDepositRunId?: string;
  manualDepositAmount?: string;
};

type FlowState = {
  stage?: string;
};

const CONFIG = {
  BH: {
    accountName: '巴林账户',
    flowId: 'account-opening-bahrain-approve',
    pointerName: 'bahrain-opening.json',
    runPrefix: 'OPEN-BH-MENU15',
    runVariable: 'BAHRAIN_OPENING_RUN_ID',
    authorizedEmailVariable: 'BAHRAIN_OPENING_AUTHORIZED_EMAIL',
    balanceBeforeVariable: 'BAHRAIN_OPENING_BALANCE_BEFORE'
  },
  SG: {
    accountName: '新加坡账户',
    flowId: 'account-opening-singapore-approve',
    pointerName: 'singapore-opening.json',
    runPrefix: 'OPEN-SG-MENU17',
    runVariable: 'SINGAPORE_OPENING_RUN_ID',
    authorizedEmailVariable: 'SINGAPORE_OPENING_AUTHORIZED_EMAIL',
    balanceBeforeVariable: 'SINGAPORE_OPENING_BALANCE_BEFORE'
  }
} as const;

function pointerPath(target: LauncherJurisdiction, rootDirectory: string): string {
  return resolve(rootDirectory, '.flow-state', 'launcher', CONFIG[target].pointerName);
}

function statePath(target: LauncherJurisdiction, pointer: JurisdictionPointer, rootDirectory: string): string {
  return resolve(rootDirectory, '.flow-state', CONFIG[target].flowId, `${pointer.runId}.json`);
}

function readPointer(target: LauncherJurisdiction, rootDirectory: string): JurisdictionPointer | undefined {
  const path = pointerPath(target, rootDirectory);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as JurisdictionPointer : undefined;
}

function writePointer(target: LauncherJurisdiction, pointer: JurisdictionPointer, rootDirectory: string): void {
  const path = pointerPath(target, rootDirectory);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8');
}

function loadState(target: LauncherJurisdiction, pointer: JurisdictionPointer, rootDirectory: string): FlowState | undefined {
  const path = statePath(target, pointer, rootDirectory);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as FlowState : undefined;
}

export function evaluateJurisdictionOpeningPreflight(input: {
  target: LauncherJurisdiction;
  email: string;
  accountStatus: string;
  currentBalance?: string;
  requiredBalance?: string;
}): JurisdictionOpeningPreflightResult {
  const email = input.email.trim().toLowerCase();
  if (input.accountStatus === '已开通') return { ...input, email, status: 'ALREADY_OPEN' };
  if (input.accountStatus !== '可申请') return { ...input, email, status: 'EXISTING_APPLICATION' };
  if (input.currentBalance === undefined || input.requiredBalance === undefined) {
    throw new Error(`${input.target}_OPENING_PREFLIGHT_BALANCE_OR_FEE_MISSING`);
  }
  const current = new Decimal(input.currentBalance);
  const required = new Decimal(input.requiredBalance);
  const shortfall = Decimal.max(0, required.minus(current)).toDecimalPlaces(2, Decimal.ROUND_UP).toFixed(2);
  return {
    ...input,
    email,
    currentBalance: current.toFixed(2),
    requiredBalance: required.toFixed(2),
    shortfall,
    status: current.greaterThanOrEqualTo(required) ? 'READY' : 'INSUFFICIENT_BALANCE'
  };
}

export function parseJurisdictionOpeningPreflightOutput(output: string): JurisdictionOpeningPreflightResult {
  const line = output.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/)
    .find(value => value.startsWith('JURISDICTION_MENU_PREFLIGHT '));
  if (!line) throw new Error('JURISDICTION_OPENING_PREFLIGHT_RESULT_UNAVAILABLE');
  return JSON.parse(line.slice('JURISDICTION_MENU_PREFLIGHT '.length)) as JurisdictionOpeningPreflightResult;
}

export function jurisdictionOpeningPreflightEnvironment(
  target: LauncherJurisdiction,
  email: string
): Record<string, string> {
  const normalized = email.trim().toLowerCase();
  return {
    CLIENT_USERNAME: normalized,
    OPENING_TEST_EMAIL: normalized,
    JURISDICTION_OPENING_TARGET: target,
    ALLOW_MONEY_TESTS: 'false',
    ALLOW_CLIENT_MUTATION_TESTS: 'false',
    ALLOW_ADMIN_MUTATION_TESTS: 'false'
  };
}

export function jurisdictionOpeningEnvironment(
  preflight: JurisdictionOpeningPreflightResult,
  rootDirectory = resolve('.'),
  now = new Date()
): Record<string, string> {
  const config = CONFIG[preflight.target];
  let pointer = readPointer(preflight.target, rootDirectory);
  let state = pointer ? loadState(preflight.target, pointer, rootDirectory) : undefined;
  if (pointer && pointer.email !== preflight.email) {
    if (!state || state.stage !== 'COMPLETED') {
      throw new Error(`${preflight.target}_OPENING_RESUME_REQUIRED_FOR_OTHER_USER`);
    }
    pointer = undefined;
    state = undefined;
  }
  const requiredBalance = preflight.requiredBalance ?? pointer?.requiredBalance;
  const currentBalance = preflight.currentBalance ?? pointer?.balanceBefore;
  if (!requiredBalance || !currentBalance) {
    throw new Error(`${preflight.target}_OPENING_PREFLIGHT_NOT_READY`);
  }
  if (!pointer) {
    const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    pointer = {
      runId: `${config.runPrefix}-${stamp}`,
      email: preflight.email,
      requiredBalance,
      balanceBefore: currentBalance
    };
  }
  if (pointer.requiredBalance !== requiredBalance) {
    throw new Error(`${preflight.target}_OPENING_RESUME_FEE_MISMATCH`);
  }
  if (state?.stage === 'COMPLETED') throw new Error(`${preflight.target}_OPENING_ALREADY_COMPLETED`);
  const allowedStages = [undefined, 'PREPARED', 'SECURITY_KEY_VERIFICATION_ATTEMPTED', 'CLIENT_CREATED'];
  if (!allowedStages.includes(state?.stage)) {
    throw new Error(`${preflight.target}_OPENING_RECONCILIATION_REQUIRED`);
  }
  if (preflight.status === 'EXISTING_APPLICATION' && state?.stage !== 'CLIENT_CREATED') {
    throw new Error(`${preflight.target}_OPENING_EXISTING_APPLICATION_RECONCILIATION_REQUIRED`);
  }
  if (preflight.status === 'INSUFFICIENT_BALANCE' && pointer.manualDepositRunId) {
    throw new Error('MANUAL_DEPOSIT_RESULT_UNCONFIRMED: 已记录一次补款尝试且余额仍不足，禁止再次入金。');
  }
  if (!state || state.stage === 'PREPARED') pointer.balanceBefore = currentBalance;
  writePointer(preflight.target, pointer, rootDirectory);

  const environment: Record<string, string> = {
    ...jurisdictionOpeningPreflightEnvironment(preflight.target, preflight.email),
    [config.runVariable]: pointer.runId,
    [config.authorizedEmailVariable]: pointer.email,
    ALLOW_MONEY_TESTS: 'true',
    ALLOW_ADMIN_MUTATION_TESTS: 'true'
  };
  if (state?.stage === 'CLIENT_CREATED') {
    environment[config.balanceBeforeVariable] = pointer.balanceBefore;
    environment.JURISDICTION_OPENING_MODE = 'resume-client-created';
  } else if (state?.stage === 'SECURITY_KEY_VERIFICATION_ATTEMPTED') {
    environment.JURISDICTION_OPENING_MODE = 'resume-security-setup';
  } else {
    environment.JURISDICTION_OPENING_MODE = 'fresh';
  }
  return environment;
}

export function jurisdictionManualDepositInput(
  preflight: JurisdictionOpeningPreflightResult
): Record<string, string> {
  if (preflight.status !== 'INSUFFICIENT_BALANCE' || !preflight.shortfall ||
      new Decimal(preflight.shortfall).lessThanOrEqualTo(0)) {
    throw new Error(`${preflight.target}_OPENING_MANUAL_DEPOSIT_NOT_REQUIRED`);
  }
  return {
    CLIENT_USERNAME: preflight.email,
    MANUAL_DEPOSIT_USER_EMAIL: preflight.email,
    MANUAL_DEPOSIT_MENU_AMOUNT: preflight.shortfall
  };
}

export function markJurisdictionTopUpAttempt(input: {
  target: LauncherJurisdiction;
  openingRunId: string;
  manualDepositRunId: string;
  amount: string;
  rootDirectory?: string;
}): void {
  const rootDirectory = input.rootDirectory ?? resolve('.');
  const pointer = readPointer(input.target, rootDirectory);
  if (!pointer || pointer.runId !== input.openingRunId) {
    throw new Error(`${input.target}_OPENING_POINTER_MISMATCH`);
  }
  if (pointer.manualDepositRunId) {
    throw new Error('MANUAL_DEPOSIT_DUPLICATE_ATTEMPT_BLOCKED');
  }
  writePointer(input.target, {
    ...pointer,
    manualDepositRunId: input.manualDepositRunId,
    manualDepositAmount: input.amount
  }, rootDirectory);
}

export function jurisdictionOpeningRunId(
  target: LauncherJurisdiction,
  environment: Readonly<Record<string, string>>
): string {
  return environment[CONFIG[target].runVariable];
}

export function jurisdictionAccountName(target: LauncherJurisdiction): string {
  return CONFIG[target].accountName;
}
