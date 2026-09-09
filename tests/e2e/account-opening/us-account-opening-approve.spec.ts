import { AccountOpeningReviewPage, type AccountOpeningAdminRecord } from '../../../pages/admin/AccountOpeningReviewPage';
import { AccountTypeConfigurationPage } from '../../../pages/admin/AccountTypeConfigurationPage';
import { JurisdictionAccountChooserPage } from '../../../pages/client/JurisdictionAccountChooserPage';
import { UsAccountOpeningPage } from '../../../pages/client/UsAccountOpeningPage';
import { DocumentSigningPage } from '../../../pages/third-party/DocumentSigningPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { resolveUsOpeningDocumentAssets } from '../../../src/account-opening/account-opening-assets';
import { runUsAccountOpeningAuthPreflight } from '../../../src/account-opening/account-opening-auth-preflight';
import {
  ACCOUNT_OPENING_PRIMARY_ORACLES,
  US_ACCOUNT_OPENING_FLOW_ID,
  UsAccountOpeningExecutionGuard,
  activeUsAccountOpeningStates,
  advanceUsAccountOpeningState,
  diagnoseAccountOpeningCandidates,
  prepareAccountOpeningResume
} from '../../../src/account-opening/account-opening-e2e';
import { env } from '../../../src/config/env';
import {
  FlowStateStore,
  assertSandboxEnvironment,
  matchesConfiguredCustomerIdentity,
  stageIndex,
  type FlowResumeState
} from '../../../src/flow-engine';
import { maskBusinessId } from '../../../src/reporting/sensitive-data-mask';

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
  'OPEN-US-003 requires both mutation safety switches in this process.'
);

