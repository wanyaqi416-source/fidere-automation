import { test, expect } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { MoneyMutationGuard, assertSandboxEnvironment } from '../../../src/flow-engine/mutation-guard';
import { FlowStateStore, advanceFlowState } from '../../../src/flow-engine/resume-state';
import { openOriginalU2uReview, readOriginalU2uApproval } from '../../../src/user-transfer/u2u-admin-review';
import { loadU2uEvidence, saveU2uEvidence, participantHash, U2U_FLOW_ID } from '../../../src/user-transfer/u2u-evidence';
import { loginU2uParticipant } from '../../../src/user-transfer/u2u-participant';
import { formatU2uBalance } from '../../../src/user-transfer/u2u-summary';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('U2U-002 Resume 原用户转账审核提交成功', { tag: ['@mutation', '@money', '@u2u', '@e2e'] }, async ({ adminPage, browser, business }, testInfo) => {
  test.setTimeout(300_000);
  business.flow('user-to-user-transfer-approve-resume');
  business.disallowSafeRerun();
  expect(env.allowClientMutationTests, 'Resume must not enable another Client submission').toBe(false);
  const switches = { ALLOW_MONEY_TESTS: env.exchange.allowMoneyTests, ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests };
  const guard = new MoneyMutationGuard(U2U_FLOW_ID, true, false);
  guard.validateRuntime({ baseURL: env.admin.baseUrl, workers: testInfo.config.workers,
    retries: testInfo.project.retries, repeatEach: testInfo.project.repeatEach, safetySwitches: switches });
  assertSandboxEnvironment(env.client.baseUrl);
  const runId = process.env.U2U_RUN_ID!;
  const recipient = process.env.U2U_RECIPIENT_EMAIL!;
  const evidence = loadU2uEvidence(runId);
  expect(evidence.senderHash === participantHash(env.client.username!), 'Original Sender unchanged').toBe(true);
  expect(evidence.recipientHash === participantHash(recipient), 'Original Recipient unchanged').toBe(true);
  const store = new FlowStateStore();
  let state = store.load(U2U_FLOW_ID, runId);
  if (!state || state.stage !== 'ADMIN_LOCATED' || !state.clientReference || state.clientReference !== evidence.orderId ||
      state.adminReference !== evidence.senderLedgerId || evidence.adminApprovalClicks) {
    throw new Error('Only the original ADMIN_LOCATED order without a prior approval attempt may be approved; never resubmit.');
  }
  business.setResumeState(state.stage);
  business.setBusinessData({ runId, transferOrderId: evidence.orderId, adminTransactionId: evidence.senderLedgerId,
    transferAmount: evidence.amount, transferCurrency: evidence.currency, fee: evidence.fee,
    expectedReceivedAmount: evidence.expectedCredit, sourceAccountType: evidence.sourceAccountType,
    targetAccountType: evidence.targetAccountType, sourceBalanceBefore: formatU2uBalance(evidence.senderBefore),
    targetBalanceBefore: formatU2uBalance(evidence.recipientBefore), confirmationClicks: 0,
    securityVerificationClicks: 0, createdOrderCount: 0, adminMutationClicks: 0 });
  await business.step({ action: '原发送方干净认证预检', expected: '原发送方身份和KYC正常；不创建任何新转账' }, async ({ setActual }) => {
    const participant = await loginU2uParticipant(browser, env.client.baseUrl!, env.client.username!);
    await participant.context.close();
    setActual('Sender干净登录成功，原身份不变；收款方通过原订单详情核对，无需登录收款方。');
  });
  let original: Awaited<ReturnType<typeof openOriginalU2uReview>>;
  await business.step({ action: '原TXN唯一定位并打开审核详情', expected: 'Admin认证有效，candidateCount=1，双方、香港账户USD、金额、手续费、到账和待审核状态匹配' }, async ({ setActual }) => {
    original = await openOriginalU2uReview({ page: adminPage, baseURL: env.admin.baseUrl!, sender: env.client.username!, recipient, evidence, business });
    guard.markAuthenticationReady(true, true);
    guard.recordClientSubmission(); // Restore original persisted creation evidence, not a new submission.
    guard.recordUniqueAdminCandidate(1);
    setActual('candidateCount=1；原Client/Admin TXN一致；详情二次核对全部通过。');
    business.recordPrimaryOracle({ id: 'admin-candidate', name: '唯一原订单及详情', status: 'passed', expected: 'candidateCount=1且详情一致', actual: '全部匹配' });
  });
  await business.step({ action: '填写审核备注并批准原订单一次', expected: '复用现有审批表单；批准最多一次；读取真实Admin已批准状态' }, async ({ setActual }) => {
    const { review, list } = original!;
    const remark = `AUTO_U2U_APPROVE_${runId}`;
    await review.fillRemark(remark);
    expect(await review.readRemarkValue()).toBe(remark);
    guard.assertAdminActionAllowed(switches);
    state = advanceFlowState(state!, 'FIDERE_APPROVAL_ATTEMPTED');
    store.save(state);
    business.setResumeState(state.stage);
    guard.recordAdminAction();
    business.markMutationPerformed('Admin批准原用户间转账');
    try {
      await review.confirmApproveOnce(switches.ALLOW_MONEY_TESTS, switches.ALLOW_ADMIN_MUTATION_TESTS);
    } catch (error) {
      if (!review.wasApproved()) throw error;
      business.recordDiagnostic({ id: 'approval-ui-result', name: '批准后UI提示', status: 'info',
        summary: '批准已尝试，不重复点击；只读查询原订单真实状态。', affectsCoreBusiness: false });
    } finally {
      evidence.adminApprovalClicks = review.approvalClickCount();
      evidence.adminConfirmationClicks = review.secondaryConfirmationClickCount();
      saveU2uEvidence(evidence);
      business.setBusinessData({ adminMutationClicks: evidence.adminApprovalClicks, approvalClicks: evidence.adminApprovalClicks });
    }
    try {
      const approved = await readOriginalU2uApproval(list, env.admin.baseUrl!, env.client.username!, evidence.senderLedgerId!);
      evidence.adminStatus = approved.status;
      saveU2uEvidence(evidence);
    } catch (error) {
      business.requireManualReview('Admin批准后原记录终态未确认；禁止再次批准，仅允许只读核查。');
      throw error;
    }
    state = advanceFlowState(state!, 'ADMIN_ACTION_DONE');
    store.save(state);
    business.setResumeState(state.stage);
    business.setBusinessData({ adminStatus: evidence.adminStatus });
    setActual(`批准${evidence.adminApprovalClicks}次；二次确认${evidence.adminConfirmationClicks}次；Admin原订单已批准。`);
    business.recordPrimaryOracle({ id: 'admin-approved', name: 'Admin批准原交易', status: 'passed', expected: '批准一次且真实状态已批准', actual: '原订单已批准' });
  });
  state = advanceFlowState(state!, 'COMPLETED');
  store.save(state);
  business.setResumeState(state.stage);
  business.setBusinessData({ finalStatus: '审核提交成功（Admin已批准）', confirmed: true, manualCheckRequired: false, createdOrderCount: 0 });
});
