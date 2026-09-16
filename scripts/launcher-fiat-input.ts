import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { FlowStateStore } from '../src/flow-engine/resume-state.js';
import { defaultFiatUserKey } from '../src/utils/default-fiat-user.js';

export function launcherFiatEnvironment(number: number, environment: Readonly<Record<string, string | undefined>>,
  store = new FlowStateStore()): Record<string, string> {
  if (number !== 4 && number !== 5) return {};
  const key = defaultFiatUserKey(environment.CLIENT_USERNAME ?? '');
  const prefix = `${number === 4 ? 'DP004' : 'WD'}-${key}-`;
  const flow = number === 4 ? 'deposit-rejection-journey' : 'personal-golden-journey-withdrawal';
  const pending = store.list(flow).filter(state => state.runId.startsWith(prefix) && state.stage !== 'COMPLETED');
  if (pending.length > 1) throw new Error('存在多个原资金 Run，必须先核对原订单，不能新增替代订单。');
  const runId = pending[0]?.runId ?? `${prefix}${Date.now()}-${randomUUID().slice(0, 8)}`;
  if (number === 4) return { DEPOSIT_REJECT_USE_DEFAULT_CLIENT: 'true', DEPOSIT_REJECT_RUN_ID: runId,
    DEPOSIT_REJECT_AUTHORIZED_RUN_ID: runId, DEPOSIT_REJECT_SOURCE_RUN_ID: key,
    DEPOSIT_REJECT_RESUME: String(existsSync(`${store.pathFor(flow, runId)}.submit`)) };
  return { WITHDRAWAL_USE_DEFAULT_CLIENT: 'true', WITHDRAWAL_RUN_ID: runId, WITHDRAWAL_AUTHORIZED_RUN_ID: runId };
}
