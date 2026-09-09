import { test } from '../../../fixtures/registration.fixture';
import { env } from '../../../src/config/env';
import { runRegistrationKycTail, submittedRegistrationSource } from '../../../src/registration/registration-kyc-tail';

test.describe.configure({ mode: 'serial', retries: 0 });

test('Personal Golden Journey KYC Resume', {
  tag: ['@registration', '@journey', '@resume', '@mutation', '@L4']
}, async ({ browser, adminPage, business }, testInfo) => {
  test.skip(!env.allowAdminMutationTests, 'Admin mutation authorization is required.');
  test.setTimeout(600_000);
  const runId = env.personalRegistration.adminApprovalSourceRunId;
  if (!runId) throw new Error('REGISTRATION_APPROVAL_SOURCE_RUN_ID is required for the original Personal Journey.');
  business.flow('personal-registration-admin-approval', { caseId: 'REG-P-003', name: '原Personal案件KYC续跑' });
  await runRegistrationKycTail({ source: submittedRegistrationSource('PERSONAL', runId),
    browser, adminPage, business, testInfo });
});
