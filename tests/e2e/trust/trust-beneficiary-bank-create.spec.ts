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
  'Beneficiary Bank Account creation requires explicit Client and Admin mutation switches.');

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for Beneficiary Bank Account creation.`);
  return value;
}

test('TRUST-BEN-002 create one Bank Account for existing AB Beneficiary', {
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
  if (!state || state.stage !== 'BENEFICIARY_CREATED' || state.beneficiaryCreateCount !== 1 || state.bankAccountCreateCount !== 0) {
    throw new Error('Bank Account creation requires the existing created Beneficiary and zero Bank Accounts.');
  }
  const source = new PersonalJourneyContextStore().load(state.sourceRunId);
  if (!source?.email || !source.displayName || source.stage !== 'COMPLETED') throw new Error('Completed Personal source is required.');
  const data = buildTrustBeneficiaryTestData(runId);

  business.case({
    caseId: 'TRUST-BEN-002-BANK', module: 'Trust Beneficiary', name: 'Create one Bank Account for the same AB Beneficiary',
    priority: 'P0', type: ['E2E', 'Mutation', 'Resume'], scope: 'Client + Admin Preflight',
    preconditions: ['AB Beneficiary exists uniquely', 'AB currently has zero Bank Accounts'],
    expectedResult: 'Create one USD savings Bank Account and observe account count=1 on the same Beneficiary.',
    changesData: true, affectsMoney: false, dependsOnAdmin: true, dependsOnThirdParty: false,
    safetySwitches: ['ALLOW_CLIENT_MUTATION_TESTS', 'ALLOW_ADMIN_MUTATION_TESTS']
  });
  business.disallowSafeRerun();
  business.setResumeState(state.stage);
  business.setBusinessData({
    runId, sourceRunId: state.sourceRunId, trustNumber: state.trustNumber,
    beneficiaryName: state.beneficiaryName, beneficiaryStatus: state.beneficiaryStatus,
    clientCreateCount: 1, bankAccountCreateCount: 0, bankAccountSuffix: `****${state.bankAccountSuffix}`,
    bankName: data.bank.bankName, bankCurrency: data.bank.currency,
    bankAccountConfirmationClickCount: 0, bankSecurityVerificationClicks: 0, adminMutationClicks: 0
  });

  const client = await openPersonalJourneyClientSession({
    browser, baseURL: clientBaseUrl, runId: state.sourceRunId, email: source.email,
    password: required('CLIENT_PASSWORD', env.client.password), otp: required('CLIENT_OTP', env.client.otp)
  });
  const trust = new TrustBeneficiaryPage(client.page);
  const adminTrust = new AdminTrustManagementPage(adminPage);
  const guard = new MoneyMutationGuard('TRUST-BENEFICIARY-BANK-CREATE', true, false);
  const switches = { ALLOW_CLIENT_MUTATION_TESTS: env.allowClientMutationTests, ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests };
  guard.validateRuntime({ baseURL: clientBaseUrl, workers: testInfo.config.workers, retries: testInfo.project.retries,
    repeatEach: testInfo.project.repeatEach, safetySwitches: switches });

  try {
    await trust.goto(clientBaseUrl);
    expect(await trust.readTrustNumber()).toBe(state.trustNumber);
    expect(await trust.beneficiaryExists(data.name)).toBe(true);
    expect(await trust.bankAccountCount(data.name)).toBe(0);

    const shell = new AdminShellPage(adminPage);
    await shell.goto(adminBaseUrl);
    await shell.expectSessionActive();
    await adminTrust.goto(adminBaseUrl);
    const candidate = await adminTrust.locateUnique({ email: source.email, trustNumber: state.trustNumber });
    expect(candidate.beneficiaryCount).toBe(1);
    guard.markAuthenticationReady(true, true);

    await trust.goto(clientBaseUrl);
    await trust.openAddBankAccount(data.name);
    await trust.fillOpenBankForm(data.bank);
    guard.assertClientSubmissionAllowed(switches);
    state = store.advance(state, 'BENEFICIARY_BANK_ACCOUNT_CREATE_ATTEMPTED', {
      bankAccountConfirmationClickCount: 1,
      bankAccountSubmittedAt: new Date().toISOString()
    });
    business.setResumeState(state.stage);
    business.markPotentiallySubmitted();
    business.markMutationPerformed('Client Beneficiary Bank Account creation');

    const submission = await trust.submitBankAccountOnce(
      data.name,
      required('CLIENT_SECURITY_KEY', env.client.securityKey)
    );
    guard.recordClientSubmission();
    expect(submission.bankAccountCount).toBe(1);
    expect([0, 1]).toContain(submission.securityVerificationCount);
    const bankSecurityVerificationCount = submission.securityVerificationCount as 0 | 1;
    state = store.advance(state, 'BENEFICIARY_BANK_ACCOUNT_CREATED', {
      bankAccountCreateCount: 1,
      bankSecurityVerificationCount
    });
    business.setResumeState(state.stage);
    business.setBusinessData({
      bankAccountCreateCount: 1,
      bankAccountConfirmationClickCount: 1,
      bankSecurityVerificationClicks: submission.securityVerificationCount,
      securityDialogObserved: submission.securityDialogObserved,
      safeRequestEvidence: submission.evidence,
      clientMutationResponseCount: submission.mutationResponseCount
    });
  } finally {
    await client.context.close();
    business.setResumeState(state.stage);
  }
});
