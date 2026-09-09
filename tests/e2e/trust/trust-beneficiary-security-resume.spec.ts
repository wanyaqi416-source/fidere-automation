import { test, expect } from '../../../fixtures/registration.fixture';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { AdminTrustManagementPage } from '../../../pages/admin/AdminTrustManagementPage';
import { TrustBeneficiaryPage } from '../../../pages/client/TrustBeneficiaryPage';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment, MoneyMutationGuard } from '../../../src/flow-engine';
import { openPersonalJourneyClientSession, PersonalJourneyContextStore } from '../../../src/registration';
import { buildTrustBeneficiaryTestData } from '../../../src/trust/trust-beneficiary-data';
import { TrustBeneficiaryStateStore } from '../../../src/trust/trust-beneficiary-state';

test.describe.configure({ mode: 'serial', retries: 0 });
test.skip(!env.allowClientMutationTests || !env.allowAdminMutationTests,
  'Trust Beneficiary Security Resume requires explicit Client and Admin mutation switches.');

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for Trust Beneficiary Security Resume.`);
  return value;
}

test('TRUST-BEN-002 Resume AB from Security Key confirmation', {
  tag: ['@trust', '@beneficiary', '@mutation', '@resume', '@L4']
}, async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(240_000);
  const clientBaseUrl = required('CLIENT_BASE_URL', env.client.baseUrl);
  const adminBaseUrl = required('ADMIN_BASE_URL', env.admin.baseUrl);
  assertSandboxEnvironment(clientBaseUrl);
  assertSandboxEnvironment(adminBaseUrl);
  expect(testInfo.config.workers).toBe(1);
  expect(testInfo.project.retries).toBe(0);
  expect(testInfo.project.repeatEach).toBe(1);

  const runId = required('TRUST_BENEFICIARY_RUN_ID', process.env.TRUST_BENEFICIARY_RUN_ID);
  const store = new TrustBeneficiaryStateStore(runId);
  let state = store.load();
  if (!state || state.stage !== 'BENEFICIARY_SECURITY_REQUIRED' || state.beneficiaryCreateCount !== 0 || state.securityVerificationCount !== 0) {
    throw new Error('Security Resume requires one existing form confirmation, zero Security Key verifications, and zero created Beneficiaries.');
  }
  const source = new PersonalJourneyContextStore().load(state.sourceRunId);
  if (!source?.email || !source.displayName || source.stage !== 'COMPLETED') throw new Error('Completed Personal source is required.');
  const data = buildTrustBeneficiaryTestData(runId);

  business.case({
    caseId: 'TRUST-BEN-002-SECURITY-RESUME', module: 'Trust Beneficiary',
    name: 'Resume the same AB Beneficiary at Security Key verification', priority: 'P0',
    type: ['E2E', 'Mutation', 'Resume'], scope: 'Client + Admin Preflight',
    preconditions: ['AB was not created', 'Security Key verification count is zero', 'No replacement Beneficiary is allowed'],
    expectedResult: 'Verify the Security Key once and observe the same AB Beneficiary before opening its bank-account form.',
    changesData: true, affectsMoney: false, dependsOnAdmin: true, dependsOnThirdParty: false,
    safetySwitches: ['ALLOW_CLIENT_MUTATION_TESTS', 'ALLOW_ADMIN_MUTATION_TESTS']
  });
  business.disallowSafeRerun();
  business.setResumeState(state.stage);
  business.setBusinessData({
    runId,
    sourceRunId: state.sourceRunId,
    trustNumber: state.trustNumber,
    beneficiaryName: state.beneficiaryName,
    clientCreateCount: 0,
    beneficiaryConfirmationClickCount: state.beneficiaryConfirmationClickCount,
    securityVerificationClicks: 0,
    noDuplicateBeneficiaryCreated: true,
    adminMutationClicks: 0
  });

  const client = await openPersonalJourneyClientSession({
    browser, baseURL: clientBaseUrl, runId: state.sourceRunId, email: source.email,
    password: required('CLIENT_PASSWORD', env.client.password), otp: required('CLIENT_OTP', env.client.otp)
  });
  const trust = new TrustBeneficiaryPage(client.page);
  const adminTrust = new AdminTrustManagementPage(adminPage);
  const guard = new MoneyMutationGuard('TRUST-BENEFICIARY-SECURITY-RESUME', true, false);
  const switches = { ALLOW_CLIENT_MUTATION_TESTS: env.allowClientMutationTests, ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests };
  guard.validateRuntime({ baseURL: clientBaseUrl, workers: testInfo.config.workers, retries: testInfo.project.retries,
    repeatEach: testInfo.project.repeatEach, safetySwitches: switches });

  try {
    await trust.goto(clientBaseUrl);
    expect(await trust.readTrustNumber()).toBe(state.trustNumber);
    expect(await trust.beneficiaryExists(data.name)).toBe(false);

    const shell = new AdminShellPage(adminPage);
    await shell.goto(adminBaseUrl);
    await shell.expectSessionActive();
    await adminTrust.goto(adminBaseUrl);
    const candidate = await adminTrust.locateUnique({ email: source.email, trustNumber: state.trustNumber });
    expect(candidate.beneficiaryCount).toBe(0);
    guard.markAuthenticationReady(true, true);

    await trust.goto(clientBaseUrl);
    await trust.openAddBeneficiary();
    await trust.fillBeneficiary(data);
    guard.assertClientSubmissionAllowed(switches);
    state = {
      ...state,
      beneficiaryConfirmationClickCount: 2,
      updatedAt: new Date().toISOString()
    };
    store.save(state);
    state = store.advance(state, 'BENEFICIARY_SECURITY_VERIFICATION_ATTEMPTED', {
      securityVerificationCount: 1
    });
    business.setResumeState(state.stage);
    business.markPotentiallySubmitted();
    business.markMutationPerformed('Trust Beneficiary Security Key verification');

    const submission = await trust.submitBeneficiaryOnce(data, required('CLIENT_SECURITY_KEY', env.client.securityKey));
    guard.recordClientSubmission();
    business.setBusinessData({
      beneficiaryConfirmationClickCount: 2,
      securityDialogObserved: submission.securityDialogObserved,
      securityVerificationClicks: submission.securityVerificationCount,
      safeRequestEvidence: submission.evidence,
      clientMutationResponseCount: submission.mutationResponseCount,
      clientBeneficiaryRecordObserved: submission.recordVisible
    });
    expect(submission.securityVerificationCount).toBe(1);

    if (!submission.recordVisible) {
      state = store.advance(state, 'BENEFICIARY_POST_SECURITY_UNCONFIRMED');
      testInfo.annotations.push({ type: 'blocker', description: 'BENEFICIARY_CREATION_UNCONFIRMED_AFTER_SECURITY' });
      throw new Error('BENEFICIARY_CREATION_UNCONFIRMED_AFTER_SECURITY: verification clicked once; never verify or submit again.');
    }

    state = store.advance(state, 'BENEFICIARY_CREATED', {
      beneficiaryCreateCount: 1,
      beneficiaryStatus: await trust.beneficiaryStatus(data.name)
    });
    business.setResumeState(state.stage);
    business.setBusinessData({ clientCreateCount: 1, beneficiaryStatus: state.beneficiaryStatus });
    await trust.openAddBankAccount(data.name);
    const form = await trust.inspectOpenBankForm();
    business.setBusinessData({ approvalRequiredFields: form.labels, remainingRequiredFields: form.placeholders });
    console.log(`TRUST_BEN_BANK_FORM=${JSON.stringify(form)}`);
  } finally {
    await client.context.close();
    business.setResumeState(state.stage);
  }
});
