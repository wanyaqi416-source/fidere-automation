import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { isValidEmail } from '../src/utils/runtime-email.js';

type ManualDepositPointer = { runId: string; email: string; amount: string };
type ManualDepositState = { stage?: string; submissionClicks?: number; finalConfirmationClicks?: number };

export function launcherManualDepositEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  rootDirectory = resolve('.'),
  now = new Date()
): Record<string, string> {
  const email = environment.MANUAL_DEPOSIT_USER_EMAIL?.trim().toLowerCase() ?? '';
  if (!isValidEmail(email)) throw new Error('MANUAL_DEPOSIT_USER_REQUIRED: 请输入合法的测试用户邮箱。');

  const pointerPath = resolve(rootDirectory, '.flow-state', 'launcher', 'admin-manual-deposit.json');
  let active: ManualDepositPointer | undefined;
  if (existsSync(pointerPath)) {
    const saved = JSON.parse(readFileSync(pointerPath, 'utf8')) as ManualDepositPointer;
    const statePath = resolve(rootDirectory, '.journey-context', 'fresh-user', 'bootstrap', `${saved.runId}.json`);
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) as ManualDepositState : undefined;
    if (state?.stage === 'PREPARED' && saved.email === email) {
      active = saved;
    } else if (state && state.stage !== 'PREPARED' && state.stage !== 'BOOTSTRAP_COMPLETED') {
      throw new Error('MANUAL_DEPOSIT_RECONCILIATION_REQUIRED: 原手动入金已尝试提交，结果明确前禁止创建第二笔。');
    }
  }

  const runId = active?.runId ?? `ADMIN-MD-MENU18-${now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
  const configuredAmount = environment.MANUAL_DEPOSIT_MENU_AMOUNT?.trim() || undefined;
  const amount = active?.amount ?? configuredAmount ?? '200.00';
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
    throw new Error('MANUAL_DEPOSIT_AMOUNT_INVALID: 手动入金金额必须为正数且最多两位小数。');
  }
  mkdirSync(dirname(pointerPath), { recursive: true });
  writeFileSync(pointerPath, `${JSON.stringify({ runId, email, amount }, null, 2)}\n`, 'utf8');
  return {
    CLIENT_USERNAME: email,
    MANUAL_DEPOSIT_USER_EMAIL: email,
    MANUAL_DEPOSIT_RUN_ID: runId,
    MANUAL_DEPOSIT_AUTHORIZED_AMOUNT: amount,
    MANUAL_DEPOSIT_RESUME_CONFIRMATION: 'false'
  };
}