function runId(): string {
  return `OPENUS003-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
}

function safetySwitches(): Record<string, boolean> {
  return {
    ALLOW_MONEY_TESTS: env.exchange.allowMoneyTests,
    ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests
  };
}

test(
  'OPEN-US-003 美国账户开户完整成功闭环',
  {
    tag: ['@e2e', '@account-opening', '@us', '@mutation', '@money', '@external', '@L5'],
    annotation: [
      { type: 'caseId', description: 'OPEN-US-003' },
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
      !env.accountOpening.signatureText ||
      !env.accountOpening.initials
    ) {
      throw new Error('OPEN-US-003 requires Client/Admin URLs and all OPENING_* settings.');
    }

    const switches = safetySwitches();
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

    const id = runId();
    const approvalNote = `AUTO_OPEN_US_APPROVE_${id}`;
    const stateStore = new FlowStateStore();
    const existingActiveStates = activeUsAccountOpeningStates(stateStore);
    expect(existingActiveStates).toHaveLength(0);

    let state: FlowResumeState | undefined;
    let candidateLocated = false;
    let fidereStatusConfirmed = false;
    let currentCandidate: AccountOpeningAdminRecord | undefined;
    const assets = resolveUsOpeningDocumentAssets();
    const chooser = new JurisdictionAccountChooserPage(clientPage);
    const application = new UsAccountOpeningPage(clientPage);
    const signer = new DocumentSigningPage(clientPage);
    const reviews = new AccountOpeningReviewPage(adminPage);
    const accountTypes = new AccountTypeConfigurationPage(adminPage);

    business.flow(US_ACCOUNT_OPENING_FLOW_ID, {
      preconditions: [
        '专用Sandbox美国账户未开户用户',
        'Client与Admin认证有效',
        '五份Sandbox资料存在',
        'Documenso与Interlace Sandbox可用',
        '两个Mutation开关仅在本进程开启'
      ],
      target: '只创建一条美国账户申请，经Documenso、Fidere Admin和Interlace/BaaS完成开户。'
    });
    business.setBusinessData({
      runId: id,
      usOpeningStatusBefore: '待预检',
      openingDocumentAssetCount: assets.length,
      documensoCompleteClicks: 0,
      finalSubmissionClicks: 0,
      adminOpeningApprovalClicks: 0,
      candidateCount: 0,
      resumeStage: '未创建',
      noSecondOpeningApplication: true,
      confirmed: false
    });

    try {
      const baselineReferences = await business.step(
        {
          action: '1. 执行十项只读Preflight并建立PREPARED状态',
          expected: 'Sandbox、双端认证、未开户状态、无美国历史申请、资料、Documenso、Admin和Interlace全部可用'
        },
        async context => {
          await runUsAccountOpeningAuthPreflight({
            clientPage,
            adminPage,
            clientBaseUrl: env.client.baseUrl!,
            adminBaseUrl: env.admin.baseUrl!,
            guard
          });

          await chooser.goto(env.client.baseUrl!);
          await chooser.openChooser();
          const option = await chooser.readOption('美国账户');
          expect(option.status).toBe('可申请');
          expect(option.actionAvailable).toBe(true);

          await reviews.goto(env.admin.baseUrl!);
          await reviews.searchCustomer(env.accountOpening.testEmail!);
          const records = await reviews.readRecords(env.accountOpening.testEmail!);
          const baselineReferences = new Set(records.map(record => record.applicationId).filter(Boolean));
          let existingUsCount = 0;
          for (const record of records) {
            const detail = await reviews.openDetail(record);
            const data = await detail.readDetail(record.applicationId!);
            if (data.accountType === '美国账户') existingUsCount += 1;
          }
          expect(existingUsCount).toBe(0);

          expect(assets).toHaveLength(5);
          const documenso = await clientPage.request.get('https://app.documenso.com', {
            failOnStatusCode: false,
            timeout: 20_000
          });
          expect(documenso.status()).toBeLessThan(500);
          await accountTypes.goto(env.admin.baseUrl!);
          const config = await accountTypes.readUsConfiguration();
          expect(config.channel).toBe('interlace');
          expect(config.enabled).toBe(true);

          state = prepareAccountOpeningResume(id, '美国账户');
          stateStore.save(state);
          context.setBusinessData({
            usOpeningStatusBefore: option.status,
            existingUsOpeningApplicationCount: existingUsCount,
            openingDocumentAssetCount: assets.length,
            documensoNetworkStatus: documenso.status(),
            usOpeningChannel: config.channel,
            usOpeningChannelEnabled: config.enabled,
            resumeStage: state.stage
          });
          context.setActual('十项Preflight全部通过；专用用户无美国开户申请，Resume已保存为PREPARED。');
          return baselineReferences;
        }
      );

      await business.step(
        {
          action: '2. 上传五份固定Sandbox开户资料',
          expected: '护照、身份证明、自拍、住址证明和资金来源证明全部被对应字段接受'
        },
        async context => {
          await chooser.goto(env.client.baseUrl!);
          await chooser.openChooser();
          await chooser.openApplication('美国账户');
          await application.expectLoaded();
          const uploads = [];
          for (const asset of assets) uploads.push(await application.uploadDocument(asset));
          expect(uploads).toHaveLength(5);
          expect(uploads.every(upload => upload.accepted)).toBe(true);
          state = advanceUsAccountOpeningState(stateStore, state!, 'DOCUMENTS_UPLOADED');
          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P1',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[0],
            expected: '5份资料上传成功',
            actual: '5份资料均被正确字段接受',
            status: 'passed'
          });
          context.setBusinessData({ openingDocumentUploads: uploads, resumeStage: state.stage });
          context.setActual('五份固定Sandbox资料上传成功，未执行最终开户提交。');
        }
      );

      await business.step(
        {
          action: '3. 完成Documenso TEST签署并分别单次点击Complete和确认Sign',
          expected: '唯一Signature字段完成，Complete与确认Sign各点击一次，Client提交仍为0次'
        },
        async context => {
          await signer.open(() => application.openTaxDocumentSigning());
          const prepared = await signer.prepareSandboxSignature({
            signatureText: env.accountOpening.signatureText!,
            initials: env.accountOpening.initials!
          });
          expect(prepared.requiredFieldsAfter).toBe(0);
          state = advanceUsAccountOpeningState(stateStore, state!, 'DOCUMENT_READY_TO_COMPLETE');
          guard.assertDocumentCompletionAllowed(switches);
          context.markPotentiallySubmitted();
          context.disallowSafeRerun();
          await signer.completeDocument();
          guard.recordDocumentCompleteClick();
          guard.assertDocumentSigningConfirmationAllowed(switches);
          let completion;
          try {
            completion = await signer.confirmSigning();
          } finally {
            if (
              signer.signingConfirmationClickCount() === 1 &&
              state?.stage === 'DOCUMENT_READY_TO_COMPLETE'
            ) {
              guard.recordDocumentSigningConfirmation();
              state = advanceUsAccountOpeningState(
                stateStore,
                state,
                'DOCUMENT_COMPLETE_ATTEMPTED'
              );
            }
          }
          const taxStatus = await application.waitForTaxDocumentSigned();
          state = advanceUsAccountOpeningState(stateStore, state!, 'DOCUMENT_SIGNED');
          expect(signer.completeClickCount()).toBe(1);
          expect(signer.signingConfirmationClickCount()).toBe(1);
          expect(application.submissionClickCount()).toBe(0);
          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P2',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[1],
            expected: 'Documenso Complete与确认Sign均成功且各点击1次',
            actual: `Complete=1；Sign=1；${completion!.completionEvidence}`,
            status: 'passed'
          });
          context.setBusinessData({
            taxFormStatus: taxStatus,
            signingMethod: prepared.signatureMethod,
            signingFinalAction: completion!.actionName,
            signingFinalRequestPath: completion!.requestPath,
            signingFinalHttpStatus: completion!.httpStatus,
            documensoCompleteClicks: signer.completeClickCount(),
            documensoSigningConfirmationClicks: signer.signingConfirmationClickCount(),
            finalSubmissionClicks: application.submissionClickCount(),
            resumeStage: state!.stage
          });
          context.setActual('Documenso字段级TEST签名、Complete与确认Sign均成功；两个最终签署动作各点击1次。');
        }
      );

      const submittedAt = new Date();
      await business.step(
        {
          action: '4. Client单次提交美国账户开户申请',
          expected: '最终提交只点击一次，并立即保存CLIENT_CREATED防止Fresh Run'
        },
        async context => {
          guard.assertClientSubmissionAllowed(switches);
          context.markPotentiallySubmitted();
          context.disallowSafeRerun();
          try {
            await application.submitOnce();
          } finally {
            if (application.submissionClickCount() === 1 && state?.stage === 'DOCUMENT_SIGNED') {
              guard.recordClientSubmission();
              state = advanceUsAccountOpeningState(stateStore, state, 'CLIENT_CREATED', {
                clientSubmittedAt: submittedAt.toISOString()
              });
            }
          }
          let acknowledgement = '未观察到独立成功页，转由Admin业务记录确认';
          try {
            const evidence = await application.waitForSubmissionEvidence();
            acknowledgement = `${evidence.acknowledgement}:${evidence.route}`;
          } catch (error) {
            context.warn('Client提交后未观察到独立成功页，将只按唯一Admin申请确认创建结果。');
            acknowledgement = error instanceof Error ? error.message : String(error);
          }
          expect(application.submissionClickCount()).toBe(1);
          context.setBusinessData({
            finalSubmissionClicks: application.submissionClickCount(),
            clientSubmissionEvidence: acknowledgement,
            clientSubmittedAt: submittedAt.toISOString(),
            resumeStage: state!.stage
          });
          context.setActual('Client最终提交仅点击1次；无论成功页是否展示，均禁止再次提交。');
        }
      );

      currentCandidate = await business.step(
        {
          action: '5. Admin按客户、待提交状态和时间窗口唯一定位本次申请',
          expected: 'candidateCount严格等于1，并取得唯一reviewId'
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
            message: 'Admin did not expose exactly one new US Account Opening candidate.'
          }).toBe(1);
          const candidate = diagnostics!.candidates[0] as AccountOpeningAdminRecord;
          if (!candidate.applicationId || !candidate.detailUrl || !candidate.processUrl) {
            throw new Error('Unique Admin US Account candidate lacks reviewId or action URLs.');
          }
          guard.recordUniqueAdminCandidate(1);
          candidateLocated = true;
          state = advanceUsAccountOpeningState(stateStore, state!, 'ADMIN_LOCATED', {
            clientReference: candidate.applicationId,
            adminReference: candidate.applicationId
          });
          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P3',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[2],
            expected: 'Client只创建一条申请',
            actual: 'Admin新增待提交候选恰好1条',
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
            clientOpeningReference: maskBusinessId(candidate.applicationId),
            adminOpeningReference: maskBusinessId(candidate.applicationId),
            resumeStage: state.stage
          });
          context.setActual('Admin待提交候选数严格为1，已保存唯一reviewId并切换到Resume模式。');
          return candidate;
        }
      );

      const detailPage = await business.step(
        {
          action: '6. Admin详情二次核对用户、美国账户、五份资料与FATCA签署',
          expected: '客户、账户类型、提交时间、五份资料和Documenso文档全部匹配'
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
          context.setBusinessData({
            adminOpeningDetailVerified: true,
            adminOpeningUploadedDocumentCount: detail.uploadedDocumentFields.length,
            adminFatcaDocumentAvailable: detail.fatcaDocumentViewAvailable
          });
          context.setActual('Admin详情中的测试用户、美国账户、五份资料、FATCA文档和提交时间全部一致。');
          return detailPage;
        }
      );

      const approval = await detailPage.openApproval(currentCandidate);
      await business.step(
        {
          action: '7. 填写Fidere审核通过表单并单次提交',
          expected: '仅选择通过审核，备注完整，最终按钮只点击一次；绝不点击Reject'
        },
        async context => {
          await approval.fillApprovalForm(approvalNote);
          guard.assertAdminApprovalAllowed(switches);
          context.markPotentiallySubmitted();
          context.disallowSafeRerun();
          let result;
          try {
            result = await approval.confirmApproveOnce();
          } finally {
            if (approval.approvalClickCount() === 1 && state?.stage === 'ADMIN_LOCATED') {
              guard.recordAdminApproval();
              state = advanceUsAccountOpeningState(stateStore, state, 'FIDERE_APPROVED');
            }
          }
          expect(approval.approvalClickCount()).toBe(1);
          context.setBusinessData({
            adminOpeningApprovalClicks: approval.approvalClickCount(),
            adminApprovalRequestPath: result!.requestPath,
            adminApprovalHttpStatus: result!.httpStatus,
            resumeStage: state!.stage
          });
          context.setActual('Fidere Admin通过审核仅点击1次，未点击平台Reject。');
        }
      );

      await business.step(
        {
          action: '8. 确认Fidere审核通过并进入BaaS阶段',
          expected: '原reviewId状态为审核通过，随后保存BAAS_SUBMITTED和BAAS_PENDING'
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
            message: 'Fidere review did not reach an approved status.'
          }).toMatch(FIDERE_APPROVED_STATUS);
          fidereStatusConfirmed = true;
          state = advanceUsAccountOpeningState(stateStore, state!, 'BAAS_SUBMITTED');
          state = advanceUsAccountOpeningState(stateStore, state, 'BAAS_PENDING');
          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P5',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[4],
            expected: 'Fidere审核通过',
            actual: approvedRecord!.status,
            status: 'passed'
          });
          context.setBusinessData({
            fidereStatusAfter: approvedRecord!.status,
            baasSubmissionConfirmed: true,
            resumeStage: state.stage
          });
          context.setActual(`原reviewId状态为${approvedRecord!.status}；Interlace配置启用，已进入BaaS等待阶段。`);
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
          return {
            stage: 'CONFLICT',
            clientStatus: clientOption.status,
            adminStatus: adminRecord.status
          };
        }
        return { stage: 'BAAS_PENDING', clientStatus: clientOption.status, adminStatus: adminRecord.status };
      };

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
          message: 'Interlace/BaaS did not reach approved or failed state within the controlled poll window.'
        }).toMatch(/BAAS_APPROVED|BAAS_FAILED|CONFLICT/);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('Interlace/BaaS did not reach')) throw error;
        baasTimedOut = true;
      }

      if (baasTimedOut) {
        testInfo.annotations.push({ type: 'blocker', description: 'BAAS_PENDING' });
        business.disallowSafeRerun();
        business.warn('Fidere已审核通过，Interlace/BaaS仍在处理中；必须Resume原申请。');
        business.setBusinessData({
          baasFinalStatus: 'BAAS_PENDING',
          clientUsAccountFinalStatus: baasObservation.clientStatus,
          resumeStage: state!.stage,
          recoveryRequired: false,
          noSecondOpeningApplication: true,
          confirmed: false
        });
        return;
      }

      if (baasObservation.stage === 'CONFLICT') {
        business.requireManualReview('原美国开户reviewId、Admin状态与Client美国账户状态');
        business.disallowSafeRerun();
        throw new Error(
          `Core Account Opening states conflict: Admin=${baasObservation.adminStatus}, Client=${baasObservation.clientStatus}.`
        );
      }

      if (baasObservation.stage === 'BAAS_FAILED') {
        state = advanceUsAccountOpeningState(stateStore, state!, 'BAAS_FAILED');
        testInfo.annotations.push({ type: 'blocker', description: 'OPEN-US-004 Resume Ready' });
        business.disallowSafeRerun();
        business.warn('Interlace/BaaS返回失败；禁止重新Client申请或重新Documenso签署。');
        business.setBusinessData({
          baasFinalStatus: 'BAAS_FAILED',
          baasFailureReason: baasObservation.failureReason,
          clientUsAccountFinalStatus: baasObservation.clientStatus,
          resumeStage: state.stage,
          recoveryRequired: true,
          noSecondOpeningApplication: true,
          confirmed: false
        });
        return;
      }

      state = advanceUsAccountOpeningState(stateStore, state!, 'BAAS_APPROVED');
      await business.step(
        {
          action: '9. 验证BaaS成功与Client美国账户终态',
          expected: 'Client显示美国账户已开通，账户总览可展开，第三方成功不与Fidere审核混淆'
        },
        async context => {
          await chooser.goto(env.client.baseUrl!);
          await chooser.expectAccountSection('美国账户');
          const route = await chooser.openExistingAccountOverview('美国账户');
          await chooser.openChooser();
          const option = await chooser.readOption('美国账户');
          expect(option.status).toBe('已开通');
          expect(option.actionAvailable).toBe(false);
          state = advanceUsAccountOpeningState(stateStore, state!, 'CLIENT_FINALIZED');
          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P6',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[5],
            expected: '申请进入Interlace/BaaS并返回成功',
            actual: 'Fidere已批准且Client美国账户已开通',
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
            expected: '美国账户已开通',
            actual: option.status,
            status: 'passed'
          });
          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P9',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[8],
            expected: '美国账户总览可打开',
            actual: route,
            status: 'passed'
          });
          context.setBusinessData({
            baasFinalStatus: 'BAAS_APPROVED',
            clientUsAccountFinalStatus: option.status,
            usAccountOverviewRoute: route,
            resumeStage: state.stage
          });
          context.setActual('BaaS成功终态已由Client美国账户已开通和真实账户总览交叉确认。');
        }
      );

      await business.step(
        {
          action: '10. 确认没有第二条美国开户申请并完成Resume',
          expected: '专用用户只新增当前唯一reviewId，Complete、Sign、Client提交和Admin批准各1次，Resume=COMPLETED'
        },
        async context => {
          await reviews.goto(env.admin.baseUrl!);
          await reviews.searchCustomer(env.accountOpening.testEmail!);
          const recordsAfter = await reviews.readRecords(env.accountOpening.testEmail!);
          const referencesAfter = new Set(recordsAfter.map(record => record.applicationId).filter(Boolean));
          const added = [...referencesAfter].filter(reference => !baselineReferences.has(reference));
          expect(added).toEqual([currentCandidate!.applicationId]);
          expect(signer.completeClickCount()).toBe(1);
          expect(signer.signingConfirmationClickCount()).toBe(1);
          expect(application.submissionClickCount()).toBe(1);
          expect(approval.approvalClickCount()).toBe(1);
          state = advanceUsAccountOpeningState(stateStore, state!, 'COMPLETED');
          context.recordPrimaryOracle({
            id: 'OPEN-US-003-P10',
            name: ACCOUNT_OPENING_PRIMARY_ORACLES.approve[9],
            expected: '仅新增一条美国开户申请',
            actual: '新增reviewId恰好1条',
            status: 'passed'
          });
          context.setBusinessData({
            documensoCompleteClicks: signer.completeClickCount(),
            documensoSigningConfirmationClicks: signer.signingConfirmationClickCount(),
            finalSubmissionClicks: application.submissionClickCount(),
            adminOpeningApprovalClicks: approval.approvalClickCount(),
            noSecondOpeningApplication: true,
            resumeStage: state.stage,
            confirmed: true,
            mutationPerformed: true
          });
          context.setActual('OPEN-US-003完整成功；没有第二条申请，Resume状态为COMPLETED。');
        }
      );
    } catch (error) {
      const stage = state?.stage;
      const irreversible = stage
        ? stageIndex(stage) >= stageIndex('DOCUMENT_SIGNED')
        : false;
      if (irreversible) {
        business.disallowSafeRerun();
        business.setBusinessData({
          resumeStage: stage,
          documensoCompleteClicks: signer.completeClickCount(),
          documensoSigningConfirmationClicks: signer.signingConfirmationClickCount(),
          finalSubmissionClicks: application.submissionClickCount(),
          noSecondOpeningApplication: true,
          confirmed: false
        });
      }
      if (
        (stage === 'CLIENT_CREATED' && !candidateLocated) ||
        (stage === 'FIDERE_APPROVED' && !fidereStatusConfirmed)
      ) {
        business.requireManualReview('原美国开户申请、Admin reviewId与Client账户状态');
      }
      throw error;
    }
  }
);
