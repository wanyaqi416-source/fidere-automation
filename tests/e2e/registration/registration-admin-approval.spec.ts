import { test } from '../../../fixtures/registration.fixture';
import { env } from '../../../src/config/env';
import { REGISTRATION_KYC } from '../../../src/registration/registration-kyc-contract';
import { runRegistrationKycTail, submittedRegistrationSource } from '../../../src/registration/registration-kyc-tail';

test.describe.configure({ mode: 'serial', retries: 0 });

for (const accountType of ['PERSONAL', 'BUSINESS'] as const) {
  const config = REGISTRATION_KYC[accountType];
  test(`${config.caseId} ${config.tab}注册Admin审核通过闭环`, {
    tag: ['@registration', '@admin', '@mutation', '@resume', '@L4'],
    annotation: [{ type: 'caseId', description: config.caseId }]
  }, async ({ browser, adminPage, business }, testInfo) => {
    test.skip(!env.allowAdminMutationTests, 'Registration KYC Approval requires explicit Admin mutation authorization.');
    test.setTimeout(600_000);
    const runId = process.env[`${accountType}_REGISTRATION_APPROVAL_SOURCE_RUN_ID`]?.trim() ||
      env.personalRegistration.adminApprovalSourceRunId;
    if (!runId) throw new Error('REGISTRATION_APPROVAL_SOURCE_RUN_ID is required; selecting a latest user is forbidden.');
    business.flow(config.flowId, {
      caseId: config.caseId, name: `${config.tab}注册审核完整闭环`,
      expectedResult: 'Resume同一已提交账号和reviewId，完成实际所需审核阶段，干净登录验证Client KYC通过。'
    });
    await runRegistrationKycTail({ source: submittedRegistrationSource(accountType, runId),
      browser, adminPage, business, testInfo });
  });
}
