import { randomUUID } from 'node:crypto';
import { FlowStateStore, type FlowResumeState } from '../src/flow-engine/resume-state.js';
import { existingU2uConfig, assertExistingU2uResume } from '../src/user-transfer/u2u-existing-contract.js';
import { assertU2uFreshAllowedForParticipants, loadU2uEvidence, unfinishedU2uForParticipants, U2U_FLOW_ID, type U2uEvidence } from '../src/user-transfer/u2u-evidence.js';

type Environment = Readonly<Record<string, string | undefined>>;
type History = { states: FlowResumeState[]; evidence(runId: string): U2uEvidence };

export async function collectLauncherU2u(
  prompt: { question(message: string): Promise<string> },
  environment: Environment,
  print: (message: string) => void = console.log,
  history: History = { states: new FlowStateStore().list(U2U_FLOW_ID), evidence: loadU2uEvidence }
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  const sender = environment.CLIENT_USERNAME?.trim() ?? '';
  const recipient = environment.U2U_RECIPIENT_EMAIL?.trim() || environment.U2U_DEFAULT_RECIPIENT_EMAIL?.trim() || '';
  const unfinished = unfinishedU2uForParticipants(history.states, sender, recipient, history.evidence);
  const explicitRun = environment.U2U_RUN_ID?.trim();
  if (!explicitRun && unfinished.length > 1) {
    throw new Error('存在多个未完成用户转账 Run，请指定原 U2U_RUN_ID 续办；未创建新转账。');
  }
  const original = explicitRun ? history.states.find(state => state.runId === explicitRun) : unfinished[0];
  if (original) {
    const evidence = history.evidence(original.runId);
    Object.assign(values, { U2U_RUN_ID: original.runId, U2U_SOURCE_ACCOUNT_TYPE: evidence.sourceAccountType,
      U2U_TARGET_ACCOUNT_TYPE: evidence.targetAccountType, U2U_CURRENCY: evidence.currency, U2U_TEST_AMOUNT: evidence.amount });
    assertExistingU2uResume(original, evidence, existingU2uConfig({ ...environment, ...values }));
    print('续办原订单，保留原账号、金额及单次操作记录。');
  } else {
    values.U2U_RUN_ID = explicitRun || `U2U-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    assertU2uFreshAllowedForParticipants(history.states, values.U2U_RUN_ID, sender, recipient, history.evidence);
    values.U2U_SOURCE_ACCOUNT_TYPE = '香港账户';
    values.U2U_TARGET_ACCOUNT_TYPE = '香港账户';
    values.U2U_CURRENCY = 'USD';
    values.U2U_TEST_AMOUNT = '50';
    existingU2uConfig({ ...environment, ...values });
  }
  print(`本次 Run：${values.U2U_RUN_ID}\n转出账户：${values.U2U_SOURCE_ACCOUNT_TYPE}\n收款账户：${values.U2U_TARGET_ACCOUNT_TYPE}\n转账金额：${values.U2U_TEST_AMOUNT} ${values.U2U_CURRENCY}`);
  print('执行范围：单笔转账 → Admin唯一定位并审核；审核提交成功即完成，不登录收款账号。');
  return values;
}
