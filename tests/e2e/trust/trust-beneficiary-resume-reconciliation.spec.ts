import { test, expect } from '../../../fixtures/registration.fixture';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { AdminTrustManagementPage } from '../../../pages/admin/AdminTrustManagementPage';
import { TrustBeneficiaryPage } from '../../../pages/client/TrustBeneficiaryPage';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment } from '../../../src/flow-engine';
import { openPersonalJourneyClientSession, PersonalJourneyContextStore } from '../../../src/registration';
import {
  trustBeneficiaryStageAtLeast,
  TrustBeneficiaryStateStore
} from '../../../src/trust/trust-beneficiary-state';

test.describe.configure({ mode: 'serial', retries: 0 });

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for Trust Beneficiary reconciliation.`);
  return value;
}

test('TRUST-BEN-003 existing Beneficiary submission read-only reconciliation', {
  tag: ['@trust', '@beneficiary', '@readonly', '@reconciliation', '@L2']
}, async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(180_000);
  expect(env.allowClientMutationTests).toBe(false);
  expect(env.allowAdminMutationTests).toBe(false);

  const clientBaseUrl = required('CLIENT_BASE_URL', env.client.baseUrl);
  const adminBaseUrl = required('ADMIN_BASE_URL', env.admin.baseUrl);
  assertSandboxEnvironment(clientBaseUrl);
  assertSandboxEnvironment(adminBaseUrl);

  const sourceRunId = env.personalRegistration.adminApprovalSourceRunId ?? 'REGP-20260904020924';
  const source = new PersonalJourneyContextStore().load(sourceRunId);
  if (!source?.email || !source.displayName || source.stage !== 'COMPLETED') {
    throw new Error('Completed Personal Journey source is required.');
  }
  const runId = process.env.TRUST_BENEFICIARY_RUN_ID?.trim() || 'TBEN-20260908-AH-01';
  const store = new TrustBeneficiaryStateStore(runId);
  let state = store.load();
  if (!state || !trustBeneficiaryStageAtLeast(state.stage, 'BENEFICIARY_CREATE_ATTEMPTED')) {
    throw new Error('Existing Beneficiary submission attempt is required; this test never creates one.');
  }

  business.case({
    caseId: 'TRUST-BEN-003', module: 'Trust Beneficiary',
    name: 'Existing Beneficiary submission read-only reconciliation', priority: 'P0',
    type: ['Read-only', 'Reconciliation'], scope: 'Client + Admin',
    preconditions: ['The original Beneficiary submit was attempted exactly once', 'Both mutation switches remain disabled'],
    expectedResult: 'Read Client and Admin only; confirm whether the one submitted Beneficiary exists.',
    changesData: false, affectsMoney: false, dependsOnAdmin: true, dependsOnThirdParty: false
  });
  business.setResumeState(state.stage);
  business.disallowSafeRerun();
  business.markDuplicateSubmissionRisk();
  business.setBusinessData({
    runId,
    sourceRunId,
    trustNumber: state.trustNumber,
    beneficiaryName: state.beneficiaryName,
    clientCreateCount: state.beneficiaryCreateCount,
    bankAccountCreateCount: state.bankAccountCreateCount,
    noDuplicateBeneficiaryCreated: true,
    adminMutationClicks: 0
  });

  const client = await openPersonalJourneyClientSession({
    browser,
    baseURL: clientBaseUrl,
    runId: sourceRunId,
    email: source.email,
    password: required('CLIENT_PASSWORD', env.client.password),
    otp: required('CLIENT_OTP', env.client.otp)
  });

  try {
    const trust = new TrustBeneficiaryPage(client.page);
    const adminTrust = new AdminTrustManagementPage(adminPage);
    await trust.goto(clientBaseUrl);
    const trustNumber = await trust.readTrustNumber();
    expect(trustNumber).toBe(state.trustNumber);
    const clientRecordObserved = await trust.beneficiaryExists(state.beneficiaryName);
    const clientBankAccountCount = clientRecordObserved
      ? await trust.bankAccountCount(state.beneficiaryName)
      : 0;
    if (clientRecordObserved) {
      console.log(`TRUST_BEN_CLIENT_ANCESTORS=${JSON.stringify(await trust.inspectBeneficiaryAncestors(state.beneficiaryName))}`);
    }

    const shell = new AdminShellPage(adminPage);
    await shell.goto(adminBaseUrl);
    await shell.expectSessionActive();
    await adminTrust.goto(adminBaseUrl);
    const adminCandidate = await adminTrust.locateUnique({ email: source.email, trustNumber });
    const adminRecordObserved = adminCandidate.beneficiaryCount > 0;

    business.setBusinessData({
      candidateCount: 1,
      clientBeneficiaryRecordObserved: clientRecordObserved,
      adminBeneficiaryRecordObserved: adminRecordObserved,
      adminBeneficiaryCount: adminCandidate.beneficiaryCount,
      clientBankAccountCount,
      noDuplicateBeneficiaryCreated: true
    });

    if (!clientRecordObserved && !adminRecordObserved) {
      if (state.stage === 'BENEFICIARY_CREATE_ATTEMPTED') {
        state = store.advance(state, 'BENEFICIARY_CREATION_UNCONFIRMED');
      }
      business.setResumeState(state.stage);
      business.setBusinessData({
        resumeStage: state.stage,
        blockerReason: 'BENEFICIARY_CREATION_UNCONFIRMED'
      });
      testInfo.annotations.push({ type: 'blocker', description: 'BENEFICIARY_CREATION_UNCONFIRMED' });
      return;
    }

    expect(clientRecordObserved).toBe(true);
    expect(adminRecordObserved).toBe(true);
    if (!trustBeneficiaryStageAtLeast(state.stage, 'BENEFICIARY_CREATED')) {
      state = store.advance(state, 'BENEFICIARY_CREATED', {
        beneficiaryCreateCount: 1,
        beneficiaryStatus: await trust.beneficiaryStatus(state.beneficiaryName)
      });
      business.setResumeState(state.stage);
    } else if (state.beneficiaryCreateCount === 0) {
      state = { ...state, beneficiaryCreateCount: 1, updatedAt: new Date().toISOString() };
      store.save(state);
    }
    if (state.stage === 'BENEFICIARY_BANK_ACCOUNT_CREATE_ATTEMPTED' && clientBankAccountCount === 1) {
      state = store.advance(state, 'BENEFICIARY_BANK_ACCOUNT_CREATED', {
        bankAccountCreateCount: 1
      });
      business.setResumeState(state.stage);
    }
    let bankForm: Awaited<ReturnType<TrustBeneficiaryPage['inspectOpenBankForm']>> | undefined;
    if (clientBankAccountCount === 0) {
      await trust.openAddBankAccount(state.beneficiaryName);
      bankForm = await trust.inspectOpenBankForm();
      console.log(`TRUST_BEN_BANK_FORM=${JSON.stringify(bankForm)}`);
    }
    business.setBusinessData({
      beneficiaryStatus: await trust.beneficiaryStatus(state.beneficiaryName),
      bankAccountCreateCount: state.bankAccountCreateCount,
      approvalRequiredFields: bankForm?.labels ?? [],
      remainingRequiredFields: bankForm?.placeholders ?? []
    });
  } finally {
    await client.context.close();
  }
});
