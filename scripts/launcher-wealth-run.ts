import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { isValidEmail } from '../src/utils/runtime-email.js';

type WealthLauncherPointer = {
  runId: string;
};

type WealthRunState = {
  stage?: string;
};

type WealthRejectionPointer = WealthLauncherPointer & {
  username: string;
  product: string;
  amount: string;
};

const pointerPath = resolve('.flow-state', 'launcher', 'wealth-subscribe.json');

function readState(runId: string): WealthRunState | undefined {
  const path = resolve('.flow-state', 'wealth-subscription', `${runId}.json`);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as WealthRunState;
}

function currentRun(): { runId: string; resume: boolean } | undefined {
  if (!existsSync(pointerPath)) return undefined;
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as WealthLauncherPointer;
  const state = readState(pointer.runId);
  if (state?.stage === 'COMPLETED') return undefined;
  return { runId: pointer.runId, resume: Boolean(state) };
}

function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `WS003-MENU10-${stamp}`;
}

function rejectionAmount(runId: string): string {
  const cents = (createHash('sha256').update(runId).digest().readUInt16BE(0) % 89) + 10;
  return (1 + cents / 100).toFixed(2);
}

export function launcherWealthSubscriptionRejectionEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  rootDirectory = resolve('.'),
  now = new Date()
): Record<string, string> {
  const username = environment.CLIENT_USERNAME?.trim().toLowerCase() ?? '';
  if (!isValidEmail(username)) {
    throw new Error('WEALTH_TEST_USERNAME_REQUIRED: 请在 CLIENT_USERNAME 配置合法的测试用户邮箱。');
  }
  const product = environment.WEALTH_MENU_REJECTION_PRODUCT?.trim() || 'Galaxy Digital Lending';
  const pointerPath = resolve(rootDirectory, '.flow-state', 'launcher', 'wealth-subscribe-reject.json');
  let active: WealthRejectionPointer | undefined;
  if (existsSync(pointerPath)) {
    const saved = JSON.parse(readFileSync(pointerPath, 'utf8')) as WealthRejectionPointer;
    const statePath = resolve(rootDirectory, '.flow-state', 'wealth-subscription', `${saved.runId}.json`);
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) as WealthRunState : undefined;
    if (state?.stage !== 'COMPLETED') {
      if (saved.username !== username || saved.product !== product) {
        throw new Error('WEALTH_REJECTION_RESUME_REQUIRED: 已有其他用户或产品的拒绝流程进入当前 Run，必须先续办原认购。');
      }
      active = saved;
    }
  }

  const runId = active?.runId ?? `WS002-MENU12-${now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
  const amount = active?.amount ?? rejectionAmount(runId);
  mkdirSync(dirname(pointerPath), { recursive: true });
  writeFileSync(pointerPath, `${JSON.stringify({ runId, username, product, amount }, null, 2)}\n`, 'utf8');
  return {
    WEALTH_RUN_ID: runId,
    WEALTH_TEST_USERNAME: username,
    WEALTH_AUTHORIZED_PRODUCT: product,
    WEALTH_AUTHORIZED_AMOUNT: amount,
    WEALTH_AUTHORIZED_ACTION: 'reject',
    WEALTH_RESUME: active ? 'true' : 'false'
  };
}

export function launcherWealthSubscriptionEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const username = environment.CLIENT_USERNAME?.trim() ?? '';
  if (!isValidEmail(username)) {
    throw new Error('WEALTH_TEST_USERNAME_REQUIRED: 请在 CLIENT_USERNAME 配置合法的测试用户邮箱。');
  }
  const amount = environment.WEALTH_MENU_SUBSCRIPTION_AMOUNT?.trim() || '1.43';
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
    throw new Error('WEALTH_MENU_SUBSCRIPTION_AMOUNT_INVALID: 菜单认购金额必须是正数且最多两位小数。');
  }

  const configuredRunId = environment.WEALTH_RUN_ID?.trim();
  const active = configuredRunId
    ? { runId: configuredRunId, resume: Boolean(readState(configuredRunId)) }
    : currentRun();
  const runId = active?.runId ?? newRunId();
  mkdirSync(dirname(pointerPath), { recursive: true });
  writeFileSync(pointerPath, `${JSON.stringify({ runId }, null, 2)}\n`, 'utf8');

  return {
    WEALTH_RUN_ID: runId,
    WEALTH_TEST_USERNAME: username,
    WEALTH_AUTHORIZED_AMOUNT: amount,
    WEALTH_RESUME: active?.resume ? 'true' : 'false'
  };
}

type WealthRedemptionPointer = WealthLauncherPointer & { identityHash: string };

export function launcherWealthRedemptionEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  rootDirectory = resolve('.')
): Record<string, string> {
  const username = environment.WEALTH_REDEEM_USERNAME?.trim().toLowerCase() ?? '';
  if (!isValidEmail(username)) {
    throw new Error('WEALTH_REDEEM_USER_REQUIRED: 请输入合法的测试用户邮箱。');
  }
  const identityHash = createHash('sha256').update(username).digest('hex');
  const pointer = resolve(rootDirectory, '.flow-state', 'launcher', 'wealth-redeem.json');
  let active: { runId: string; resume: boolean } | undefined;
  if (existsSync(pointer)) {
    const saved = JSON.parse(readFileSync(pointer, 'utf8')) as WealthRedemptionPointer;
    const statePath = resolve(rootDirectory, '.flow-state', 'wealth-redemption', `${saved.runId}.json`);
    const evidencePath = resolve(rootDirectory, '.flow-state', 'wealth-redemption', `${saved.runId}.evidence`);
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) as WealthRunState : undefined;
    const evidence = existsSync(evidencePath)
      ? JSON.parse(readFileSync(evidencePath, 'utf8')) as { identityHash?: string }
      : undefined;
    if (state?.stage !== 'COMPLETED' && saved.identityHash === identityHash && evidence?.identityHash === identityHash) {
      active = { runId: saved.runId, resume: true };
    } else if (state?.stage && state.stage !== 'PREPARED' && state.stage !== 'COMPLETED') {
      throw new Error('WEALTH_REDEMPTION_RESUME_REQUIRED: 已有其他用户的赎回进入提交边界，必须先续办原订单。');
    }
  }

  const runId = active?.runId ?? `WR003-MENU11-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
  mkdirSync(dirname(pointer), { recursive: true });
  writeFileSync(pointer, `${JSON.stringify({ runId, identityHash }, null, 2)}\n`, 'utf8');
  return {
    WEALTH_REDEEM_RUN_ID: runId,
    WEALTH_REDEEM_USERNAME: username,
    WEALTH_REDEEM_RESUME: active?.resume ? 'true' : 'false'
  };
}
