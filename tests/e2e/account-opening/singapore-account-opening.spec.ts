import { AccountOpeningReviewPage, type AccountOpeningAdminRecord } from '../../../pages/admin/AccountOpeningReviewPage';
import { AccountBalanceReader } from '../../../pages/client/AccountBalanceReader';
import { JurisdictionAccountChooserPage } from '../../../pages/client/JurisdictionAccountChooserPage';
import { SingaporeAccountOpeningPage } from '../../../pages/client/SingaporeAccountOpeningPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { diagnoseAccountOpeningCandidates } from '../../../src/account-opening/account-opening-e2e';
import {
  SINGAPORE_ACCOUNT_OPENING_FLOW_ID,
  SingaporeAccountOpeningRun
} from '../../../src/account-opening/singapore-account-opening-e2e';
import { env } from '../../../src/config/env';
import {
  MoneyMutationGuard,
  assertSandboxEnvironment,
  matchesConfiguredCustomerIdentity
} from '../../../src/flow-engine';
import { maskBusinessId, maskSensitiveText } from '../../../src/reporting/sensitive-data-mask';
import { Decimal } from '../../../src/utils/money';

const PENDING_STATUS = '审核中';
const APPROVED_STATUS = /审核通过|已通过|已批准/;
const MATCH_WINDOW_MS = 20 * 60 * 1000;

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'OPEN-SG-002 Client新加坡账户开户与Admin审核通过闭环 @money @mutation @L4',
  {
    tag: ['@e2e', '@account-opening', '@singapore', '@money', '@mutation', '@L4'],
    annotation: [
      { type: 'caseId', description: 'OPEN-SG-002' },
      { type: 'flowId', description: SINGAPORE_ACCOUNT_OPENING_FLOW_ID },
      { type: 'changesData', description: 'true' },
      { type: 'affectsMoney', description: 'true' }
    ]
  },
  async ({ clientPage, adminPage, business }, testInfo) => {
    test.setTimeout(300_000);
    const email = env.accountOpening.testEmail;
    const securityKey = env.client.securityKey;
    const runId = process.env.SINGAPORE_OPENING_RUN_ID;
    const authorizedEmail = process.env.SINGAPORE_OPENING_AUTHORIZED_EMAIL;
    if (!env.client.baseUrl || !env.admin.baseUrl || !email || !securityKey || !runId) {
      throw new Error('OPEN-SG-002 requires Client/Admin URLs, OPENING_TEST_EMAIL, CLIENT_SECURITY_KEY, and SINGAPORE_OPENING_RUN_ID.');
    }
    if (authorizedEmail?.toLowerCase() !== email.toLowerCase()) {
      throw new Error('OPEN-SG-002 requires SINGAPORE_OPENING_AUTHORIZED_EMAIL to match the exact Client user.');
    }
    expect(testInfo.config.workers).toBe(1);
    expect(testInfo.project.retries).toBe(0);
    expect(testInfo.project.repeatEach).toBe(1);
    expect(testInfo.retry + testInfo.repeatEachIndex).toBe(0);
    assertSandboxEnvironment(env.client.baseUrl);
    assertSandboxEnvironment(env.admin.baseUrl);

    const switches = {
      ALLOW_MONEY_TESTS: env.exchange.allowMoneyTests,
      ALLOW_CLIENT_MUTATION_TESTS: env.allowClientMutationTests,
      ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests
    };
    const guard = new MoneyMutationGuard(SINGAPORE_ACCOUNT_OPENING_FLOW_ID, true, true);
    guard.validateRuntime({
      baseURL: env.client.baseUrl,
      workers: testInfo.config.workers,
      retries: testInfo.project.retries,
      repeatEach: testInfo.project.repeatEach,
      safetySwitches: switches
    });

    const run = new SingaporeAccountOpeningRun(runId, email);
    const securitySetupRecovery = run.state().stage === 'SECURITY_KEY_VERIFICATION_ATTEMPTED' &&
      run.attempted('client-confirmation') && run.attempted('security-key') && !run.attempted('security-key-recovery');
    const clientCreatedResume = run.state().stage === 'CLIENT_CREATED';
    if (run.state().stage !== 'PREPARED' && !securitySetupRecovery && !clientCreatedResume) {
      throw new Error(`OPEN-SG-002 Run is already at ${run.state().stage}; only its exact persisted Resume path is allowed.`);
    }

    const chooser = new JurisdictionAccountChooserPage(clientPage);
    const application = new SingaporeAccountOpeningPage(clientPage);
    const balances = new AccountBalanceReader(clientPage);
    const reviews = new AccountOpeningReviewPage(adminPage);
    let beforeBalance = clientCreatedResume ? process.env.SINGAPORE_OPENING_BALANCE_BEFORE ?? '' : '';
    let candidate: AccountOpeningAdminRecord | undefined;
    let submittedAt = new Date();

    business.flow(SINGAPORE_ACCOUNT_OPENING_FLOW_ID, {
      name: '新加坡账户Client申请与Admin审核通过',
      target: '验证现有Sandbox用户提交唯一新加坡开户申请，经Admin审核后账户开通且开户费正确扣除。'
    });
    business.setBusinessData({
      runId,
      registrationLoginIdentity: maskSensitiveText(email),
      targetAccountType: '新加坡账户',
      balancePreparationRun: 'OPEN-SG-002-AF-20260911-FUNDING',
      balancePreparedAmount: '900.00 USD',
      resumeStage: run.state().stage,
      clientConfirmationClicks: 0,
      securityKeyVerificationClicks: 0,
      adminOpeningApprovalClicks: 0
    });

    if (clientCreatedResume) {
      if (!beforeBalance) {
        throw new Error('OPEN-SG-002 CLIENT_CREATED Resume requires SINGAPORE_OPENING_BALANCE_BEFORE.');
      }
      submittedAt = new Date(run.state().clientSubmittedAt!);
    }

    try {
      await business.step({
        action: '1. 核对新加坡开户资格、开户费、香港USD余额和Admin认证',
        expected: '新加坡账户可申请；页面开户费与扣费账户可读；余额足够；Admin无重复待处理申请'
      }, async step => {
        await chooser.goto(env.client.baseUrl!);
        const currentBalance = (await balances.readSnapshot({ accountType: '香港账户', currency: 'USD' })).available;
        if (!clientCreatedResume) beforeBalance = currentBalance;
        await chooser.openChooser();
        const option = await chooser.readOption('新加坡账户');
        expect(option).toMatchObject(clientCreatedResume
          ? { status: '申请中', actionAvailable: true }
          : { status: '可申请', actionAvailable: true });

        await reviews.goto(env.admin.baseUrl!);
        await reviews.searchCustomer(email);
        const existing = (await reviews.readRecords(email)).filter(record =>
          record.customerMatched && record.accountType === '新加坡账户' && /待提交|待审核|审核中/.test(record.status)
        );
        expect(existing).toHaveLength(clientCreatedResume ? 1 : 0);
        guard.markAuthenticationReady(true, true);

        if (clientCreatedResume) {
          guard.recordClientMoneyConfirmation();
          guard.recordSecurityKeyVerification();
          guard.recordClientSubmission();
          step.setActual(`原新加坡申请仍为${option.status}；Admin恰有1条审核中记录；未重复提交。`);
          return;
        }

        await chooser.goto(env.client.baseUrl!);
        await chooser.openChooser();
        await chooser.openApplication('新加坡账户');
        await application.expectLoaded();
        const summary = await application.readSummary();
        expect(summary.currency).toBe('USD');
        expect(summary.openingFee.isPositive()).toBe(true);
        expect(new Decimal(beforeBalance).gte(summary.openingFee)).toBe(true);
        expect(await application.fileInputCount()).toBe(0);
        run.setMoney(summary.openingFee.toFixed(2), summary.currency);
        step.setBusinessData({
          openingFeeCurrency: summary.currency,
          openingFeeAmount: summary.openingFee.toFixed(2),
          paymentAccount: summary.paymentAccount,
          fundingRule: summary.fundingRule,
          feeBalanceBefore: beforeBalance,
          clientBeforeStatus: option.status
        });
        step.setActual(`新加坡账户可申请；页面开户费${summary.openingFee.toFixed(2)} USD；香港账户余额${beforeBalance} USD，满足扣费条件。`);
      });

      if (!clientCreatedResume) await business.step({
        action: '2. Client确认开户并完成一次安全密钥验证',
        expected: '开户确认与安全密钥验证各执行一次，并形成唯一新加坡开户申请'
      }, async step => {
        submittedAt = new Date();
        guard.assertClientMoneyConfirmationAllowed(switches);
        await application.openSecurityKeyDialogOnce(() => {
          if (!securitySetupRecovery) {
            run.attempt('client-confirmation');
            run.advance('FEE_CONFIRMATION_ATTEMPTED', { feeConfirmationOpenedAt: submittedAt.toISOString() });
          }
          step.markPotentiallySubmitted();
          step.disallowSafeRerun();
        });
        const setup = await application.securityKey.configureIfRequired(securityKey);
        if (setup.required) {
          if (setup.dialogClosed) {
            await application.openSecurityKeyDialogAfterSetupOnce(() => undefined);
          } else if (!setup.verificationReady) {
            throw new Error('Security Key setup did not reach a usable verification state.');
          }
        }
        guard.recordClientMoneyConfirmation();
        await application.securityKey.fill(securityKey);
        guard.assertSecurityKeyVerificationAllowed(switches);
        if (securitySetupRecovery) run.attempt('security-key-recovery');
        else {
          run.attempt('security-key');
          run.advance('SECURITY_KEY_VERIFICATION_ATTEMPTED');
        }
        await application.securityKey.verifyOnce();
        guard.recordSecurityKeyVerification();

        const evidence = await application.waitForApplicationCreationEvidence(chooser, env.client.baseUrl!);
        guard.assertClientSubmissionAllowed(switches);
        guard.recordClientSubmission();
        run.advance('FEE_CONFIRMED', { feeConfirmedAt: new Date().toISOString() });
        run.advance('CLIENT_CREATED', { clientSubmittedAt: submittedAt.toISOString() });
        business.markMutationPerformed('Client确认新加坡开户费并创建申请');
        step.setBusinessData({
          clientConfirmationClicks: application.submissionClickCount(),
          securityKeyVerificationClicks: application.securityKey.verificationClickCount(),
          applicationCreateCount: application.applicationCreateCount(),
          clientAfterSubmissionStatus: evidence.status,
          clientSubmittedAt: submittedAt.toISOString(),
          resumeStage: run.state().stage
        });
        step.setActual(`Client只确认1次、安全密钥只验证1次；新加坡账户状态为${evidence.status}。`);
      });

      await business.step({
        action: '3. Admin按邮箱、账户类型、状态和提交时间唯一定位申请',
        expected: '管理端唯一匹配本次新加坡开户申请，并取得原reviewId'
      }, async step => {
        let diagnostics: ReturnType<typeof diagnoseAccountOpeningCandidates> | undefined;
        await expect.poll(async () => {
          await reviews.goto(env.admin.baseUrl!);
          await reviews.searchCustomer(email);
          diagnostics = diagnoseAccountOpeningCandidates(await reviews.readRecords(email), {
            customerIdentity: email,
            accountType: '新加坡账户',
            status: PENDING_STATUS,
            submittedAtMs: submittedAt.getTime(),
            matchWindowMs: MATCH_WINDOW_MS
          });
          return diagnostics.candidates.length;
        }, { timeout: 90_000, intervals: [2_000, 5_000, 10_000] }).toBe(1);
        candidate = diagnostics!.candidates[0] as AccountOpeningAdminRecord;
        if (!candidate.applicationId || !candidate.detailUrl || !candidate.processUrl) {
          throw new Error('Unique Singapore candidate lacks reviewId or Admin action URLs.');
        }
        guard.recordUniqueAdminCandidate(1);
        run.advance('ADMIN_LOCATED', {
          clientReference: candidate.applicationId,
          adminReference: candidate.applicationId
        });
        step.setBusinessData({
          candidateCount: 1,
          candidateStageCounts: diagnostics!.counts,
          clientOpeningReference: maskBusinessId(candidate.applicationId),
          adminOpeningReference: maskBusinessId(candidate.applicationId),
          adminBeforeStatus: candidate.status,
          resumeStage: run.state().stage
        });
        step.setActual('管理端唯一匹配到本次用户的新加坡账户审核中申请。');
      });

      const detailPage = await business.step({
        action: '4. Admin打开唯一候选并二次核对开户详情',
        expected: '用户、新加坡账户、提交时间和审核状态均与Client原申请一致'
      }, async step => {
        const detail = await reviews.openDetail(candidate!);
        const values = await detail.readDetail(candidate!.applicationId!);
        expect(matchesConfiguredCustomerIdentity(values.customerText, email)).toBe(true);
        expect(values.accountType).toBe('新加坡账户');
        expect(Math.abs(Date.parse(values.submittedAt) - submittedAt.getTime())).toBeLessThanOrEqual(MATCH_WINDOW_MS);
        step.setBusinessData({ adminOpeningDetailVerified: true });
        step.setActual('Admin详情确认属于同一用户和本次新加坡开户申请。');
        return detail;
      });

      const approval = await detailPage.openApproval(candidate!);
      await business.step({
        action: '5. Admin填写审核备注并审核通过一次',
        expected: '原reviewId只审核通过一次，不执行拒绝或重复审批'
      }, async step => {
        await approval.fillApprovalForm(`AUTO_SINGAPORE_APPROVE_${runId}`);
        guard.assertAdminActionAllowed(switches);
        run.attempt('admin-approval');
        run.advance('ADMIN_APPROVAL_SUBMISSION_ATTEMPTED');
        step.markPotentiallySubmitted();
        step.disallowSafeRerun();
        const result = await approval.confirmApproveOnce();
        guard.recordAdminAction();
        business.markMutationPerformed('Admin新加坡开户审核通过');
        step.setBusinessData({
          adminOpeningApprovalClicks: approval.approvalClickCount(),
          adminApprovalRequestPath: result.requestPath,
          adminApprovalHttpStatus: result.httpStatus,
          resumeStage: run.state().stage
        });
        step.setActual('Admin审核通过只提交1次，未执行拒绝。');
      });

      await business.step({
        action: '6. 查询原reviewId并验证Client新加坡账户与开户费终态',
        expected: 'Admin审核通过；Client新加坡账户已开通；香港USD扣减等于页面开户费'
      }, async step => {
        let adminStatus = '';
        await expect.poll(async () => {
          await reviews.goto(env.admin.baseUrl!);
          await reviews.searchCustomer(email);
          adminStatus = (await reviews.readRecords(email))
            .find(record => record.applicationId === candidate!.applicationId)?.status ?? '';
          return adminStatus;
        }, { timeout: 60_000, intervals: [2_000, 5_000] }).toMatch(APPROVED_STATUS);
        run.advance('FIDERE_APPROVED');

        let clientStatus = '';
        await expect.poll(async () => {
          await chooser.goto(env.client.baseUrl!);
          await chooser.openChooser();
          clientStatus = (await chooser.readOption('新加坡账户')).status;
          return clientStatus;
        }, { timeout: 90_000, intervals: [2_000, 5_000, 10_000] }).toBe('已开通');
        run.advance('CLIENT_FINALIZED');

        let afterBalance = '';
        await expect.poll(async () => {
          await chooser.goto(env.client.baseUrl!);
          afterBalance = (await balances.readSnapshot({ accountType: '香港账户', currency: 'USD' })).available;
          return new Decimal(beforeBalance).minus(afterBalance).toFixed(2);
        }, { timeout: 60_000, intervals: [2_000, 5_000] }).toBe(run.state().amount);
        run.advance('COMPLETED');
        step.recordPrimaryOracle({
          id: 'open-sg-completed',
          name: '新加坡账户开户完整闭环',
          expected: '单笔Client申请、单次安全验证、Admin唯一审核、Client已开通且开户费正确扣除',
          actual: `Admin=${adminStatus}；Client=${clientStatus}；余额${beforeBalance} -> ${afterBalance}`,
          status: 'passed'
        });
        step.setBusinessData({
          adminFinalStatus: adminStatus,
          clientFinalStatus: clientStatus,
          feeBalanceAfter: afterBalance,
          observedFeeDebit: new Decimal(beforeBalance).minus(afterBalance).toFixed(2),
          finalStatus: '已开通',
          confirmed: true,
          resumeStage: run.state().stage
        });
        step.setActual(`Admin=${adminStatus}；Client=${clientStatus}；香港USD ${beforeBalance} -> ${afterBalance}，扣费与页面金额一致。`);
      });
    } catch (error) {
      if (run.attempted('security-key') || run.attempted('admin-approval')) {
        business.requireManualReview('OPEN-SG-002已越过不可逆边界；禁止重新提交或重复审核，只允许Resume原Run。');
      }
      throw error;
    } finally {
      business.setBusinessData({ ...guard.snapshot(), resumeStage: run.state().stage });
    }
  }
);
