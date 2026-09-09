import { resolve } from 'node:path';
import { test, expect } from '../../../fixtures/registration.fixture';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { BrokerOpeningReviewPage } from '../../../pages/admin/BrokerOpeningReviewPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { SecuritiesTradingPage } from '../../../pages/client/SecuritiesTradingPage';
import { env } from '../../../src/config/env';
import { advanceFlowState, assertSandboxEnvironment, FlowStateStore, requireExactlyOneCandidate } from '../../../src/flow-engine';
import { PersonalPostRegistrationJourneyStore } from '../../../src/journey';
import { matchTigerOpening } from '../../../src/journey/tiger-opening';
import { openPersonalJourneyClientSession } from '../../../src/registration';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('原老虎申请状态与最终确认表单只读复核 @readonly @L2', async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(120_000);
  assertSandboxEnvironment(env.client.baseUrl); assertSandboxEnvironment(env.admin.baseUrl);
  expect(env.exchange.allowMoneyTests || env.allowAdminMutationTests).toBe(false);
  const sourceRunId = process.env.BROKER_SOURCE_RUN_ID;
  const runId = process.env.BROKER_OPENING_RUN_ID;
  if (!sourceRunId || !runId || !/^[A-Z0-9._-]+$/i.test(sourceRunId)) throw new Error('Original broker Journey and Run required.');
  const source = new PersonalPostRegistrationJourneyStore(sourceRunId).load();
  const store = new FlowStateStore(resolve('.flow-state', 'broker-journeys', sourceRunId));
  let state = store.load('tiger-broker-opening', runId);
  if (!source || !state?.adminReference) throw new Error('Existing original broker application required.');
  business.flow('tiger-broker-opening', { name: '原老虎申请只读复核（不提交或审核）' });
  business.disallowSafeRerun();
  const shell = new AdminShellPage(adminPage);
  await shell.goto(env.admin.baseUrl!); await shell.expectSessionActive();
  const admin = new BrokerOpeningReviewPage(adminPage);
  await admin.goto(env.admin.baseUrl!); await admin.searchEmail(source.email);
  const matched = matchTigerOpening(await admin.collectRows(), { ...source, reference: state.adminReference });
  const candidate = requireExactlyOneCandidate(matched.candidates, 'Original Tiger');
  await admin.verifyDetail(candidate, source);
  business.setBusinessData({ runId, sourceRunId, registrationTestName: source.displayName, candidateCount: 1, adminReference: state.adminReference,
    candidateStages: JSON.stringify(matched.stages), openingFeeAmount: state.amount, finalStatus: candidate.status, confirmationClicks: 0, approvalClicks: 0 });
  console.log('TIGER_RECON_ADMIN ' + JSON.stringify({ reference: candidate.reference, status: candidate.status, candidateCount: 1, detailMatched: true }));
  if (candidate.status === '待处理') {
    await admin.fillApprovalForm(candidate, `AUTO_TIGER_APPROVE_${runId}`);
    let adminWrites = 0;
    const observe = (request: import('@playwright/test').Request) => {
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) adminWrites++;
    };
    adminPage.on('request', observe);
    await admin.openApprovalConfirmationOnce();
    const fields = await admin.readApprovalConfirmationFields();
    console.log('TIGER_FINAL_CONFIRMATION_FIELDS ' + JSON.stringify({ fields, finalApproveClicks: admin.approvalClickCount(), adminWrites }));
    expect(adminWrites).toBe(0);
    adminPage.off('request', observe);
    // Correct only the legacy form-open boundary; never downgrade an actual final submission.
    if (state.stage === 'FIDERE_APPROVAL_ATTEMPTED') {
      state = advanceFlowState(state, 'ADMIN_APPROVAL_CONFIRMATION_REQUIRED'); store.save(state);
    }
    business.recordDiagnostic({ id: 'tiger-final-approval-required', name: '待填写最终开户信息', status: 'info',
      summary: '保存处理结果仅打开确认框；实际确认通过0次。需提供Sandbox券商账户号码、账户名称、开户时间；当前为待处理，不是审批失败或未知扣款。', affectsCoreBusiness: false });
    testInfo.annotations.push({ type: 'blocker', description: 'BLOCKED_TEST_DATA: Sandbox券商账户号码与开户时间待提供；原申请已创建，最终审核未提交。' });
  }
  const client = await openPersonalJourneyClientSession({ browser, baseURL: env.client.baseUrl!, runId: sourceRunId,
    email: source.email, password: env.client.password!, otp: env.client.otp!, forceFreshLogin: true });
  try {
    const accounts = new AccountDetailPage(client.page);
    await accounts.goto(env.client.baseUrl!);
    const balance = await accounts.readSnapshot('香港账户', 'USD');
    const securities = new SecuritiesTradingPage(client.page);
    await securities.goto(env.client.baseUrl!);
    const tiger = (await securities.readBrokerCards()).filter(card => card.name === '老虎证券');
    console.log('TIGER_RECON_CLIENT ' + JSON.stringify({ balance, tiger }));
    console.log('TIGER_CLIENT_STATUS_DOM ' + await securities.readSafeState());
    business.setBusinessData({ afterApprovedAvailableBalance: balance.available, finalStatus: `Admin=${candidate.status}; Client=${tiger.map(card => card.status).join(',')}`, resumeStage: state.stage });
    business.setResumeState(state.stage);
  } finally { await client.context.close(); }
});
