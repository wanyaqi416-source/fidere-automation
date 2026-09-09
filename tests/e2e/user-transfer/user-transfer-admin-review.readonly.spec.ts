import { test, expect } from '../../../fixtures/workflow.fixture';
import { openOriginalU2uReview } from '../../../src/user-transfer/u2u-admin-review';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment } from '../../../src/flow-engine/mutation-guard';
import { FlowStateStore, advanceFlowState } from '../../../src/flow-engine/resume-state';
import { loadU2uEvidence, participantHash, U2U_FLOW_ID } from '../../../src/user-transfer/u2u-evidence';
import { loginU2uParticipant, readU2uBalance } from '../../../src/user-transfer/u2u-participant';
import { formatU2uBalance } from '../../../src/user-transfer/u2u-summary';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('U2U-004 原用户转账Admin审核入口只读核对', { tag: ['@readonly', '@u2u', '@e2e'] }, async ({ adminPage, browser, business }) => {
  test.setTimeout(180_000);
  business.flow('user-to-user-transfer-admin-review');
  expect(env.allowAdminMutationTests).toBe(false);
  expect(env.allowClientMutationTests).toBe(false);
  expect(env.exchange.allowMoneyTests).toBe(false);
  assertSandboxEnvironment(env.admin.baseUrl);
  assertSandboxEnvironment(env.client.baseUrl);
  const runId = process.env.U2U_RUN_ID!;
  const recipient = process.env.U2U_RECIPIENT_EMAIL!;
  const evidence = loadU2uEvidence(runId);
  expect(evidence.senderHash === participantHash(env.client.username!), 'Original Sender unchanged').toBe(true);
  expect(evidence.recipientHash === participantHash(recipient), 'Original Recipient unchanged').toBe(true);
  const store = new FlowStateStore();
  const state = store.load(U2U_FLOW_ID, runId);
  if (!state?.clientReference || state.clientReference !== evidence.orderId) throw new Error('Original U2U TRF evidence is required; never create a second transfer.');
  if (!evidence.senderLedgerId) throw new Error('Read the actual Client TXN from the original TRF detail before opening Admin review.');
  business.disallowSafeRerun();
  business.setBusinessData({ runId, transferOrderId: state.clientReference, transferAmount: evidence.amount,
    transferCurrency: evidence.currency, fee: evidence.fee, expectedReceivedAmount: evidence.expectedCredit,
    sourceBalanceBefore: formatU2uBalance(evidence.senderBefore), targetBalanceBefore: formatU2uBalance(evidence.recipientBefore),
    confirmationClicks: 0, securityVerificationClicks: 0, adminMutationClicks: 0, createdOrderCount: 0 });
  await business.step({ action: 'Admin原TXN唯一定位并核对审核详情', expected: '双方、方向、金额、费用、到账和时间匹配；只打开审核入口，不批准、不拒绝' }, async ({ setActual }) => {
    const { review, detail } = await openOriginalU2uReview({ page: adminPage, baseURL: env.admin.baseUrl!, sender: env.client.username!, recipient, evidence, business });
    expect(review.approvalClickCount()).toBe(0);
    if (state.stage === 'CLIENT_CREATED') store.save(advanceFlowState(state, 'ADMIN_LOCATED', { adminReference: detail.adminTransactionId }));
    business.setResumeState('ADMIN_LOCATED');
    setActual('candidateCount=1；原Client/Admin TXN一致，详情全部匹配；批准0次、拒绝0次。');
  });
  await business.step({ action: '只读记录审核前收款方余额', expected: '待审核不等于到账；不要求待审核记录已完成' }, async ({ setActual }) => {
    const receiver = await loginU2uParticipant(browser, env.client.baseUrl!, recipient);
    try {
      const current = await readU2uBalance(receiver.page, env.client.baseUrl!, evidence.targetAccountType, evidence.currency);
      business.setBusinessData({ targetBalanceAfter: formatU2uBalance(current), finalStatus: '待审核', confirmed: false, manualCheckRequired: false });
      setActual(`收款方当前余额=${formatU2uBalance(current)} ${evidence.currency}；基线=${formatU2uBalance(evidence.recipientBefore)}。业务处于确定的待审核状态，不是未知资金结果。`);
    } finally { await receiver.context.close(); }
  });
});
