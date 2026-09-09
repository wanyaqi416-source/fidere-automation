import { test, expect } from '../../../fixtures/registration.fixture';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { AdminTrustManagementPage } from '../../../pages/admin/AdminTrustManagementPage';
import { TrustBeneficiaryPage } from '../../../pages/client/TrustBeneficiaryPage';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment, MoneyMutationGuard } from '../../../src/flow-engine';
import {
  maskRegistrationEmail,
  openPersonalJourneyClientSession,
  PersonalJourneyContextStore
} from '../../../src/registration';
import { buildTrustBeneficiaryTestData } from '../../../src/trust/trust-beneficiary-data';
import {
  trustBeneficiaryStageAtLeast,
  trustIdentityHash,
  TrustBeneficiaryStateStore
} from '../../../src/trust/trust-beneficiary-state';

test.describe.configure({ mode: 'serial', retries: 0 });
test.skip(!env.allowClientMutationTests || !env.allowAdminMutationTests,
  'Trust Beneficiary creation requires Client and Admin mutation switches for full-journey preflight.');

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for Trust Beneficiary.`);
  return value;
}

test('TRUST-BEN-002 Client创建唯一受益人并读取其银行账户表单', {
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
  expect(testInfo.retry).toBe(0);
  expect(testInfo.repeatEachIndex).toBe(0);

  const sourceRunId = env.personalRegistration.adminApprovalSourceRunId ?? 'REGP-20260904020924';
  const source = new PersonalJourneyContextStore().load(sourceRunId);
  if (!source?.displayName || !source.email || source.stage !== 'COMPLETED') throw new Error('Completed Personal source is required.');
  const runId = process.env.TRUST_BENEFICIARY_RUN_ID?.trim() || 'TBEN-20260908-AH-01';
  const data = buildTrustBeneficiaryTestData(runId);
  const store = new TrustBeneficiaryStateStore(runId);
  let state = store.initialize({
    runId, sourceRunId, sourceUserHash: trustIdentityHash(source.email), beneficiaryName: data.name,
    beneficiaryEmailHash: trustIdentityHash(data.email), beneficiaryIdSuffix: data.idNumber.slice(-4),
    bankAccountSuffix: data.bank.accountNumber.slice(-4)
  });
  if (state.sourceUserHash !== trustIdentityHash(source.email) || state.beneficiaryName !== data.name) {
    throw new Error('Resume state does not belong to the selected Personal Trust context.');
  }

  business.case({ caseId: 'TRUST-BEN-002-CLIENT', module: 'Trust Beneficiary',
    name: '现有Personal信托创建唯一受益人', priority: 'P0', type: ['E2E', 'Mutation', 'Resume'],
    scope: 'Client + Admin Preflight', preconditions: ['现有Personal用户KYC正常且已有信托', '双端认证有效'],
    expectedResult: 'Client只创建一个唯一受益人，并打开同一受益人的银行账户表单。',
    changesData: true, affectsMoney: false, dependsOnAdmin: true, dependsOnThirdParty: false,
    safetySwitches: ['ALLOW_CLIENT_MUTATION_TESTS', 'ALLOW_ADMIN_MUTATION_TESTS'] });
  business.disallowSafeRerun();
  business.setResumeState(state.stage);
  business.setBusinessData({ runId, sourceRunId, user: source.displayName,
    email: maskRegistrationEmail(source.email), beneficiaryName: data.name,
    beneficiaryRelationship: data.relationship, beneficiaryPercentage: data.percentage,
    beneficiaryIdSuffix: `****${data.idNumber.slice(-4)}`, bankAccountSuffix: `****${data.bank.accountNumber.slice(-4)}`,
    clientCreateCount: state.beneficiaryCreateCount, adminMutationClicks: 0 });

  const client = await openPersonalJourneyClientSession({ browser, baseURL: clientBaseUrl, runId: sourceRunId,
    email: source.email, password: required('CLIENT_PASSWORD', env.client.password), otp: required('CLIENT_OTP', env.client.otp) });
  const trust = new TrustBeneficiaryPage(client.page);
  const adminTrust = new AdminTrustManagementPage(adminPage);
  const guard = new MoneyMutationGuard('TRUST-BENEFICIARY-CREATE', true, false);
  const switches = { ALLOW_CLIENT_MUTATION_TESTS: env.allowClientMutationTests, ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests };
  guard.validateRuntime({ baseURL: clientBaseUrl, workers: testInfo.config.workers, retries: testInfo.project.retries,
    repeatEach: testInfo.project.repeatEach, safetySwitches: switches });

  try {
    await business.step({ action: '1. 双端认证及原信托唯一预检', expected: 'Client原Personal信托可访问；Admin同一用户/信托候选严格为1' }, async context => {
      await trust.goto(clientBaseUrl);
      const trustNumber = await trust.readTrustNumber();
      if (state.trustNumber && state.trustNumber !== trustNumber) throw new Error('Resume Trust Number changed.');
      if (!state.trustNumber) { state = { ...state, trustNumber }; store.save(state); }
      const shell = new AdminShellPage(adminPage);
      await shell.goto(adminBaseUrl);
      await shell.expectSessionActive();
      await adminTrust.goto(adminBaseUrl);
      const candidate = await adminTrust.locateUnique({ email: source.email, trustNumber });
      expect(candidate.trustNumber).toBe(trustNumber);
      guard.markAuthenticationReady(true, true);
      business.setBusinessData({ trustNumber, candidateCount: 1 });
      context.recordPrimaryOracle({ id: 'trust-context', name: '同一用户信托', expected: 'Admin候选1', actual: '候选1且Trust Number一致', status: 'passed' });
      context.setActual('Client/Admin认证有效；同一Personal信托候选=1。');
    });

    await business.step({ action: '2. Client创建唯一受益人一次', expected: '表单字段按真实DOM填写；提交一次；页面出现同一受益人' }, async context => {
      await trust.goto(clientBaseUrl);
      if (!trustBeneficiaryStageAtLeast(state.stage, 'BENEFICIARY_CREATE_ATTEMPTED')) {
        expect(await trust.beneficiaryExists(data.name)).toBe(false);
        await trust.openAddBeneficiary();
        await trust.fillBeneficiary(data);
        guard.assertClientSubmissionAllowed(switches);
        state = store.advance(state, 'BENEFICIARY_CREATE_ATTEMPTED', {
          beneficiaryConfirmationClickCount: 1, beneficiarySubmittedAt: new Date().toISOString()
        });
        const submission = await trust.submitBeneficiaryOnce(
          data,
          required('CLIENT_SECURITY_KEY', env.client.securityKey)
        );
        business.markPotentiallySubmitted();
        business.markMutationPerformed('Security Key verified for Trust Beneficiary creation');
        guard.recordClientSubmission();
        business.setBusinessData({
          safeRequestEvidence: submission.evidence,
          clientMutationResponseCount: submission.mutationResponseCount,
          clientBeneficiaryRecordObserved: submission.recordVisible,
          beneficiaryConfirmationClickCount: 1,
          securityVerificationClicks: submission.securityVerificationCount,
          clientCreateCount: submission.recordVisible ? 1 : 0
        });
        if (!submission.recordVisible) {
          state = store.advance(state, 'BENEFICIARY_POST_SECURITY_UNCONFIRMED', {
            securityDialogObserved: true,
            securityVerificationCount: 1
          });
          testInfo.annotations.push({ type: 'blocker', description: 'BENEFICIARY_CREATION_UNCONFIRMED' });
          throw new Error(
            `BENEFICIARY_CREATION_UNCONFIRMED: submit clicked once; mutationResponses=${submission.mutationResponseCount}; ` +
            `requestPath=${submission.evidence?.path ?? 'not-observed'}; httpStatus=${submission.evidence?.status ?? 'not-observed'}.`
          );
        }
        state = store.advance(state, 'BENEFICIARY_CREATED', {
          beneficiaryCreateCount: 1,
          securityDialogObserved: true,
          securityVerificationCount: 1,
          beneficiaryStatus: await trust.beneficiaryStatus(data.name)
        });
      } else if (!trustBeneficiaryStageAtLeast(state.stage, 'BENEFICIARY_CREATED')) {
        const exists = await trust.beneficiaryExists(data.name);
        if (!exists) {
          if (state.stage === 'BENEFICIARY_CREATE_ATTEMPTED') {
            state = store.advance(state, 'BENEFICIARY_CREATION_UNCONFIRMED');
          }
          business.setBusinessData({
            clientBeneficiaryRecordObserved: false,
            noDuplicateBeneficiaryCreated: true,
            blockerReason: 'BENEFICIARY_CREATION_UNCONFIRMED'
          });
          testInfo.annotations.push({ type: 'blocker', description: 'BENEFICIARY_CREATION_UNCONFIRMED' });
          throw new Error('BENEFICIARY_CREATION_UNCONFIRMED: Client reload still shows no matching Beneficiary; second submit is forbidden.');
        }
        await trust.expectBeneficiaryVisible(data.name);
        state = store.advance(state, 'BENEFICIARY_CREATED', {
          beneficiaryStatus: await trust.beneficiaryStatus(data.name)
        });
      } else {
        await trust.expectBeneficiaryVisible(data.name);
      }
      expect(state.beneficiaryCreateCount).toBe(1);
      business.setResumeState(state.stage);
      context.recordPrimaryOracle({ id: 'beneficiary-created', name: '唯一受益人创建', expected: '创建一次且页面存在', actual: `创建次数1；状态${state.beneficiaryStatus ?? '页面已记录'}`, status: 'passed' });
      context.setActual(`受益人创建次数1；页面唯一显示${data.name}；未创建第二个受益人。`);
    });

    await business.step({ action: '3. 打开同一受益人的银行账户表单', expected: '按唯一受益人定位，不提交银行账户，读取真实字段用于同Run继续' }, async context => {
      await trust.goto(clientBaseUrl);
      await trust.openAddBankAccount(data.name);
      const form = await trust.inspectOpenBankForm();
      console.log(`TRUST_BEN_BANK_FORM=${JSON.stringify(form)}`);
      business.setBusinessData({ approvalRequiredFields: form.labels, remainingRequiredFields: form.placeholders });
      context.setActual(`同一受益人银行账户表单已打开；识别${form.placeholders.length}个输入字段和${form.labels.length}个标签；银行账户提交0次。`);
    });
  } finally {
    await client.context.close();
    business.setResumeState(state.stage);
  }
});
