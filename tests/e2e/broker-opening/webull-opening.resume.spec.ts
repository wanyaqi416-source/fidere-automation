import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '../../../fixtures/registration.fixture';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { BrokerOpeningReviewPage, type BrokerOpeningRow } from '../../../pages/admin/BrokerOpeningReviewPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { RegistrationKycStatusPage } from '../../../pages/client/RegistrationKycStatusPage';
import { SecuritiesTradingPage } from '../../../pages/client/SecuritiesTradingPage';
import { WebullOpeningPage } from '../../../pages/client/WebullOpeningPage';
import { env } from '../../../src/config/env';
import { advanceFlowState, FlowStateStore, MoneyMutationGuard, requireExactlyOneCandidate } from '../../../src/flow-engine';
import { PersonalPostRegistrationJourneyStore } from '../../../src/journey';
import { matchWebullOpening } from '../../../src/journey/tiger-opening';
import { assessWebullFunding, WEBULL_BROKER_NAME, WEBULL_DOCUMENTS } from '../../../src/journey/webull-opening';
import { openPersonalJourneyClientSession, maskRegistrationEmail } from '../../../src/registration';
import { maskSensitiveText } from '../../../src/reporting/sensitive-data-mask';
import { Decimal } from '../../../src/utils/money';
import { getClientSecurityKey } from '../../../src/utils/security-key';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });

test('OPEN-WEBULL-003 恢复原双文档并完成微牛开户审核 @money @mutation @L4', async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(300_000);
  const sourceRunId = process.env.BROKER_SOURCE_RUN_ID;
  const runId = process.env.BROKER_OPENING_RUN_ID;
  const brokerAccountNumber = process.env.BROKER_OPENING_ACCOUNT_NUMBER;
  const openingDate = process.env.BROKER_OPENING_DATE;
  if (!sourceRunId || !runId || !/^[A-Z0-9._-]+$/i.test(sourceRunId) || !/^[A-Z0-9._-]+$/i.test(runId)
    || !brokerAccountNumber || !openingDate) throw new Error('Original Journey, named Resume, Sandbox broker account number and opening date required.');
  const flowId = 'webull-broker-opening';
  const switches = { ALLOW_MONEY_TESTS: env.exchange.allowMoneyTests, ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests,
    ALLOW_CLIENT_MUTATION_TESTS: process.env.ALLOW_CLIENT_MUTATION_TESTS === 'true' };
  const guard = new MoneyMutationGuard(flowId, true, true);
  for (const baseURL of [env.client.baseUrl, env.admin.baseUrl]) guard.validateRuntime({ baseURL, workers: testInfo.config.workers,
    retries: testInfo.project.retries, repeatEach: testInfo.project.repeatEach, safetySwitches: switches });
  expect(testInfo.retry + testInfo.repeatEachIndex).toBe(0);
  getClientSecurityKey();
  const source = new PersonalPostRegistrationJourneyStore(sourceRunId).load();
  if (!source || source.stage !== 'COMPLETED') throw new Error('Existing completed Personal Journey required; no registration or funding.');
  const root = resolve('.flow-state', 'broker-journeys', sourceRunId);
  const store = new FlowStateStore(root);
  const loaded = store.load(flowId, runId);
  if (!loaded || !['PREPARED', 'DOCUMENT_SIGNED'].includes(loaded.stage)) throw new Error('This Resume starts before the first fee confirmation only; an existing money attempt requires read-only reconciliation.');
  let state = loaded;
  const attempts = resolve(root, flowId, runId);
  for (const file of ['fee-confirmation.attempt', 'security-verification.attempt', 'admin-approval.attempt']) {
    if (existsSync(resolve(attempts, file))) throw new Error('A final action was already attempted. No repeat fee or approval.');
  }
  for (const id of WEBULL_DOCUMENTS.map(document => document.id)) {
    const document = store.load(`webull-document-${id}`, runId);
    const prefix = id === 'w8ben' ? 'w8' : 'crs';
    if (!document?.clientReference || !existsSync(resolve(attempts, `${prefix}-complete.attempt`))
      || !existsSync(resolve(attempts, `${prefix}-final-sign.attempt`))) throw new Error('Original completed signing attempts required; this Resume cannot create or sign documents.');
  }
  const markAttempt = (action: string) => {
    mkdirSync(attempts, { recursive: true });
    writeFileSync(resolve(attempts, `${action}.attempt`), new Date().toISOString(), { flag: 'wx' });
  };
  business.flow(flowId);
  business.disallowSafeRerun();
  business.setResumeState(state.stage);
  business.setBusinessData({ runId, sourceRunId, registrationTestName: source.displayName, maskedLogin: maskRegistrationEmail(source.email),
    currency: 'USD', openingFeeAmount: state.amount, confirmationClicks: 0, securityVerificationClicks: 0, approvalClicks: 0 });
  const admin = new BrokerOpeningReviewPage(adminPage);
  await business.step({ action: '1. 原AH用户与Admin认证、已有申请检查', expected: '原用户不变，Admin业务页面可用，原用户没有微牛申请。' }, async step => {
    const shell = new AdminShellPage(adminPage);
    await shell.goto(env.admin.baseUrl!); await shell.expectSessionActive();
    await admin.goto(env.admin.baseUrl!); await admin.searchEmail(source.email);
    const matched = matchWebullOpening(await admin.collectRows(), source);
    expect(matched.candidates.length).toBe(0);
    step.setActual('Admin认证有效；邮箱、原用户和微牛组合查询，没有已有开户申请。');
    step.setBusinessData({ candidateStages: JSON.stringify(matched.stages), preSubmitAdminCandidateCount: 0 });
  });
  const client = await openPersonalJourneyClientSession({ browser, baseURL: env.client.baseUrl!, runId: sourceRunId,
    email: source.email, password: env.client.password!, otp: env.client.otp!, forceFreshLogin: true });
  client.page.setDefaultTimeout(20_000);
  const opening = new WebullOpeningPage(client.page);
  const accounts = new AccountDetailPage(client.page);
  const securities = new SecuritiesTradingPage(client.page);
  let beforeBalance = '';
  let candidate: BrokerOpeningRow | undefined;
  let adminStatus = '';
  try {
    await new RegistrationKycStatusPage(client.page).expectApproved({ ...source, runId: sourceRunId }, env.client.baseUrl!);
    guard.markAuthenticationReady(true, true);
    await business.step({ action: '2. 读取原香港USD余额和微牛费用', expected: '当前余额覆盖实际页面费用；本次不入金，不切换用户。' }, async step => {
      await accounts.goto(env.client.baseUrl!);
      const before = await accounts.readSnapshot('香港账户', 'USD');
      beforeBalance = before.available;
      const { fee } = await opening.open(env.client.baseUrl!);
      expect(assessWebullFunding({ available: beforeBalance, fee: fee.amount, currency: fee.currency }).status).toBe('BALANCE_READY');
      expect(new Decimal(fee.amount).equals(state.amount!)).toBe(true);
      step.setActual(`香港账户可用余额${beforeBalance} USD；页面费用${fee.amount} USD；余额足够。`);
      step.setBusinessData({ feeBalanceBefore: beforeBalance, openingFeeAmount: fee.amount, beforeAvailableBalance: before.available,
        beforeFrozenBalance: before.frozen, beforeTotalBalance: before.total });
      await opening.opening.continueWebullToDocuments();
    });
    for (const definition of WEBULL_DOCUMENTS) {
      await business.step({ action: `恢复原${definition.label}的已签署结果`, expected: '原生去签署入口返回signed=true并显示已完成；不绘制、不Complete、不Sign。' }, async step => {
        const result = await opening.restoreExistingSignedDocument(definition.id);
        const original = store.load(`webull-document-${definition.id}`, runId)!;
        if (original.stage !== 'DOCUMENT_SIGNED') store.save(advanceFlowState(original, 'DOCUMENT_SIGNED'));
        step.setActual(`${definition.label}：服务端signed=true，Fidere确认完成；本次Complete=0、Sign=0。`);
        step.setBusinessData({ safeRequestEvidence: JSON.stringify(result) });
        step.recordPrimaryOracle({ id: `webull-${definition.id}-restored`, name: `${definition.label}原签署已确认`,
          expected: '真实服务端签署完成和Fidere回写', actual: '已确认；未重复签名', status: 'passed' });
      });
    }
    if (state.stage !== 'DOCUMENT_SIGNED') { state = advanceFlowState(state, 'DOCUMENT_SIGNED'); store.save(state); }
    await business.step({ action: '5. 双文档确认页与一次安全验证', expected: '文档已签署；最终提交和SecurityKey各一次，不以HTTP状态码判业务创建。' }, async step => {
      await opening.prepareReview();
      guard.assertClientMoneyConfirmationAllowed(switches);
      markAttempt('fee-confirmation');
      state = advanceFlowState(state, 'FEE_CONFIRMATION_ATTEMPTED'); store.save(state);
      guard.recordClientMoneyConfirmation();
      await opening.confirmSubmissionOnce();
      await opening.opening.securityKey.waitForOpen();
      await opening.opening.securityKey.fill(getClientSecurityKey());
      guard.assertSecurityKeyVerificationAllowed(switches);
      markAttempt('security-verification');
      state = advanceFlowState(state, 'SECURITY_KEY_VERIFICATION_ATTEMPTED', { clientSubmittedAt: new Date().toISOString() }); store.save(state);
      step.markPotentiallySubmitted();
      guard.recordSecurityKeyVerification();
      await opening.opening.securityKey.verifyOnce();
      step.setActual('Client提交入口1次；Security Key Verification: Passed；接下来只查询真实申请，不会再次提交。');
    });
    const submittedTo = new Date().toISOString();
    await business.step({ action: '6. 唯一定位本次真实微牛申请', expected: '邮箱、姓名、券商、个人账户、时间窗口匹配，保存实际申请引用。' }, async step => {
      await expect.poll(async () => {
        await admin.goto(env.admin.baseUrl!); await admin.searchEmail(source.email);
        const matched = matchWebullOpening(await admin.collectRows(), { ...source, submittedFrom: state.clientSubmittedAt, submittedTo });
        step.setBusinessData({ candidateStages: JSON.stringify(matched.stages), candidateCount: matched.candidates.length });
        console.log('WEBULL_CANDIDATES ' + JSON.stringify(matched.stages));
        if (matched.candidates.length > 1) throw new Error('Multiple Webull candidates; no approval permitted.');
        if (matched.candidates.length === 1) candidate = requireExactlyOneCandidate(matched.candidates, 'Webull original application');
        return matched.candidates.length;
      }, { timeout: 45_000, intervals: [1000, 2000, 5000] }).toBe(1);
      if (!candidate?.reference) throw new Error('BROKER_SUBMISSION_UNCONFIRMED; no new fee or application permitted.');
      expect(candidate.status).toBe('待处理');
      guard.assertClientSubmissionAllowed(switches); guard.recordClientSubmission();
      state = advanceFlowState(state, 'CLIENT_CREATED', { clientReference: candidate.reference, adminReference: candidate.reference }); store.save(state);
      guard.recordUniqueAdminCandidate(1);
      state = advanceFlowState(state, 'ADMIN_LOCATED'); store.save(state);
      business.markMutationPerformed('Client微牛开户申请已确认');
      step.setActual('本次申请已真实存在；候选唯一，已固定原申请引用。');
      step.setBusinessData({ candidateCount: 1, adminReference: candidate.reference, createdOrderCount: 1 });
    });
    await business.step({ action: '7. 原微牛申请详情核对和Admin通过', expected: '使用同一券商审批组件，填写Sandbox开户资料，最终通过只一次。' }, async step => {
      if (!candidate) throw new Error('No unique Webull candidate.');
      await admin.verifyDetail(candidate, source, 'WEBULL');
      await admin.fillApprovalForm(candidate, `AUTO_WEBULL_APPROVE_${runId}`);
      await admin.openApprovalConfirmationOnce();
      state = advanceFlowState(state, 'ADMIN_APPROVAL_CONFIRMATION_REQUIRED'); store.save(state);
      await admin.fillApprovalConfirmation({ accountName: source.displayName, accountNumber: brokerAccountNumber, openingDate });
      guard.assertAdminActionAllowed(switches); markAttempt('admin-approval');
      state = advanceFlowState(state, 'ADMIN_APPROVAL_SUBMISSION_ATTEMPTED'); store.save(state);
      guard.recordAdminAction(); await admin.approveOnce();
      await expect.poll(async () => {
        await admin.goto(env.admin.baseUrl!); await admin.searchEmail(source.email);
        const matched = matchWebullOpening(await admin.collectRows(), { ...source, reference: candidate!.reference });
        if (matched.candidates.length !== 1) return '';
        adminStatus = requireExactlyOneCandidate(matched.candidates, 'Approved original Webull').status;
        return adminStatus;
      }, { timeout: 45_000, intervals: [1000, 2000, 5000] }).toMatch(/^(已开户|审核通过|已通过|已批准)$/);
      state = advanceFlowState(state, 'ADMIN_ACTION_DONE'); store.save(state);
      business.markMutationPerformed('Admin微牛开户审核通过');
      step.setActual(`原申请Admin状态=${adminStatus}；最终确认通过1次。`);
    });
    await business.step({ action: '8. Client原微牛账户最终状态', expected: '同一用户、同一微牛申请已开通，没有重复扣费或申请。' }, async step => {
      let clientStatus = '';
      await expect.poll(async () => {
        await securities.goto(env.client.baseUrl!);
        clientStatus = await securities.readBrokerStatus(WEBULL_BROKER_NAME);
        return clientStatus;
      }, { timeout: 45_000, intervals: [1000, 2000, 5000] }).toMatch(/^(已开通|已开户)$/);
      state = advanceFlowState(state, 'CLIENT_FINALIZED'); store.save(state);
      state = advanceFlowState(state, 'COMPLETED'); store.save(state);
      step.recordPrimaryOracle({ id: 'webull-opening-completed', name: '微牛开户审核闭环', expected: '原双文档完成、单次创建、候选唯一、Admin通过、Client已开通',
        actual: `Admin=${adminStatus}；Client=${clientStatus}`, status: 'passed' });
      step.setActual(`原微牛账户${clientStatus}；未入金，未重复签署，未创建第二条申请。`);
      step.setBusinessData({ confirmed: true, finalStatus: clientStatus });
    });
    try {
      await accounts.goto(env.client.baseUrl!);
      const after = await accounts.readSnapshot('香港账户', 'USD');
      const debit = new Decimal(beforeBalance).minus(after.available).toFixed(2);
      business.setBusinessData({ feeBalanceAfter: after.available, observedFeeDebit: debit });
      business.recordDiagnostic({ id: 'webull-fee-observation', name: '实际开户费余额', status: 'available',
        summary: `香港USD ${beforeBalance} -> ${after.available}；实际减少${debit}，页面费用${state.amount}。`, affectsCoreBusiness: false });
    } catch (error) {
      business.recordDiagnostic({ id: 'webull-fee-observation', name: '实际开户费余额', status: 'unavailable',
        summary: '原申请和双端已开户状态已确认。', reason: maskSensitiveText(String(error)), affectsCoreBusiness: false });
    }
  } catch (error) {
    if (['SECURITY_KEY_VERIFICATION_ATTEMPTED', 'ADMIN_APPROVAL_SUBMISSION_ATTEMPTED'].includes(state.stage)) {
      business.requireManualReview('只查询原微牛申请、状态和余额；禁止重复安全验证或审批。');
    }
    console.log('WEBULL_RESUME_STOP ' + JSON.stringify({ stage: state.stage, reference: state.adminReference,
      confirmationClicks: opening.confirmationClickCount(), securityClicks: opening.opening.securityKey.verificationClickCount(), adminClicks: admin.approvalClickCount() }));
    throw error;
  } finally {
    business.setResumeState(state.stage);
    business.setBusinessData({ confirmationClicks: opening.confirmationClickCount(), securityVerificationClicks: opening.opening.securityKey.verificationClickCount(),
      approvalClicks: admin.approvalClickCount(), adminReference: state.adminReference });
    await client.context.close();
  }
});
