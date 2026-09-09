import { AccountOpeningReviewPage, type AccountOpeningAdminRecord } from '../../../pages/admin/AccountOpeningReviewPage';
import { AccountTypeConfigurationPage } from '../../../pages/admin/AccountTypeConfigurationPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { JurisdictionAccountChooserPage } from '../../../pages/client/JurisdictionAccountChooserPage';
import { UsAccountOpeningPage } from '../../../pages/client/UsAccountOpeningPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { resolveUsOpeningDocumentAssets } from '../../../src/account-opening/account-opening-assets';
import {
  ACCOUNT_OPENING_PRIMARY_ORACLES,
  US_ACCOUNT_OPENING_FLOW_ID,
  UsAccountOpeningExecutionGuard,
  activeUsAccountOpeningStates,
  advanceUsAccountOpeningState,
  diagnoseAccountOpeningCandidates
} from '../../../src/account-opening/account-opening-e2e';
import { runUsAccountOpeningFeePreflight } from '../../../src/account-opening/us-account-opening-fee-preflight';
import { env } from '../../../src/config/env';
import {
  FlowStateStore,
  assertSandboxEnvironment,
  matchesConfiguredCustomerIdentity,
  stageIndex,
  type FlowResumeState
} from '../../../src/flow-engine';
import { maskBusinessId } from '../../../src/reporting/sensitive-data-mask';
import { Decimal } from '../../../src/utils/money';
import { getClientSecurityKey } from '../../../src/utils/security-key';

const PENDING_ADMIN_STATUS = '待提交';
const FIDERE_APPROVED_STATUS = /审核通过|已通过|已批准/;
const MATCH_WINDOW_MS = 20 * 60 * 1000;
const BAAS_POLL_TIMEOUT_MS = 5 * 60 * 1000;

type BaasObservation = {
  stage: 'BAAS_PENDING' | 'BAAS_FAILED' | 'BAAS_APPROVED' | 'CONFLICT';
  clientStatus: string;
  adminStatus: string;
  failureReason?: string;
};

test.describe.configure({ mode: 'serial', retries: 0 });
test.skip(
  !env.exchange.allowMoneyTests || !env.allowAdminMutationTests,
  'OPEN-US-003 Resume requires both mutation safety switches in this process.'
);

function safetySwitchValues(): Record<string, boolean> {
  return {
    ALLOW_MONEY_TESTS: env.exchange.allowMoneyTests,
    ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests
  };
}

function requireResumeState(store: FlowStateStore): FlowResumeState {
  const states = activeUsAccountOpeningStates(store);
  if (states.length !== 1) {
    throw new Error(`OPEN-US-003 Resume requires exactly one active state; received ${states.length}.`);
  }
  const state = states[0];
  if (state.stage !== 'CLIENT_FEE_CONFIRMATION_REQUIRED') {
    throw new Error(
      `OPEN-US-003 Fee Resume requires CLIENT_FEE_CONFIRMATION_REQUIRED; received ${state.stage}.`
    );
  }
  return state;
}

