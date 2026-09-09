import { AdminFiatAccountReviewPage } from '../../../pages/admin/AdminFiatAccountReviewPage';
import {
  BankAccountManagementPage,
  type SandboxBankAccountInput
} from '../../../pages/client/BankAccountManagementPage';
import { expect, test } from '../../../fixtures/registration.fixture';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment, MoneyMutationGuard } from '../../../src/flow-engine';
import {
  PersonalPostRegistrationJourneyStore,
  postRegistrationStageAtLeast
} from '../../../src/journey';
import {
  maskRegistrationEmail,
  openPersonalJourneyClientSession,
  PersonalJourneyContextStore
} from '../../../src/registration';
import { getClientSecurityKey } from '../../../src/utils/security-key';

test.describe.configure({ mode: 'serial', retries: 0 });
test.skip(
  !env.allowClientMutationTests || !env.allowAdminMutationTests,
  'Personal Golden Journey Fiat Address requires both Client and Admin mutation switches.'
);

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for Personal Golden Journey Fiat Address.`);
  return value;
}

function buildBankAccountInput(sequence: number, displayName: string): SandboxBankAccountInput {
  const sequenceText = String(sequence).padStart(4, '0');
  return {
    accountHolderName: displayName,
    beneficiaryCountry: '中国香港特别行政区',
    city: 'HONG KONG',
    address: 'FIDERE SANDBOX AUTOMATION ADDRESS',
    bankCountry: '中国香港特别行政区',
    bankName: `FIDERE SANDBOX BANK ${displayName.split(' ').at(-1)}`,
    bankAddress: 'FIDERE SANDBOX BANK ADDRESS',
    bankAccount: `88000000${sequenceText}`,
    swiftCode: 'SBOXHKHH'
  };
}

test(
  'Personal Golden Journey 法币银行地址创建并审核通过',
  {
    tag: ['@journey', '@personal', '@fiat-address', '@resume', '@mutation', '@L4'],
    annotation: [
      { type: 'caseId', description: 'PERSONAL-GJ-FIAT-ADDRESS' },
      { type: 'changesData', description: 'true' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ browser, adminPage, business }, testInfo) => {
    test.setTimeout(5 * 60 * 1000);
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
    if (!source?.displayName || !source.sequence) {
      throw new Error('The approved Personal Journey source user is incomplete.');
    }
    const store = new PersonalPostRegistrationJourneyStore(sourceRunId);
    const initialState = store.load();
    if (!initialState || !postRegistrationStageAtLeast(initialState.stage, 'CLIENT_USABLE')) {
      throw new Error('The source Personal user has not reached CLIENT_USABLE.');
    }
    let state = initialState;

    const input = buildBankAccountInput(source.sequence, source.displayName);
    const accountSuffix = input.bankAccount.slice(-4);
    const guard = new MoneyMutationGuard('PERSONAL-GJ-FIAT-ADDRESS', true, true);
    guard.validateRuntime({
      baseURL: clientBaseUrl,
      workers: testInfo.config.workers,
      retries: testInfo.project.retries,
      repeatEach: testInfo.project.repeatEach,
      safetySwitches: {
        ALLOW_CLIENT_MUTATION_TESTS: env.allowClientMutationTests,
        ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests
      }
    });

    business.case({
      caseId: 'PERSONAL-GJ-FIAT-ADDRESS',
      module: 'Fresh Personal Golden Journey',
      name: '法币银行地址创建并审核通过',
      description: '同一已通过KYC的Personal用户创建唯一Sandbox银行账户，并由Admin唯一定位后通过。',
      priority: 'P0',
      type: ['E2E', 'Mutation', 'Resume'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'Fiat bank address approval',
      preconditions: ['Personal KYC已通过', 'Client与Admin认证有效', 'Sandbox Mutation开关显式开启'],
      target: '银行账户在Client创建一次、Admin通过一次，并回写为已通过。',
      expectedResult: 'Client银行账户存在且状态已通过；Admin候选严格唯一。',
      changesData: true,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: false,
      safetySwitches: ['ALLOW_CLIENT_MUTATION_TESTS', 'ALLOW_ADMIN_MUTATION_TESTS']
    });
    business.disallowSafeRerun();
    business.setBusinessData({
      journeyId: state.journeyId,
      sourceRunId,
      user: source.displayName,
      email: maskRegistrationEmail(source.email),
      bankCountry: input.bankCountry,
      bankName: input.bankName,
      bankAccountSuffix: `****${accountSuffix}`,
      swiftCode: input.swiftCode,
      resumeStartStage: state.stage,
      clientCreateCount: state.fiatAddressCreateCount,
      adminApproveCount: state.fiatAddressApproveCount
    });

    const client = await openPersonalJourneyClientSession({
      browser,
      baseURL: clientBaseUrl,
      runId: sourceRunId,
      email: source.email,
      password: required('CLIENT_PASSWORD', env.client.password),
      otp: required('CLIENT_OTP', env.client.otp)
    });
    const bankAccounts = new BankAccountManagementPage(client.page);
    const adminFiatAccounts = new AdminFiatAccountReviewPage(adminPage);
    let candidateCount = 0;

    try {
      await business.step(
        {
          action: '1. 双端认证、Sandbox与重复数据预检',
          expected: 'Client可进入银行账户管理；Admin待审核页可访问；本次唯一账号尚不存在或属于当前Resume。'
        },
        async context => {
          await bankAccounts.gotoFromProfileMenu(clientBaseUrl);
          await adminFiatAccounts.goto(adminBaseUrl, '待审核');
          guard.markAuthenticationReady(true, true);

          if (!postRegistrationStageAtLeast(state.stage, 'FIAT_ADDRESS_CREATE_ATTEMPTED')) {
            const clientExisting = await bankAccounts.readAccountStatus(input.bankAccount, input.bankName);
            expect(clientExisting).toBeUndefined();
            const adminExisting = await adminFiatAccounts.locateCandidate({
              email: source.email,
              displayName: source.displayName!,
              bankName: input.bankName,
              bankAccount: input.bankAccount
            });
            expect(adminExisting.candidateCount).toBe(0);
          }
          context.setActual('Client/Admin认证有效；当前同一Journey和唯一Sandbox银行账号已锁定。');
        }
      );

      await business.step(
        {
          action: '2. Client单次创建法币银行账户',
          expected: '通过头像→设置→银行账户管理创建一次；页面出现本次账号，且保存安全请求元信息。'
        },
        async context => {
          await bankAccounts.gotoFromProfileMenu(clientBaseUrl);
          const switches = {
            ALLOW_CLIENT_MUTATION_TESTS: env.allowClientMutationTests,
            ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests
          };
          if (!postRegistrationStageAtLeast(state.stage, 'FIAT_ADDRESS_CREATE_ATTEMPTED')) {
            guard.assertClientMoneyConfirmationAllowed(switches);
            await bankAccounts.openAddForm();
            await bankAccounts.fill(input);
            await bankAccounts.expectFilled(input);
            const configuredSecurityKey = getClientSecurityKey();
            const initialSecurityKeyDom = await bankAccounts.openSecurityKeyDialogOnce();
            expect([1, 6]).toContain(initialSecurityKeyDom.visibleInputCount);
            const securityKeySetupRequired = initialSecurityKeyDom.buttonLabels.includes('下一步');
            let securityKeySetupActionClicks = 0;
            if (securityKeySetupRequired) {
              const setupEvidence = await bankAccounts.securityKey.completeSetupWizard(configuredSecurityKey);
              expect(setupEvidence.dialogClosed).toBe(true);
              securityKeySetupActionClicks = setupEvidence.actionClickCount;
              const verificationDom = await bankAccounts.openVerificationAfterSecurityKeySetupOnce(input);
              expect([1, 6]).toContain(verificationDom.visibleInputCount);
            }
            await bankAccounts.fillSecurityKey(configuredSecurityKey);
            guard.recordClientMoneyConfirmation();
            guard.assertSecurityKeyVerificationAllowed(switches);
            state = store.recordFiatAddressCreateAttempt(state, accountSuffix);
            business.markMutationPerformed('Client Fiat Bank Account Security Key Verification');
            let evidence;
            try {
              evidence = await bankAccounts.verifySecurityKeyOnce(input);
            } finally {
              if (bankAccounts.securityVerificationClicks() === 1) {
                guard.recordSecurityKeyVerification();
              }
            }
            guard.assertClientSubmissionAllowed(switches);
            guard.recordClientSubmission();
            expect(bankAccounts.submissionClicks()).toBe(1);
            expect(bankAccounts.securityVerificationClicks()).toBe(1);
            if (evidence.httpStatus !== undefined) {
              expect(evidence.httpStatus).toBeGreaterThanOrEqual(200);
              expect(evidence.httpStatus).toBeLessThan(300);
            }
            state = store.advance(state, 'FIAT_ADDRESS_CREATED', {
              fiatAddressReference: `bank-account-****${accountSuffix}`,
              fiatAddressSubmittedAt: evidence.observedAt ?? new Date().toISOString()
            });
            context.setBusinessData({
              clientCreateCount: state.fiatAddressCreateCount,
              clientRequestPath: evidence.requestPath,
              clientHttpStatus: evidence.httpStatus,
              clientSubmittedAt: state.fiatAddressSubmittedAt,
              securityKeyVerification: 'Passed',
              securityKeySetupRequired,
              securityKeySetupActionClicks,
              formSubmitClicks: bankAccounts.formSubmitClicks(),
              resumeStage: state.stage
            });
          } else {
            await bankAccounts.expectAccountVisible(input.bankAccount, input.bankName);
            guard.recordClientMoneyConfirmation();
            guard.recordSecurityKeyVerification();
            guard.recordClientSubmission();
            if (!postRegistrationStageAtLeast(state.stage, 'FIAT_ADDRESS_CREATED')) {
              state = store.advance(state, 'FIAT_ADDRESS_CREATED', {
                fiatAddressReference: `bank-account-****${accountSuffix}`,
                fiatAddressSubmittedAt: state.fiatAddressSubmittedAt ?? new Date().toISOString()
              });
            }
          }
          context.recordPrimaryOracle({
            id: 'PGJ-FIAT-P1',
            name: 'Client银行账户创建',
            expected: '创建次数=1且本次账号可见',
            actual: `创建次数=${state.fiatAddressCreateCount}；账号尾号=****${accountSuffix}`,
            status: 'passed'
          });
          context.setActual('Client本次银行账户已创建且页面可见；没有创建第二条。');
        }
      );

      await business.step(
        {
          action: '3. Admin唯一定位并二次核对法币账户',
          expected: '以邮箱搜索，再以用户、银行、完整账号和持有人形成指纹；candidateCount严格等于1。'
        },
        async context => {
          let located: Awaited<ReturnType<typeof adminFiatAccounts.locateCandidate>> | undefined;
          const adminListStatus = postRegistrationStageAtLeast(
            state.stage,
            'FIAT_ADDRESS_APPROVAL_ATTEMPTED'
          ) ? '已通过' : '待审核';
          await expect.poll(async () => {
            await adminFiatAccounts.goto(adminBaseUrl, adminListStatus);
            located = await adminFiatAccounts.locateCandidate({
              email: source.email,
              displayName: source.displayName!,
              bankName: input.bankName,
              bankAccount: input.bankAccount
            });
            return located.candidateCount;
          }, {
            timeout: 60_000,
            intervals: [1_000, 2_000, 5_000],
            message: 'The submitted Fiat Account did not become one unique Admin candidate.'
          }).toBe(1);
          candidateCount = located!.candidateCount;
          guard.recordUniqueAdminCandidate(candidateCount);
          await adminFiatAccounts.openUnique(located!.candidates[0]);
          await adminFiatAccounts.verifyDetail({
            email: source.email,
            displayName: source.displayName!,
            bankName: input.bankName,
            bankAccount: input.bankAccount,
            swiftCode: input.swiftCode,
            expectApprovalAction: adminListStatus === '待审核'
          });
          state = {
            ...state,
            fiatAddressReference: located!.candidates[0].accountId || state.fiatAddressReference
          };
          store.save(state);
          context.setBusinessData({
            adminCandidateCount: candidateCount,
            fiatAddressReference: located!.candidates[0].accountId,
            resumeStage: state.stage
          });
          context.recordPrimaryOracle({
            id: 'PGJ-FIAT-P2',
            name: 'Admin候选唯一且详情匹配',
            expected: 'candidateCount=1；用户、银行、账号和SWIFT一致',
            actual: 'candidateCount=1；详情二次核对通过',
            status: 'passed'
          });
          context.setActual(`Admin${adminListStatus}候选唯一，详情中的用户、银行、账号尾号和SWIFT全部匹配。`);
        }
      );

      await business.step(
        {
          action: '4. Admin单次审核通过',
          expected: '通过动作最多一次，安全请求成功，原记录进入已通过列表。'
        },
        async context => {
          if (!postRegistrationStageAtLeast(state.stage, 'FIAT_ADDRESS_APPROVAL_ATTEMPTED')) {
            guard.assertAdminActionAllowed({
              ALLOW_CLIENT_MUTATION_TESTS: env.allowClientMutationTests,
              ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests
            });
            state = store.recordFiatAddressApprovalAttempt(state);
            business.markMutationPerformed('Admin Fiat Account Approve');
            const evidence = await adminFiatAccounts.approveOnce();
            guard.recordAdminAction();
            expect(evidence.approvalEntryClicks).toBe(1);
            expect(evidence.httpStatus).toBeGreaterThanOrEqual(200);
            expect(evidence.httpStatus).toBeLessThan(300);
            context.setBusinessData({
              adminApproveCount: state.fiatAddressApproveCount,
              adminRequestPath: evidence.requestPath,
              adminHttpStatus: evidence.httpStatus,
              adminConfirmationClicks: evidence.approvalConfirmationClicks,
              resumeStage: state.stage
            });
          }

          await expect.poll(async () => {
            await adminFiatAccounts.goto(adminBaseUrl, '已通过');
            return (await adminFiatAccounts.locateCandidate({
              email: source.email,
              displayName: source.displayName!,
              bankName: input.bankName,
              bankAccount: input.bankAccount
            })).candidateCount;
          }, {
            timeout: 60_000,
            intervals: [1_000, 2_000, 5_000],
            message: 'The Fiat Account did not enter the Admin approved list.'
          }).toBe(1);
          context.setActual('Admin审核通过仅提交一次，原法币账户已进入“已通过”列表。');
        }
      );

      await business.step(
        {
          action: '5. Client验证银行账户审核结果',
          expected: '同一银行账户状态回写为已通过，并可供后续入金链路使用。'
        },
        async context => {
          await bankAccounts.gotoFromProfileMenu(clientBaseUrl);
          await bankAccounts.expectAccountVisible(input.bankAccount, input.bankName);
          let clientStatus: string | undefined;
          try {
            await expect.poll(async () => {
              clientStatus = await bankAccounts.readAccountStatus(input.bankAccount, input.bankName);
              return clientStatus;
            }, {
              timeout: 20_000,
              intervals: [1_000, 2_000, 5_000],
              message: 'Client Fiat Account approval label was not observable.'
            }).toBe('已批准');
          } catch {
            context.recordDiagnostic({
              id: 'PGJ-FIAT-D1',
              name: 'Client银行账户批准标签',
              status: 'unavailable',
              summary: 'Admin唯一记录已通过，但Client绿色“已批准”标签暂未被自动化读取。',
              reason: '后续入金以Admin已通过记录为核心前置。',
              affectsCoreBusiness: false
            });
          }
          if (!postRegistrationStageAtLeast(state.stage, 'FIAT_ADDRESS_APPROVED')) {
            state = store.advance(state, 'FIAT_ADDRESS_APPROVED');
          }
          context.recordSecondaryOracle({
            id: 'PGJ-FIAT-P3',
            name: 'Client法币账户状态回写',
            expected: '已批准',
            actual: clientStatus ?? '未读取到标签',
            status: clientStatus === '已批准' ? 'passed' : 'failed'
          });
          context.setBusinessData({
            clientFinalStatus: clientStatus ?? 'Admin已通过；Client标签未读取',
            resumeEndStage: state.stage,
            noNewUserCreated: true,
            confirmed: true
          });
          context.setActual(
            clientStatus === '已批准'
              ? 'Client原银行账户已显示“已批准”；法币地址闭环完成。'
              : 'Admin唯一银行地址记录已通过；Client标签作为Diagnostic，不阻塞后续入金。'
          );
        }
      );
    } catch (error) {
      business.setBusinessData({
        resumeStage: state.stage,
        clientCreateCount: state.fiatAddressCreateCount,
        adminApproveCount: state.fiatAddressApproveCount,
        adminCandidateCount: candidateCount,
        noNewUserCreated: true,
        confirmed: false
      });
      if (
        postRegistrationStageAtLeast(state.stage, 'FIAT_ADDRESS_CREATE_ATTEMPTED') &&
        !postRegistrationStageAtLeast(state.stage, 'FIAT_ADDRESS_APPROVED')
      ) {
        business.requireManualReview('原银行账户、Admin审核状态和Client当前状态');
      }
      throw error;
    } finally {
      await client.context.close();
    }
  }
);
