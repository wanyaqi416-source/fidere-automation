import { test, expect } from '../../../fixtures/registration.fixture';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment } from '../../../src/flow-engine/mutation-guard';
import { RegistrationReviewDashboardPage } from '../../../pages/admin/RegistrationReviewDashboardPage';
import { RegistrationReviewProcessPage } from '../../../pages/admin/RegistrationReviewProcessPage';
import { REGISTRATION_KYC, assertRegistrationCaseIdentity } from '../../../src/registration/registration-kyc-contract';
import { submittedRegistrationSource } from '../../../src/registration/registration-kyc-tail';

test('Registration KYC original case readonly preflight', {
  tag: ['@registration', '@readonly', '@L2']
}, async ({ adminPage, business }, testInfo) => {
  const accountType = process.env.REGISTRATION_KYC_ACCOUNT_TYPE;
  const runId = env.personalRegistration.adminApprovalSourceRunId;
  test.skip(!runId || !accountType, 'An explicit accountType and original sourceRunId are required.');
  if (accountType !== 'PERSONAL' && accountType !== 'BUSINESS') throw new Error('Invalid Registration accountType.');
  if (env.allowClientMutationTests || env.allowAdminMutationTests || env.exchange.allowMoneyTests) {
    throw new Error('Readonly KYC preflight requires all mutation switches closed.');
  }
  testInfo.setTimeout(120_000);
  assertSandboxEnvironment(env.admin.baseUrl);
  const config = REGISTRATION_KYC[accountType];
  const source = submittedRegistrationSource(accountType, runId!);
  business.flow(config.flowId, { caseId: `${config.caseId}-READONLY`, name: `${config.tab}原案件只读预检`,
    changesData: false, affectsMoney: false, level: 'L2', type: ['Readonly'], safetySwitches: [] });
  await business.step({ action: `只读定位${config.tab}并核对原案件详情`,
    expected: '原账号候选唯一，详情邮箱、名称、类型及引用正确；不填审批、不点击通过' }, async context => {
    const dashboard = new RegistrationReviewDashboardPage(adminPage);
    await dashboard.goto(env.admin.baseUrl!);
    const result = await dashboard.locateUniquePendingCandidate({ accountType: config.storageType,
      email: source.email, displayName: source.displayName, userId: source.userId, reviewId: source.reviewId });
    context.setBusinessData({ candidateCount: result.candidateCount, candidateStages: result.candidateStages, adminKycTab: config.tab });
    expect(result.candidateCount).toBe(1);
    const process = new RegistrationReviewProcessPage(adminPage);
    const candidate = await process.readKycCase(accountType, result.candidates[0].processUrl, env.admin.baseUrl!);
    assertRegistrationCaseIdentity(source, candidate);
    await process.verifyIdentityAndType({ accountType: config.storageType, displayName: source.displayName });
    await process.expectCurrentApprovalForm();
    context.setBusinessData({ registrationReviewId: `****${candidate.reviewId.slice(-2)}`,
      adminFinalState: candidate.status, mutationPerformed: false });
    context.setActual(`${config.tab}，candidateCount=1；详情匹配；当前阶段=${candidate.step}，状态=${candidate.status}；Approve=0。`);
  });
});