test(
  'OPEN-US-003 Resume 美国账户开户完整成功闭环',
  {
    tag: ['@e2e', '@account-opening', '@us', '@resume', '@mutation', '@money', '@external', '@L5'],
    annotation: [
      { type: 'caseId', description: 'OPEN-US-003-RESUME' },
      { type: 'flowId', description: US_ACCOUNT_OPENING_FLOW_ID },
      { type: 'changesData', description: 'true' },
      { type: 'affectsMoney', description: 'true' }
    ]
  },
  async ({ clientPage, adminPage, business }, testInfo) => {
    test.setTimeout(9 * 60 * 1000);
    if (
      !env.client.baseUrl ||
      !env.admin.baseUrl ||
      !env.accountOpening.testEmail ||
      !env.client.securityKey
    ) {
      throw new Error('OPEN-US-003 Resume requires Client/Admin URLs and all OPENING_* settings.');
    }

    const switches = safetySwitchValues();
    const guard = new UsAccountOpeningExecutionGuard();
    guard.validateRuntime({
      baseURL: env.client.baseUrl,
      workers: testInfo.config.workers,
      retries: testInfo.project.retries,
      repeatEach: testInfo.project.repeatEach,
      safetySwitches: switches
    });
    assertSandboxEnvironment(env.admin.baseUrl);
    expect(testInfo.retry).toBe(0);
    expect(testInfo.repeatEachIndex).toBe(0);

    const stateStore = new FlowStateStore();
    let state = requireResumeState(stateStore);
    const resumeStartStage = state.stage;
    const assets = resolveUsOpeningDocumentAssets();
    const chooser = new JurisdictionAccountChooserPage(clientPage);
    const application = new UsAccountOpeningPage(clientPage);
    const reviews = new AccountOpeningReviewPage(adminPage);
    const accountTypes = new AccountTypeConfigurationPage(adminPage);
    let candidateLocated = false;
    let fidereStatusConfirmed = false;
    let currentCandidate: AccountOpeningAdminRecord | undefined;

    business.flow(US_ACCOUNT_OPENING_FLOW_ID, {
      caseId: 'OPEN-US-003-RESUME',
      name: 'OPEN-US-003 Resume 美国账户开户完整成功闭环',
      description: '从现有CLIENT_FEE_CONFIRMATION_REQUIRED草稿继续，不重新上传、不重复签名、不创建第二条申请。',
      preconditions: [
        '唯一OPEN-US-003 Resume状态存在',
        '五份Sandbox资料与Documenso签署已在原草稿中完成',
        'Client与Admin认证有效',
        '两个Mutation开关仅在本进程开启'
      ],
      target: '只Resume原美国开户草稿，经开户费、安全密钥、Fidere Admin和Interlace/BaaS完成开户。'
    });
    business.disallowSafeRerun();
    business.setBusinessData({
      runId: state.runId,
      resumeMode: 'OPEN-US-003 Resume',
      resumeStartStage,
      documentsUploaded: true,
      signatureFieldsCompleted: true,
      fieldsRemaining: 0,
      documensoCompleted: true,
      documensoCompleteClicks: 0,
      documensoSigningConfirmationClicks: 0,
      openFeeConfirmationCount: 0,
      feeConfirmationClickCount: 0,
      securityVerificationClicks: 0,
      applicationCreateCount: 0,
      clientSubmitted: false,
      finalSubmissionClicks: 0,
      adminApproved: false,
      adminOpeningApprovalClicks: 0,
      candidateCount: 0,
      noSecondOpeningApplication: true,
      noRepeatedDocumentSigning: true,
      resumeStage: state.stage,
      confirmed: false
    });

    try {
      const feePreflight = await business.step(
        {
          action: '1. Resume前读取原草稿开户费、付款账户和扣费前余额',
          expected: '双端认证有效、Documenso已完成、Admin无美国申请、Interlace启用、页面开户费可读且付款账户USD余额充足'
        },
        async context => {
          const preflight = await runUsAccountOpeningFeePreflight({
            clientPage,
            adminPage,
            clientBaseUrl: env.client.baseUrl!,
            adminBaseUrl: env.admin.baseUrl!,
            customerIdentity: env.accountOpening.testEmail!,
            assets,
            guard,
            chooser,
            application,
            reviews,
            accountTypes
          });

          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P1',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[0],
            expected: '原草稿5份资料仍存在',
            actual: '5份资料均有持久化上传证据，未重新上传',
            status: 'passed'
          });
          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P2',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[1],
            expected: 'Documenso已正式完成',
            actual: `Fidere签署状态=${preflight.taxFormStatus}`,
            status: 'passed'
          });
          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P11',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[10],
            expected: '从真实弹窗读取正数开户费',
            actual: `${preflight.fee.currency} ${preflight.fee.openingFeeAmount.toString()}`,
            status: 'passed'
          });
          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P12',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[11],
            expected: '付款账户余额不少于页面开户费',
            actual: `${preflight.feeBalanceAccountType}余额=${preflight.feeBalanceBefore} ${preflight.fee.currency}`,
            status: 'passed'
          });
          context.setBusinessData({
            existingUsOpeningApplicationCount: preflight.existingUsApplicationCount,
            usOpeningStatusBefore: preflight.clientStatus,
            documentsUploaded: true,
            openingDocumentAssetCount: preflight.persistedDocumentCount,
            taxFormStatus: preflight.taxFormStatus,
            signatureFieldsCompleted: true,
            fieldsRemaining: 0,
            documensoCompleted: true,
            documensoCompleteClicks: 0,
            documensoSigningConfirmationClicks: 0,
            noRepeatedDocumentSigning: true,
            usOpeningChannel: preflight.channel,
            usOpeningChannelEnabled: preflight.channelEnabled,
            openingFeeCurrency: preflight.fee.currency,
            openingFeeAmount: preflight.fee.openingFeeAmount.toString(),
            openingFeePaymentAccount: preflight.fee.paymentAccount,
            openingFeeBalanceAccountType: preflight.feeBalanceAccountType,
            feeBalanceBefore: preflight.feeBalanceBefore,
            feeBalanceSufficient: preflight.balanceSufficient,
            feeConfirmationButtonText: preflight.fee.confirmButtonText,
            openingFeeDescription: preflight.fee.feeDescription,
            openFeeConfirmationCount: application.openFeeConfirmationClickCount(),
            feeConfirmationClickCount: 0,
            securityVerificationClicks: 0,
            applicationCreateCount: 0,
            resumeStage: state.stage
          });
          context.setActual('原草稿资料和Documenso完成状态保留；真实开户费、付款账户与USD余额可读，Admin认证及Interlace配置有效。');
          return preflight;
        }
      );

      let submittedAt = new Date();
      let feeBalanceAfter = new Decimal(feePreflight.feeBalanceBefore);
      let observedFeeDebit = new Decimal(0);
      await business.step(
        {
          action: '2. 单次确认开户费并单次完成安全密钥验证',
          expected: '确认扣费和安全密钥验证各1次；实际扣款等于页面开户费，随后只创建一条Client申请'
        },
        async context => {
          guard.assertFeeConfirmationAllowed(switches);
          context.markPotentiallySubmitted();
          context.disallowSafeRerun();
          try {
            await application.confirmOpeningFeeOnce();
          } finally {
            if (application.feeConfirmationClickCount() === 1) {
              guard.recordFeeConfirmationClick();
              state = advanceUsAccountOpeningState(
                stateStore,
                state,
                'FEE_CONFIRMATION_ATTEMPTED'
              );
            }
          }

          const securityKey = getClientSecurityKey();
          await application.securityKey.fill(securityKey);
          guard.assertSecurityKeyVerificationAllowed(switches);
          submittedAt = new Date();
          try {
            await application.securityKey.verifyOnce();
          } finally {
            if (application.securityKey.verificationClickCount() === 1) {
              guard.recordSecurityKeyVerification();
              state = advanceUsAccountOpeningState(
                stateStore,
                state,
                'SECURITY_KEY_VERIFICATION_ATTEMPTED'
              );
            }
          }

          const balancePage = await clientPage.context().newPage();
          try {
            const account = new AccountDetailPage(balancePage);
            await expect.poll(async () => {
              await account.goto(env.client.baseUrl!);
              const balance = await account.readUniqueAvailableBalanceByCurrency(
                feePreflight.fee.currency,
                feePreflight.fee.paymentAccount
              );
              if (balance.accountType !== feePreflight.feeBalanceAccountType) return false;
              feeBalanceAfter = balance.availableBalance;
              observedFeeDebit = new Decimal(feePreflight.feeBalanceBefore).minus(feeBalanceAfter);
              return observedFeeDebit.equals(feePreflight.fee.openingFeeAmount);
            }, {
              intervals: [2_000, 5_000, 10_000],
              timeout: 60_000,
              message: 'Opening fee debit did not match the amount displayed in the confirmation dialog.'
            }).toBe(true);
          } finally {
            await balancePage.close();
          }
          state = advanceUsAccountOpeningState(stateStore, state, 'FEE_CONFIRMED', {
            feeConfirmedAt: new Date().toISOString()
          });

          let applicationEvidence = '等待Admin唯一候选确认Client申请创建';
          let clientEvidence: Awaited<ReturnType<UsAccountOpeningPage['waitForApplicationCreationEvidence']>> | undefined;
          try {
            clientEvidence = await application.waitForApplicationCreationEvidence();
          } catch (error) {
            context.warn('Client未显示独立申请创建证据，将由Admin唯一候选继续确认，绝不再次扣费或验证。');
            applicationEvidence = error instanceof Error ? error.message : String(error);
          }
          if (clientEvidence) {
            guard.assertApplicationCreationAllowed(switches);
            guard.recordApplicationCreated();
            state = advanceUsAccountOpeningState(stateStore, state, 'CLIENT_CREATED', {
              clientSubmittedAt: submittedAt.toISOString()
            });
            applicationEvidence = `${clientEvidence.acknowledgement}:${clientEvidence.route}`;
          }

          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P13',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[12],
            expected: '开户费确认只点击1次',
            actual: `feeConfirmationClickCount=${application.feeConfirmationClickCount()}`,
            status: 'passed'
          });
          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P14',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[13],
            expected: '安全密钥验证只点击1次',
            actual: `securityVerificationClicks=${application.securityKey.verificationClickCount()}`,
            status: 'passed'
          });
          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P15',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[14],
            expected: `实际扣款=${feePreflight.fee.openingFeeAmount.toString()} ${feePreflight.fee.currency}`,
            actual: `${observedFeeDebit.toString()} ${feePreflight.fee.currency}`,
            status: 'passed'
          });
          context.setBusinessData({
            openFeeConfirmationCount: application.openFeeConfirmationClickCount(),
            feeConfirmationClickCount: application.feeConfirmationClickCount(),
            securityVerificationClicks: application.securityKey.verificationClickCount(),
            securityVerificationStatus: 'Passed',
            feeBalanceBefore: feePreflight.feeBalanceBefore,
            feeBalanceAfter: feeBalanceAfter.toString(),
            observedFeeDebit: observedFeeDebit.toString(),
            applicationCreateCount: guard.snapshot().clientSubmissions,
            applicationCreatedAfterFee: guard.snapshot().clientSubmissions === 1,
            clientSubmissionEvidence: applicationEvidence,
            clientSubmittedAt: submittedAt.toISOString(),
            resumeStage: state.stage
          });
          context.setActual('开户费确认和安全密钥验证各执行1次；源账户扣款与页面费用严格一致，后续仅查询原申请。');
        }
      );

      const baselineReferences = feePreflight.baselineReferences;

      currentCandidate = await business.step(
        {
          action: '4. Admin按测试用户、待提交状态和时间窗口唯一定位原申请',
          expected: '候选严格等于1，并取得真实reviewId作为本次Client/Admin申请引用'
        },
        async context => {
          let diagnostics: ReturnType<typeof diagnoseAccountOpeningCandidates> | undefined;
          await expect.poll(async () => {
            await reviews.goto(env.admin.baseUrl!);
            await reviews.searchCustomer(env.accountOpening.testEmail!);
            diagnostics = diagnoseAccountOpeningCandidates(
              await reviews.readRecords(env.accountOpening.testEmail!),
              {
                customerIdentity: env.accountOpening.testEmail!,
                accountType: '美国账户',
                status: PENDING_ADMIN_STATUS,
                submittedAtMs: submittedAt.getTime(),
                matchWindowMs: MATCH_WINDOW_MS
              }
            );
            return diagnostics.candidates.length;
          }, {
            intervals: [2_000, 5_000, 10_000],
            timeout: 120_000,
            message: 'Admin did not expose exactly one resumed US Account Opening candidate.'
          }).toBe(1);

          const candidate = diagnostics!.candidates[0] as AccountOpeningAdminRecord;
          if (!candidate.applicationId || !candidate.detailUrl || !candidate.processUrl) {
            throw new Error('Unique resumed US Account candidate lacks reviewId or action URLs.');
          }
          if (guard.snapshot().clientSubmissions === 0) {
            guard.assertApplicationCreationAllowed(switches);
            guard.recordApplicationCreated();
            if (state.stage !== 'FEE_CONFIRMED') {
              throw new Error(
                `Admin exposed the Client application from unexpected Resume stage ${state.stage}.`
              );
            }
            state = advanceUsAccountOpeningState(stateStore, state, 'CLIENT_CREATED', {
              clientSubmittedAt: submittedAt.toISOString()
            });
          }
          guard.recordUniqueAdminCandidate(1);
          candidateLocated = true;
          state = advanceUsAccountOpeningState(stateStore, state, 'ADMIN_LOCATED', {
            clientReference: candidate.applicationId,
            adminReference: candidate.applicationId
          });
          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P3',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[2],
            expected: 'Client只创建一条美国开户申请',
            actual: 'Admin新增待提交申请恰好1条',
            status: 'passed'
          });
          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P4',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[3],
            expected: 'candidateCount=1',
            actual: 'candidateCount=1',
            status: 'passed'
          });
          context.setBusinessData({
            candidateCount: 1,
            candidateStageCounts: diagnostics!.counts,
            clientApplicationReference: maskBusinessId(candidate.applicationId),
            clientApplicationReferenceSource: 'Admin唯一候选reviewId',
            clientOpeningReference: maskBusinessId(candidate.applicationId),
            adminOpeningReference: maskBusinessId(candidate.applicationId),
            applicationCreateCount: guard.snapshot().clientSubmissions,
            applicationCreatedAfterFee: true,
            resumeStage: state.stage
          });
          context.setActual('Admin候选严格为1；真实reviewId已分别保存为Client申请引用与Admin审核引用。');
          return candidate;
        }
      );

      const detailPage = await business.step(
        {
          action: '5. Admin详情二次核对测试用户、美国账户、资料、FATCA和提交时间',
          expected: '用户、账户类型、5份资料、Documenso文档、时间与待提交状态均对应本次Resume'
        },
        async context => {
          const detailPage = await reviews.openDetail(currentCandidate!);
          const detail = await detailPage.readDetail(currentCandidate!.applicationId!);
          expect(matchesConfiguredCustomerIdentity(detail.customerText, env.accountOpening.testEmail!)).toBe(true);
          expect(detail.accountType).toBe('美国账户');
          expect(detail.uploadedDocumentFields).toHaveLength(5);
          expect(detail.fatcaSectionPresent).toBe(true);
          expect(detail.fatcaDocumentViewAvailable).toBe(true);
          expect(Math.abs(Date.parse(detail.submittedAt) - submittedAt.getTime())).toBeLessThanOrEqual(MATCH_WINDOW_MS);
          expect(currentCandidate!.status).toBe(PENDING_ADMIN_STATUS);
          context.setBusinessData({
            adminOpeningDetailVerified: true,
            adminOpeningUploadedDocumentCount: detail.uploadedDocumentFields.length,
            adminFatcaDocumentAvailable: detail.fatcaDocumentViewAvailable
          });
          context.setActual('Admin详情全部匹配本次Resume申请，允许进入唯一一次Approve。');
          return detailPage;
        }
      );

      const approval = await detailPage.openApproval(currentCandidate);
      let approvalError: unknown;
      await business.step(
        {
          action: '6. 填写Fidere通过审核表单并单次提交Approve',
          expected: '只选择通过审核，最终Approve最多1次，绝不执行平台Reject'
        },
        async context => {
          await approval.fillApprovalForm(`AUTO_OPEN_US_RESUME_${state.runId}`);
          guard.assertAdminApprovalAllowed(switches);
          context.markPotentiallySubmitted();
          context.disallowSafeRerun();
          let result: Awaited<ReturnType<typeof approval.confirmApproveOnce>> | undefined;
          try {
            result = await approval.confirmApproveOnce();
          } catch (error) {
            approvalError = error;
            context.warn('Admin Approve已单次尝试，将只读查询原reviewId确认结果，绝不再次点击。');
          } finally {
            if (approval.approvalClickCount() === 1 && state.stage === 'ADMIN_LOCATED') {
              guard.recordAdminApproval();
              state = advanceUsAccountOpeningState(stateStore, state, 'FIDERE_APPROVAL_ATTEMPTED');
            }
          }
          expect(approval.approvalClickCount()).toBe(1);
          context.setBusinessData({
            adminOpeningApprovalClicks: approval.approvalClickCount(),
            adminApprovalRequestPath: result?.requestPath,
            adminApprovalHttpStatus: result?.httpStatus,
            resumeStage: state.stage
          });
          context.setActual('Fidere Admin Approve只点击1次；平台Reject为0次。');
        }
      );

      await business.step(
        {
          action: '7. 只读确认Fidere已批准并进入Interlace/BaaS阶段',
          expected: '原reviewId进入真实批准状态，随后保存FIDERE_APPROVED、BAAS_SUBMITTED和BAAS_PENDING'
        },
        async context => {
          let approvedRecord: AccountOpeningAdminRecord | undefined;
          await expect.poll(async () => {
            await reviews.goto(env.admin.baseUrl!);
            await reviews.searchCustomer(env.accountOpening.testEmail!);
            approvedRecord = (await reviews.readRecords(env.accountOpening.testEmail!))
              .find(record => record.applicationId === currentCandidate!.applicationId);
            return approvedRecord?.status ?? 'missing';
          }, {
            intervals: [2_000, 5_000, 10_000],
            timeout: 90_000,
            message: 'Resumed Fidere review did not reach an approved status.'
          }).toMatch(FIDERE_APPROVED_STATUS);

          fidereStatusConfirmed = true;
          if (state.stage !== 'FIDERE_APPROVAL_ATTEMPTED') {
            throw new Error(`Unexpected state before Fidere approval confirmation: ${state.stage}.`);
          }
          state = advanceUsAccountOpeningState(stateStore, state, 'FIDERE_APPROVED');
          state = advanceUsAccountOpeningState(stateStore, state, 'BAAS_SUBMITTED');
          state = advanceUsAccountOpeningState(stateStore, state, 'BAAS_PENDING');
          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P5',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[4],
            expected: 'Fidere Admin审核通过',
            actual: approvedRecord!.status,
            status: 'passed'
          });
          context.setBusinessData({
            adminApproved: true,
            fidereStatusAfter: approvedRecord!.status,
            baasSubmissionConfirmed: true,
            resumeStage: state.stage
          });
          context.setActual(`原reviewId状态=${approvedRecord!.status}；已进入Interlace/BaaS受控轮询。`);
        }
      );

      const observeBaas = async (): Promise<BaasObservation> => {
        await chooser.goto(env.client.baseUrl!);
        await chooser.openChooser();
        const clientOption = await chooser.readOption('美国账户');

        await reviews.goto(env.admin.baseUrl!);
        await reviews.searchCustomer(env.accountOpening.testEmail!);
        const adminRecord = (await reviews.readRecords(env.accountOpening.testEmail!))
          .find(record => record.applicationId === currentCandidate!.applicationId);
        if (!adminRecord) {
          return { stage: 'CONFLICT', clientStatus: clientOption.status, adminStatus: 'missing' };
        }
        if (clientOption.status === '已开通') {
          return { stage: 'BAAS_APPROVED', clientStatus: clientOption.status, adminStatus: adminRecord.status };
        }

        const detail = await reviews.openDetail(adminRecord);
        const detailData = await detail.readDetail(adminRecord.applicationId!);
        if (detailData.failureReason || clientOption.status === '失败') {
          return {
            stage: 'BAAS_FAILED',
            clientStatus: clientOption.status,
            adminStatus: adminRecord.status,
            failureReason: detailData.failureReason ?? 'Client显示第三方失败'
          };
        }
        if (/已拒绝/.test(adminRecord.status)) {
          return { stage: 'CONFLICT', clientStatus: clientOption.status, adminStatus: adminRecord.status };
        }
        return { stage: 'BAAS_PENDING', clientStatus: clientOption.status, adminStatus: adminRecord.status };
      };

      const baasPollStartedAt = Date.now();
      let baasObservation: BaasObservation = {
        stage: 'BAAS_PENDING',
        clientStatus: '申请中',
        adminStatus: '审核通过'
      };
      let baasTimedOut = false;
      try {
        await expect.poll(async () => {
          baasObservation = await observeBaas();
          return baasObservation.stage;
        }, {
          intervals: [5_000, 10_000, 20_000],
          timeout: BAAS_POLL_TIMEOUT_MS,
          message: 'Interlace/BaaS did not reach approved or failed state within the controlled Resume window.'
        }).toMatch(/BAAS_APPROVED|BAAS_FAILED|CONFLICT/);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('Interlace/BaaS did not reach')) throw error;
        baasTimedOut = true;
      }

      if (baasTimedOut) {
        testInfo.annotations.push({ type: 'blocker', description: 'BAAS_PENDING' });
        business.disallowSafeRerun();
        business.warn('Fidere已批准，Interlace/BaaS仍处理中；必须Resume原申请。');
        business.setBusinessData({
          baasFinalStatus: 'BAAS_PENDING',
          clientUsAccountFinalStatus: baasObservation.clientStatus,
          resumeStage: state.stage,
          recoveryRequired: false,
          noSecondOpeningApplication: true,
          noRepeatedDocumentSigning: true,
          confirmed: false
        });
        return;
      }

      if (baasObservation.stage === 'CONFLICT') {
        business.requireManualReview('原美国开户reviewId、Admin状态与Client账户状态冲突');
        business.disallowSafeRerun();
        throw new Error(
          `Core Account Opening states conflict: Admin=${baasObservation.adminStatus}, Client=${baasObservation.clientStatus}.`
        );
      }

      if (baasObservation.stage === 'BAAS_FAILED') {
        state = advanceUsAccountOpeningState(stateStore, state, 'BAAS_FAILED');
        testInfo.annotations.push({ type: 'blocker', description: 'OPEN-US-004 Resume Ready' });
        business.disallowSafeRerun();
        business.warn('Interlace/BaaS返回失败；禁止重新Client申请、重新签署或平台Reject。');
        business.setBusinessData({
          baasFinalStatus: 'BAAS_FAILED',
          baasFailureReason: baasObservation.failureReason,
          clientUsAccountFinalStatus: baasObservation.clientStatus,
          resumeStage: state.stage,
          recoveryRequired: true,
          noSecondOpeningApplication: true,
          noRepeatedDocumentSigning: true,
          confirmed: false
        });
        return;
      }

      state = advanceUsAccountOpeningState(stateStore, state, 'BAAS_APPROVED');
      await business.step(
        {
          action: '8. 验证BaaS成功与Client美国账户真实终态',
          expected: 'Client显示美国账户已开通且真实账户总览可以打开'
        },
        async context => {
          await chooser.goto(env.client.baseUrl!);
          await chooser.expectAccountSection('美国账户');
          const route = await chooser.openExistingAccountOverview('美国账户');
          await chooser.openChooser();
          const option = await chooser.readOption('美国账户');
          expect(option.status).toBe('已开通');
          expect(option.actionAvailable).toBe(false);
          state = advanceUsAccountOpeningState(stateStore, state, 'CLIENT_FINALIZED');
          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P6',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[5],
            expected: '申请真实推送Interlace/BaaS',
            actual: 'BaaS已返回成功并使Client美国账户开通',
            status: 'passed'
          });
          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P7',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[6],
            expected: 'BaaS最终成功',
            actual: 'BAAS_APPROVED',
            status: 'passed'
          });
          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P8',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[7],
            expected: 'Client美国账户已开户',
            actual: option.status,
            status: 'passed'
          });
          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P9',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[8],
            expected: '美国账户真实详情可以打开',
            actual: route,
            status: 'passed'
          });
          context.recordSecondaryOracle({
            id: 'OPEN-US-003-S1',
            name: 'BaaS处理耗时在受控轮询窗口内可观测',
            expected: `不超过${BAAS_POLL_TIMEOUT_MS}ms`,
            actual: `${Date.now() - baasPollStartedAt}ms`,
            status: 'passed'
          });
          context.setBusinessData({
            baasFinalStatus: 'BAAS_APPROVED',
            clientUsAccountFinalStatus: option.status,
            usAccountOverviewRoute: route,
            resumeStage: state.stage
          });
          context.setActual('Interlace/BaaS成功、Client美国账户已开通且账户总览可访问。');
        }
      );

      await business.step(
        {
          action: '9. 确认仅新增原申请并完成Resume',
          expected: '仅新增唯一reviewId；本次不重复Documenso，开户费确认、安全密钥验证、Client申请和Admin Approve均各1次；Resume=COMPLETED'
        },
        async context => {
          await reviews.goto(env.admin.baseUrl!);
          await reviews.searchCustomer(env.accountOpening.testEmail!);
          const recordsAfter = await reviews.readRecords(env.accountOpening.testEmail!);
          const referencesAfter = new Set(
            recordsAfter.flatMap(record => record.applicationId ? [record.applicationId] : [])
          );
          const added = [...referencesAfter].filter(reference => !baselineReferences.has(reference));
          expect(added).toEqual([currentCandidate!.applicationId]);
          expect(application.openFeeConfirmationClickCount()).toBe(1);
          expect(application.feeConfirmationClickCount()).toBe(1);
          expect(application.securityKey.verificationClickCount()).toBe(1);
          expect(guard.snapshot().clientSubmissions).toBe(1);
          expect(approval.approvalClickCount()).toBe(1);
          state = advanceUsAccountOpeningState(stateStore, state, 'COMPLETED');
          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P10',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[9],
            expected: '没有创建第二条开户申请',
            actual: 'Admin只新增本次唯一reviewId',
            status: 'passed'
          });
          context.setBusinessData({
            documensoCompleteClicks: 0,
            documensoSigningConfirmationClicks: 0,
            openFeeConfirmationCount: application.openFeeConfirmationClickCount(),
            feeConfirmationClickCount: application.feeConfirmationClickCount(),
            securityVerificationClicks: application.securityKey.verificationClickCount(),
            securityVerificationStatus: 'Passed',
            applicationCreateCount: guard.snapshot().clientSubmissions,
            applicationCreatedAfterFee: true,
            adminOpeningApprovalClicks: approval.approvalClickCount(),
            noSecondOpeningApplication: true,
            noRepeatedDocumentSigning: true,
            resumeStage: state.stage,
            confirmed: true,
            mutationPerformed: true
          });
          context.setActual('OPEN-US-003 Resume完整成功；没有重复签署或第二条申请，Resume=COMPLETED。');
        }
      );
    } catch (error) {
      business.disallowSafeRerun();
      business.setBusinessData({
        resumeStage: state.stage,
        documensoCompleteClicks: 0,
        documensoSigningConfirmationClicks: 0,
        openFeeConfirmationCount: application.openFeeConfirmationClickCount(),
        feeConfirmationClickCount: application.feeConfirmationClickCount(),
        securityVerificationClicks: application.securityKey.verificationClickCount(),
        securityVerificationStatus:
          application.securityKey.verificationClickCount() === 1 ? 'Attempted' : 'Not Run',
        applicationCreateCount: guard.snapshot().clientSubmissions,
        applicationCreatedAfterFee: guard.snapshot().clientSubmissions === 1,
        noSecondOpeningApplication: true,
        noRepeatedDocumentSigning: true,
        confirmed: false
      });
      if (
        state.stage === 'SECURITY_KEY_VERIFICATION_ATTEMPTED' ||
        (stageIndex(state.stage) >= stageIndex('FEE_CONFIRMED') && !candidateLocated) ||
        (stageIndex(state.stage) >= stageIndex('FIDERE_APPROVAL_ATTEMPTED') && !fidereStatusConfirmed) ||
        (stageIndex(state.stage) >= stageIndex('CLIENT_CREATED') && !candidateLocated)
      ) {
        business.requireManualReview('原美国开户草稿、开户费余额、Client申请及Admin当前状态');
      }
      throw error;
    }
  }
);
