import { test, expect } from '../../../fixtures/registration.fixture';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { AdminTrustBeneficiaryPage } from '../../../pages/admin/AdminTrustBeneficiaryPage';
import { AdminTrustManagementPage } from '../../../pages/admin/AdminTrustManagementPage';
import { TrustBeneficiaryPage } from '../../../pages/client/TrustBeneficiaryPage';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment, MoneyMutationGuard } from '../../../src/flow-engine';
import { openPersonalJourneyClientSession, PersonalJourneyContextStore } from '../../../src/registration';
import { buildTrustBeneficiaryTestData } from '../../../src/trust/trust-beneficiary-data';
import { TrustBeneficiaryStateStore } from '../../../src/trust/trust-beneficiary-state';

test.describe.configure({ mode: 'serial', retries: 0 });
test.skip(!env.allowAdminMutationTests, 'Beneficiary approval requires explicit Admin mutation authorization.');

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for Beneficiary approval.`);
  return value;
}

test('TRUST-BEN-002 approve existing AB Beneficiary and verify Client state', {
  tag: ['@trust', '@beneficiary', '@admin', '@mutation', '@resume', '@L4']
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
  if (!state || state.stage !== 'BENEFICIARY_BANK_ACCOUNT_CREATED' ||
      state.beneficiaryApproveCount !== 0 || state.bankAccountCreateCount !== 1) {
    throw new Error('Existing unapproved AB Beneficiary with one Bank Account is required.');
  }
  const source = new PersonalJourneyContextStore().load(state.sourceRunId);
  if (!source?.email || !source.displayName || source.stage !== 'COMPLETED') {
    throw new Error('Completed Personal source is required.');
  }
  const data = buildTrustBeneficiaryTestData(runId);
  const switches = { ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests };
  const guard = new MoneyMutationGuard('TRUST-BENEFICIARY-APPROVE', true, false);
  guard.validateRuntime({
    baseURL: adminBaseUrl,
    workers: testInfo.config.workers,
    retries: testInfo.project.retries,
    repeatEach: testInfo.project.repeatEach,
    safetySwitches: switches
  });

  business.case({
    caseId: 'TRUST-BEN-002-APPROVE', module: 'Trust Beneficiary',
    name: 'Existing Beneficiary Admin approval and Client final verification', priority: 'P0',
    type: ['E2E', 'Mutation', 'Resume'], scope: 'Client + Admin',
    preconditions: ['AB Beneficiary and one Bank Account already exist', 'Admin candidateCount=1 before approval'],
    expectedResult: 'Approve the unique AB Beneficiary once and observe the same Beneficiary approved in Client.',
    changesData: true, affectsMoney: false, dependsOnAdmin: true, dependsOnThirdParty: false,
    safetySwitches: ['ALLOW_ADMIN_MUTATION_TESTS']
  });
  business.disallowSafeRerun();
  business.setResumeState(state.stage);
  business.setBusinessData({
    runId,
    sourceRunId: state.sourceRunId,
    trustNumber: state.trustNumber,
    beneficiaryName: state.beneficiaryName,
    beneficiaryStatus: state.beneficiaryStatus,
    clientCreateCount: 1,
    bankAccountCreateCount: 1,
    adminMutationClicks: 0,
    beneficiaryApprovalClicks: 0,
    bankAccountApprovalClicks: 0
  });

  const shell = new AdminShellPage(adminPage);
  const trusts = new AdminTrustManagementPage(adminPage);
  const beneficiaries = new AdminTrustBeneficiaryPage(adminPage);
  await shell.goto(adminBaseUrl);
  await shell.expectSessionActive();
  guard.markAuthenticationReady(true, true);
  guard.recordClientSubmission();

  await trusts.goto(adminBaseUrl);
  const trust = await trusts.locateUnique({ email: source.email, trustNumber: state.trustNumber });
  expect(trust.beneficiaryCount).toBe(1);
  state = store.advance(state, 'ADMIN_TRUST_FOUND');
  business.setResumeState(state.stage);

  await trusts.open(trust);
  await beneficiaries.openTab();
  const listRecon = await beneficiaries.inspect(data.name);
  expect(listRecon.beneficiaryVisible).toBe(true);
  expect(listRecon.statusText).toMatch(/待审核/);
  await beneficiaries.openDetails(data.name);
  const detailMatch = await beneficiaries.matchOpenDetails(data);
  expect(Object.values(detailMatch).every(Boolean)).toBe(true);
  state = store.advance(state, 'ADMIN_BENEFICIARY_FOUND');
  business.setResumeState(state.stage);
  guard.recordUniqueAdminCandidate(1);
  guard.assertAdminActionAllowed(switches);

  state = store.advance(state, 'ADMIN_BENEFICIARY_APPROVAL_ATTEMPTED', {
    beneficiaryApproveCount: 1
  });
  business.setResumeState(state.stage);
  business.markPotentiallySubmitted();
  business.markMutationPerformed('Admin approved the unique Beneficiary');
  const approval = await beneficiaries.approveOpenDetailsOnce(data.name);
  guard.recordAdminAction();
  expect(approval.approvalClicks).toBe(1);
  expect([0, 1]).toContain(approval.confirmationClicks);
  business.setBusinessData({
    candidateCount: 1,
    adminDetailMatch: detailMatch,
    beneficiaryApprovalClicks: approval.approvalClicks,
    adminConfirmationClicks: approval.confirmationClicks,
    safeRequestEvidence: approval.requestPath ? {
      path: approval.requestPath,
      status: approval.httpStatus,
      observedAt: approval.observedAt
    } : undefined,
    independentBankApprovalVisible: false,
    bankAccountApprovalClicks: 0
  });

  await trusts.goto(adminBaseUrl);
  const approvedTrust = await trusts.locateUnique({ email: source.email, trustNumber: state.trustNumber });
  await trusts.open(approvedTrust);
  await beneficiaries.openTab();
  const approved = await beneficiaries.inspect(data.name);
  expect(approved.beneficiaryVisible).toBe(true);
  expect(approved.statusText).toMatch(/已批准|审核通过|已通过/);
  state = store.advance(state, 'ADMIN_BENEFICIARY_APPROVED', {
    beneficiaryStatus: approved.statusText
  });
  business.setResumeState(state.stage);

  const client = await openPersonalJourneyClientSession({
    browser,
    baseURL: clientBaseUrl,
    runId: state.sourceRunId,
    email: source.email,
    password: required('CLIENT_PASSWORD', env.client.password),
    otp: required('CLIENT_OTP', env.client.otp)
  });
  try {
    const clientTrust = new TrustBeneficiaryPage(client.page);
    await clientTrust.goto(clientBaseUrl);
    expect(await clientTrust.readTrustNumber()).toBe(state.trustNumber);
    expect(await clientTrust.beneficiaryExists(data.name)).toBe(true);
    const clientStatus = await clientTrust.beneficiaryStatus(data.name);
    expect(clientStatus).toMatch(/已批准|审核通过|已通过/);
    expect(await clientTrust.bankAccountCount(data.name)).toBe(1);
    await clientTrust.openBankAccounts(data.name);
    const bankMatch = await clientTrust.matchOpenBankAccount(data.bank);
    expect(Object.values(bankMatch).every(Boolean)).toBe(true);
    state = store.advance(state, 'CLIENT_BENEFICIARY_APPROVED', {
      beneficiaryStatus: clientStatus,
      bankAccountStatus: 'Associated; no independent Admin approval exposed'
    });
    state = store.advance(state, 'BENEFICIARY_DATA_VERIFIED');
    business.setResumeState(state.stage);
    business.setBusinessData({
      beneficiaryStatus: clientStatus,
      clientBankAccountCount: 1,
      clientBankAccountMatch: bankMatch,
      independentBankApprovalRequired: false,
      finalStatus: 'COMPLETED',
      confirmed: true,
      manualCheckRequired: false
    });
    business.recordPrimaryOracle({
      id: 'beneficiary-approved',
      name: '同一受益人完成Admin审核',
      expected: '候选唯一、详情一致、批准一次、Client显示成功状态',
      actual: 'candidateCount=1；批准1次；Client状态已同步',
      status: 'passed'
    });
    business.recordPrimaryOracle({
      id: 'bank-associated',
      name: '银行账户保持正确关联',
      expected: '同一受益人仅有一个已创建银行账户',
      actual: '数量1；银行名称、账号尾号和币种一致',
      status: 'passed'
    });
  } finally {
    await client.context.close();
  }
});
