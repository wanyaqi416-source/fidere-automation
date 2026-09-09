import { resolve } from 'node:path';
import type { Response } from '@playwright/test';
import { test, expect } from '../../../fixtures/registration.fixture';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { BrokerOpeningReviewPage, type BrokerOpeningRow } from '../../../pages/admin/BrokerOpeningReviewPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { BrokerOpeningPage } from '../../../pages/client/BrokerOpeningPage';
import { SecuritiesTradingPage } from '../../../pages/client/SecuritiesTradingPage';
import { RegistrationKycStatusPage } from '../../../pages/client/RegistrationKycStatusPage';
import { env } from '../../../src/config/env';
import { advanceFlowState, createPreparedFlowState, FlowStateStore, MoneyMutationGuard, requireExactlyOneCandidate } from '../../../src/flow-engine';
import { PersonalPostRegistrationJourneyStore } from '../../../src/journey';
import { matchTigerOpening } from '../../../src/journey/tiger-opening';
import { openPersonalJourneyClientSession, maskRegistrationEmail } from '../../../src/registration';
import { maskSensitiveText } from '../../../src/reporting/sensitive-data-mask';
import { Decimal } from '../../../src/utils/money';
import { getClientSecurityKey } from '../../../src/utils/security-key';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });
test('OPEN-TIGER-003 原Journey老虎证券开户与审核 @money @mutation @L4', async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(240_000);
  const sourceRunId = process.env.BROKER_SOURCE_RUN_ID;
  const runId = process.env.BROKER_OPENING_RUN_ID;
  const authorizedFee = process.env.BROKER_AUTHORIZED_FEE;
  const resumeAdmin = process.env.BROKER_OPENING_MODE === 'resume-admin';
  const brokerAccountNumber = process.env.BROKER_OPENING_ACCOUNT_NUMBER;
  const openingDate = process.env.BROKER_OPENING_DATE;
  if (!brokerAccountNumber || !openingDate) throw new Error('BLOCKED_TEST_DATA: Admin final approval requires an explicitly supplied Sandbox broker account number and opening date. No new Client application is permitted without these prerequisites.');
  if (!sourceRunId || !runId || !authorizedFee || !/^[A-Z0-9._-]+$/i.test(sourceRunId)) throw new Error('Original Journey, named Tiger Run and authorized fee are required.');
  const flowId = 'tiger-broker-opening';
  const guard = new MoneyMutationGuard(flowId, true, true);
  const switches: Record<string, boolean> = resumeAdmin
    ? { ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests }
    : { ALLOW_MONEY_TESTS: env.exchange.allowMoneyTests, ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests };
  if (resumeAdmin) expect(env.exchange.allowMoneyTests).toBe(false);
  for (const baseURL of [env.client.baseUrl, env.admin.baseUrl]) guard.validateRuntime({ baseURL, workers: testInfo.config.workers, retries: testInfo.project.retries, repeatEach: testInfo.project.repeatEach, safetySwitches: switches });
  expect(testInfo.retry + testInfo.repeatEachIndex).toBe(0);
  const source = new PersonalPostRegistrationJourneyStore(sourceRunId).load();
  if (!source || source.stage !== 'COMPLETED') throw new Error('Existing completed Journey required; no registration or funding is permitted.');
  const store = new FlowStateStore(resolve('.flow-state', 'broker-journeys', sourceRunId));
  const prior = store.list(flowId);
  if (!resumeAdmin && prior.some(state => state.stage !== 'PREPARED')) throw new Error('Tiger application was already attempted for this Journey. Resume/read-only only; no new fee or Security Key verification.');
  let state = store.load(flowId, runId) ?? createPreparedFlowState({ runId, flowId });
  if (resumeAdmin && (!['ADMIN_LOCATED', 'ADMIN_APPROVAL_CONFIRMATION_REQUIRED'].includes(state.stage) || !state.adminReference || !state.clientSubmittedAt)) throw new Error('Admin Resume requires the original uniquely located application and no previous final approval attempt.');
  store.save(state);
  business.flow(flowId);
  business.setBusinessData({ runId, sourceRunId, registrationTestName: source.displayName, maskedLogin: maskRegistrationEmail(source.email), accountType: '香港账户', currency: 'USD', openingFeeAmount: state.amount });
  if (resumeAdmin) {
    business.disallowSafeRerun();
    business.recordDiagnostic({ id: 'tiger-existing-application-resume', name: '续跑原老虎申请', status: 'info', summary: '原申请已创建，原安全验证1次；本次只做Admin审核，Client缴费确认和安全验证均0次。', affectsCoreBusiness: false });
  }
  const shell = new AdminShellPage(adminPage);
  await shell.goto(env.admin.baseUrl!);
  await shell.expectSessionActive();
  const admin = new BrokerOpeningReviewPage(adminPage);
  await admin.goto(env.admin.baseUrl!);
  await admin.searchEmail(source.email);
  const existing = matchTigerOpening(await admin.collectRows(), { ...source, reference: resumeAdmin ? state.adminReference : undefined,
    submittedFrom: resumeAdmin ? state.clientSubmittedAt : undefined, submittedTo: resumeAdmin ? state.clientSubmittedAt : undefined });
  expect(existing.candidates).toHaveLength(resumeAdmin ? 1 : 0);
  const client = await openPersonalJourneyClientSession({ browser, baseURL: env.client.baseUrl!, runId: sourceRunId,
    email: source.email, password: env.client.password!, otp: env.client.otp!, forceFreshLogin: true });
  const network: Array<{ side: string; path: string; status: number; time: string }> = [];
  const capture = (side: string) => (response: Response) => {
    if (['POST', 'PUT', 'PATCH'].includes(response.request().method())) {
      network.push({ side, path: new URL(response.url()).pathname, status: response.status(), time: new Date().toISOString() });
    }
  };
  const clientCapture = capture('Client');
  const adminCapture = capture('Admin');
  client.page.on('response', clientCapture);
  adminPage.on('response', adminCapture);
  const opening = new BrokerOpeningPage(client.page);
  let finalStatus = '';
  try {
    await new RegistrationKycStatusPage(client.page).expectApproved({ ...source, runId: sourceRunId }, env.client.baseUrl!);
    guard.markAuthenticationReady(true, true);
    const accounts = new AccountDetailPage(client.page);
    await accounts.goto(env.client.baseUrl!);
    const before = await accounts.readSnapshot('香港账户', 'USD');
    const securities = new SecuritiesTradingPage(client.page);
    let candidate: BrokerOpeningRow | undefined;
    if (resumeAdmin) {
      candidate = requireExactlyOneCandidate(existing.candidates, 'Original Tiger Resume');
      expect(candidate.status).toBe('待处理');
      // Rehydrate guard evidence from the persisted creation stage, without any Client action.
      guard.recordClientMoneyConfirmation(); guard.recordSecurityKeyVerification(); guard.recordClientSubmission();
      guard.recordUniqueAdminCandidate(existing.candidates.length);
      business.setBusinessData({ candidateStages: JSON.stringify(existing.stages), candidateCount: 1, adminReference: state.adminReference,
        createdOrderCount: 1, confirmationClicks: 0, securityVerificationClicks: 0, beforeAvailableBalance: before.available });
    } else {
    await business.step({ action: '1. 原用户老虎开户资格、真实费用和余额', expected: '原AH用户待开户；费用与本次授权一致；余额足够；Admin已认证。' }, async step => {
      await securities.goto(env.client.baseUrl!);
      const card = requireExactlyOneCandidate((await securities.readBrokerCards()).filter(row => row.name === '老虎证券'), 'Client Tiger');
      expect(card.status).toBe('待开户');
      await securities.openApplication('老虎证券');
      const fee = await opening.readFee();
      expect(fee.currency).toBe('USD');
      expect(new Decimal(fee.amount).equals(authorizedFee)).toBe(true);
      expect(new Decimal(before.available).greaterThanOrEqualTo(fee.amount)).toBe(true);
      state = { ...state, amount: fee.amount, currency: fee.currency };
      store.save(state);
      step.setActual(`${source.displayName}；老虎证券；页面费用${fee.amount} USD；香港账户余额${before.available} USD；无已有老虎申请。`);
      step.setBusinessData({ beforeAvailableBalance: before.available, openingFeeAmount: fee.amount, preSubmitAdminCandidateCount: 0 });
    });
    const submittedFrom = new Date().toISOString();
    await business.step({ action: '2. 老虎开户缴费确认和安全密钥各一次', expected: '复用SecurityKeyDialog；不上传资料、不重复扣费。' }, async step => {
      getClientSecurityKey();
      guard.assertClientMoneyConfirmationAllowed(switches);
      state = advanceFlowState(state, 'FEE_CONFIRMATION_ATTEMPTED'); store.save(state);
      guard.recordClientMoneyConfirmation();
      await opening.confirmFeeOnce();
      await opening.securityKey.fill(getClientSecurityKey());
      guard.assertSecurityKeyVerificationAllowed(switches);
      state = advanceFlowState(state, 'SECURITY_KEY_VERIFICATION_ATTEMPTED'); store.save(state);
      step.disallowSafeRerun(); step.markPotentiallySubmitted();
      guard.recordSecurityKeyVerification();
      await opening.securityKey.verifyOnce();
      step.setActual('缴费确认1次；Security Key Verification: Passed；下一步核实真实申请。');
      step.setBusinessData({ confirmationClicks: 1, securityVerificationClicks: opening.securityKey.verificationClickCount() });
    });
    const submittedTo = new Date().toISOString();
    await business.step({ action: '3. Admin邮箱、原用户、老虎及本次时间唯一定位申请', expected: 'candidateCount=1；保存实际申请引用，不以Toast或HTTP 200判创建成功。' }, async step => {
      await expect.poll(async () => {
        await admin.goto(env.admin.baseUrl!);
        await admin.searchEmail(source.email);
        const matched = matchTigerOpening(await admin.collectRows(), { ...source, submittedFrom, submittedTo });
        step.setBusinessData({ candidateStages: JSON.stringify(matched.stages), candidateCount: matched.candidates.length });
        console.log('TIGER_CANDIDATES ' + JSON.stringify(matched.stages));
        if (matched.candidates.length > 1) throw new Error('Ambiguous Tiger candidates; approval forbidden.');
        candidate = matched.candidates[0];
        return matched.candidates.length;
      }, { timeout: 30_000, intervals: [1000, 2000, 5000] }).toBe(1);
      if (!candidate?.reference) throw new Error('BROKER_SUBMISSION_UNCONFIRMED: real application reference missing.');
      expect(candidate.status).toBe('待处理');
      guard.assertClientSubmissionAllowed(switches); guard.recordClientSubmission();
      state = advanceFlowState(state, 'CLIENT_CREATED', { clientReference: candidate.reference, adminReference: candidate.reference, clientSubmittedAt: submittedTo }); store.save(state);
      guard.recordUniqueAdminCandidate(1);
      state = advanceFlowState(state, 'ADMIN_LOCATED'); store.save(state);
      business.markMutationPerformed('Client老虎证券开户申请');
      step.setActual(`本次真实申请候选唯一；Admin申请引用已保存；状态=${candidate.status}。`);
      step.setBusinessData({ adminReference: candidate.reference, candidateCount: 1, createdOrderCount: 1 });
    });
    }
    await business.step({ action: '4. 原申请详情二次核对并审核通过一次', expected: '原用户、老虎、提交时间、状态一致；保存处理结果打开确认框，完整填写开户信息后确认通过1次。' }, async step => {
      if (!candidate) throw new Error('No unique application.');
      await admin.verifyDetail(candidate, source);
      await admin.fillApprovalForm(candidate, `AUTO_TIGER_APPROVE_${runId}`);
      await admin.openApprovalConfirmationOnce();
      if (state.stage !== 'ADMIN_APPROVAL_CONFIRMATION_REQUIRED') {
        state = advanceFlowState(state, 'ADMIN_APPROVAL_CONFIRMATION_REQUIRED'); store.save(state);
      }
      await admin.fillApprovalConfirmation({ accountName: source.displayName, accountNumber: brokerAccountNumber, openingDate });
      guard.assertAdminActionAllowed(switches);
      state = advanceFlowState(state, 'ADMIN_APPROVAL_SUBMISSION_ATTEMPTED'); store.save(state);
      guard.recordAdminAction();
      await admin.approveOnce();
      await expect.poll(async () => {
        await admin.goto(env.admin.baseUrl!); await admin.searchEmail(source.email);
        const matched = matchTigerOpening(await admin.collectRows(), { ...source, reference: candidate!.reference });
        if (matched.candidates.length !== 1) return '';
        finalStatus = matched.candidates[0].status;
        return finalStatus;
      }, { timeout: 30_000, intervals: [1000, 2000, 5000] }).toMatch(/^(已开户|审核通过|已通过|已批准)$/);
      state = advanceFlowState(state, 'ADMIN_ACTION_DONE'); store.save(state);
      business.markMutationPerformed('Admin老虎开户审核通过');
      step.setActual(`Admin保存处理结果打开确认框1次；确认通过1次；原申请最终状态=${finalStatus}。`);
      step.setBusinessData({ approvalClicks: admin.approvalClickCount(), finalStatus });
    });
    await business.step({ action: '5. Client刷新原老虎账户状态', expected: '同一用户的老虎账户已开通；不创建第二笔申请。' }, async step => {
      let clientStatus = '';
      await expect.poll(async () => {
        await securities.goto(env.client.baseUrl!);
        clientStatus = await securities.readBrokerStatus('老虎证券');
        return clientStatus;
      }, { timeout: 30_000, intervals: [1000, 2000, 5000] }).toMatch(/^(已开通|已开户)$/);
      state = advanceFlowState(state, 'CLIENT_FINALIZED'); store.save(state);
      state = advanceFlowState(state, 'COMPLETED'); store.save(state);
      business.setResumeState(state.stage);
      step.setActual(`Client=${clientStatus}；Admin=${finalStatus}；原申请唯一；本次未入金、未开户微牛。`);
      step.recordPrimaryOracle({ id: 'tiger-opening-approved', name: '老虎开户与Admin审核完整闭环', expected: '单笔申请、单次安全验证、Admin唯一审核、Client已开通', actual: `已验证；Admin=${finalStatus}；Client=${clientStatus}`, status: 'passed' });
      step.setBusinessData({ confirmed: true, finalStatus: clientStatus, approvalClicks: admin.approvalClickCount(), securityVerificationClicks: opening.securityKey.verificationClickCount() });
    });
    try {
      await accounts.goto(env.client.baseUrl!);
      const after = await accounts.readSnapshot('香港账户', 'USD');
      business.setBusinessData({ afterApprovedAvailableBalance: after.available, actualDebitAmount: new Decimal(before.available).minus(after.available).toFixed(2) });
      business.recordDiagnostic({ id: 'tiger-fee-balance', name: '开户费余额观测', status: 'available', summary: `${resumeAdmin ? '本次仅Admin续跑，未再次扣开户费；' : ''}香港USD ${before.available} -> ${after.available}；本次实际减少${new Decimal(before.available).minus(after.available).toFixed(2)}；原页面开户费${state.amount}。`, affectsCoreBusiness: false });
    } catch (error) {
      business.recordDiagnostic({ id: 'tiger-fee-balance', name: '开户费余额观测', status: 'unavailable', summary: '原申请和双端开户状态已核实。', reason: maskSensitiveText(String(error)), affectsCoreBusiness: false });
    }
  } catch (error) {
    business.setResumeState(state.stage);
    if (['SECURITY_KEY_VERIFICATION_ATTEMPTED', 'ADMIN_APPROVAL_SUBMISSION_ATTEMPTED'].includes(state.stage)) business.requireManualReview('只读查询原老虎申请和当前状态，禁止再次确认开户费或审核。');
    console.log('TIGER_STOP_STATE ' + JSON.stringify({ runId, stage: state.stage, reference: state.adminReference, securityClicks: opening.securityKey.verificationClickCount(), adminClicks: admin.approvalClickCount() }));
    throw error;
  } finally {
    client.page.off('response', clientCapture); adminPage.off('response', adminCapture);
    await testInfo.attach('tiger-safe-network-metadata', { body: maskSensitiveText(JSON.stringify(network)), contentType: 'application/json' });
    business.setBusinessData({ safeRequestEvidence: maskSensitiveText(JSON.stringify(network)) });
    await client.context.close();
  }
});
