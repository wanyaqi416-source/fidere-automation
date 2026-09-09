import { test, expect } from '../../../fixtures/workflow.fixture';
import { TransferListPage } from '../../../pages/admin/TransferListPage';
import { readOriginalU2uApproval } from '../../../src/user-transfer/u2u-admin-review';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment } from '../../../src/flow-engine/mutation-guard';
import { FlowStateStore, advanceFlowState, stageIndex } from '../../../src/flow-engine/resume-state';
import { loadU2uEvidence, saveU2uEvidence, participantHash, U2U_FLOW_ID } from '../../../src/user-transfer/u2u-evidence';
import { matchesAdminCustomerIdentity } from '../../../src/transfer/transfer-e2e';
import { Decimal } from '../../../src/utils/money';
import { formatU2uBalance } from '../../../src/user-transfer/u2u-summary';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('U2U-005 原订单审核提交结果只读核查', { tag: ['@readonly', '@reconciliation', '@u2u', '@e2e'] }, async ({ adminPage, business }) => {
  test.setTimeout(240_000);
  business.flow('user-to-user-transfer-settlement');
  expect(env.allowAdminMutationTests).toBe(false);
  expect(env.allowClientMutationTests).toBe(false);
  expect(env.exchange.allowMoneyTests).toBe(false);
  assertSandboxEnvironment(env.admin.baseUrl);
  assertSandboxEnvironment(env.client.baseUrl);
  const runId = process.env.U2U_RUN_ID!;
  const recipient = process.env.U2U_RECIPIENT_EMAIL!;
  const evidence = loadU2uEvidence(runId);
  expect(evidence.senderHash === participantHash(env.client.username!), 'Original Sender').toBe(true);
  expect(evidence.recipientHash === participantHash(recipient), 'Original Recipient').toBe(true);
  const store = new FlowStateStore();
  let state = store.load(U2U_FLOW_ID, runId);
  if (!state || !evidence.senderLedgerId || state.clientReference !== evidence.orderId ||
    stageIndex(state.stage) < stageIndex('FIDERE_APPROVAL_ATTEMPTED')) throw new Error('Original approval attempt is required; this test cannot submit or approve.');
  business.disallowSafeRerun();
  business.setResumeState(state.stage);
  business.setBusinessData({ runId, transferOrderId: evidence.orderId, adminTransactionId: evidence.senderLedgerId,
    transferAmount: evidence.amount, transferCurrency: evidence.currency, fee: evidence.fee,
    expectedReceivedAmount: evidence.expectedCredit, sourceBalanceBefore: formatU2uBalance(evidence.senderBefore),
    targetBalanceBefore: formatU2uBalance(evidence.recipientBefore), adminMutationClicks: 0, createdOrderCount: 0,
    confirmationClicks: 0, securityVerificationClicks: 0 });
  await business.step({ action: '只读查询已点击批准的原TXN', expected: '原TXN唯一，双方、方向、USD、金额、费用、到账匹配，Admin状态已批准；不点击任何审核动作' }, async ({ setActual }) => {
    const list = new TransferListPage(adminPage);
    const record = await readOriginalU2uApproval(list, env.admin.baseUrl!, env.client.username!, evidence.senderLedgerId!);
    business.setBusinessData({ candidateCount: 1 });
    expect(record!.recordType).toBe('用户间互转');
    expect(matchesAdminCustomerIdentity(record!.userIdentity, env.client.username!)).toBe(true);
    expect(matchesAdminCustomerIdentity(record!.recipientIdentity ?? '', recipient)).toBe(true);
    expect(record!.sourceAccountType).toBe(evidence.sourceAccountType);
    expect(record!.targetAccountType).toBe(evidence.targetAccountType);
    expect(record!.currency).toBe(evidence.currency);
    expect(new Decimal(record!.requestedAmount).eq(evidence.amount)).toBe(true);
    expect(new Decimal(record!.feeAmount).eq(evidence.fee)).toBe(true);
    expect(new Decimal(record!.netAmount).eq(evidence.expectedCredit)).toBe(true);
    evidence.adminStatus = record!.status;
    saveU2uEvidence(evidence);
    if (stageIndex(state!.stage) < stageIndex('ADMIN_ACTION_DONE')) {
      state = advanceFlowState(state!, 'ADMIN_ACTION_DONE'); store.save(state);
    }
    business.setResumeState(state!.stage);
    business.setBusinessData({ adminStatus: evidence.adminStatus });
    business.recordPrimaryOracle({ id: 'original-admin-approved', name: '原订单批准结果', status: 'passed', expected: '原TXN已批准', actual: '候选1，全部字段匹配，已批准' });
    setActual(`原TXN候选1；已批准；历史批准次数${evidence.adminApprovalClicks}，本次批准0次。`);
  });
  if (state!.stage !== 'COMPLETED') {
    state = advanceFlowState(state!, 'COMPLETED'); store.save(state);
  }
  business.setResumeState(state!.stage);
  business.setBusinessData({ finalStatus: '审核提交成功（Admin已批准）', confirmed: true, manualCheckRequired: false, createdOrderCount: 0 });
});
