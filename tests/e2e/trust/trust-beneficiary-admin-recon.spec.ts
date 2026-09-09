import { test, expect } from '../../../fixtures/registration.fixture';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { AdminTrustBeneficiaryPage } from '../../../pages/admin/AdminTrustBeneficiaryPage';
import { AdminTrustManagementPage } from '../../../pages/admin/AdminTrustManagementPage';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment } from '../../../src/flow-engine';
import { PersonalJourneyContextStore } from '../../../src/registration';
import { buildTrustBeneficiaryTestData } from '../../../src/trust/trust-beneficiary-data';
import { TrustBeneficiaryStateStore } from '../../../src/trust/trust-beneficiary-state';

test.describe.configure({ mode: 'serial', retries: 0 });

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for Admin Beneficiary Recon.`);
  return value;
}

test('TRUST-BEN-ADMIN-RECON inspect existing AB Beneficiary approval structure', {
  tag: ['@trust', '@beneficiary', '@admin', '@readonly', '@recon', '@L2']
}, async ({ adminPage, business }) => {
  expect(env.allowClientMutationTests).toBe(false);
  expect(env.allowAdminMutationTests).toBe(false);
  const baseURL = required('ADMIN_BASE_URL', env.admin.baseUrl);
  assertSandboxEnvironment(baseURL);
  const runId = process.env.TRUST_BENEFICIARY_RUN_ID?.trim() || 'TBEN-20260908-AH-02';
  const state = new TrustBeneficiaryStateStore(runId).load();
  if (!state || state.stage !== 'BENEFICIARY_BANK_ACCOUNT_CREATED' || state.bankAccountCreateCount !== 1) {
    throw new Error('Existing Beneficiary and Bank Account are required; Recon never creates them.');
  }
  const source = new PersonalJourneyContextStore().load(state.sourceRunId);
  if (!source?.email) throw new Error('Source Personal Journey is unavailable.');
  const data = buildTrustBeneficiaryTestData(runId);

  business.case({
    caseId: 'TRUST-BEN-ADMIN-RECON', module: 'Trust Beneficiary',
    name: 'Admin Beneficiary approval structure Recon', priority: 'P0',
    type: ['Read-only', 'Recon'], scope: 'Admin',
    preconditions: ['AB Beneficiary and its one Bank Account already exist', 'Admin mutation switch is disabled'],
    expectedResult: 'Open the unique Trust and inspect the real Beneficiary approval controls without mutation.',
    changesData: false, affectsMoney: false, dependsOnAdmin: true, dependsOnThirdParty: false
  });
  business.setResumeState(state.stage);
  business.setBusinessData({
    runId,
    trustNumber: state.trustNumber,
    beneficiaryName: state.beneficiaryName,
    beneficiaryStatus: state.beneficiaryStatus,
    bankAccountCreateCount: 1,
    adminMutationClicks: 0
  });

  const shell = new AdminShellPage(adminPage);
  const trusts = new AdminTrustManagementPage(adminPage);
  const beneficiaries = new AdminTrustBeneficiaryPage(adminPage);
  await shell.goto(baseURL);
  await shell.expectSessionActive();
  await trusts.goto(baseURL);
  const trust = await trusts.locateUnique({ email: source.email, trustNumber: state.trustNumber });
  expect(trust.beneficiaryCount).toBe(1);
  await trusts.open(trust);
  await beneficiaries.openTab();
  const recon = await beneficiaries.inspect(state.beneficiaryName);
  expect(recon.beneficiaryVisible).toBe(true);
  const detailRecon = await beneficiaries.openDetails(state.beneficiaryName);
  expect(detailRecon.detailDialogVisible).toBe(true);
  const detailMatch = await beneficiaries.matchOpenDetails(data);
  console.log(`TRUST_BEN_ADMIN_RECON=${JSON.stringify({ ...detailRecon, detailMatch })}`);
  business.setBusinessData({
    candidateCount: 1,
    adminBeneficiaryCount: trust.beneficiaryCount,
    beneficiaryStatus: detailRecon.statusText,
    bankAccountCreateCount: detailRecon.bankAccountCount,
    approvalRequiredFields: detailRecon.detailLabels,
    availableActions: detailRecon.buttonLabels,
    bankAccountVisibleInDetail: detailRecon.detailHasBankAccount,
    independentBankApprovalVisible: detailRecon.detailHasIndependentBankApproval,
    adminDetailMatch: detailMatch,
    adminMutationClicks: 0
  });
});
