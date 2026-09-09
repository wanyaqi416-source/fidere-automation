import { MoneyMutationGuard, type MutationRuntime } from '../flow-engine/mutation-guard';
import type { BusinessReportApi } from '../reporting/business-report.types';
import { RegistrationAdminApprovalJourneyStore, type RegistrationAdminApprovalJourney } from './registration-admin-approval-journey';
import { assertRegistrationCaseIdentity, REGISTRATION_KYC, type RegistrationKycCase, type RegistrationKycSource } from './registration-kyc-contract';
import { maskRegistrationEmail } from './personal-registration-data';

export type RegistrationKycDriver = {
  preflight(): Promise<void>;
  locate(state: RegistrationAdminApprovalJourney): Promise<{
    candidateCount: number; candidate?: RegistrationKycCase;
    stages: Array<{ field: string; count: number }>;
  }>;
  readOriginal(candidate: RegistrationKycCase): Promise<RegistrationKycCase>;
  prepareApproval(candidate: RegistrationKycCase, note: string): Promise<void>;
  approveOnce(): Promise<{ requestPath?: string; httpStatus?: number }>;
  waitForAdvance(candidate: RegistrationKycCase): Promise<RegistrationKycCase>;
  verifyClientWithCleanLogin(): Promise<{ approved: boolean; status: string; observedAt: string }>;
};

export async function completeRegistrationKyc(input: {
  source: RegistrationKycSource;
  store: RegistrationAdminApprovalJourneyStore;
  driver: RegistrationKycDriver;
  business: BusinessReportApi;
  runtime: MutationRuntime;
  allowedSteps?: readonly string[];
}): Promise<RegistrationAdminApprovalJourney> {
  const { source, store, driver, business, runtime } = input;
  const config = REGISTRATION_KYC[source.accountType];
  const allowedSteps: readonly string[] = input.allowedSteps ?? config.approvalSteps;
  let state = store.initialize({
    flowId: config.flowId, sourceRunId: source.runId, displayName: source.displayName,
    email: source.email, userId: source.userId, reviewId: source.reviewId,
    clientSubmittedAt: source.clientSubmittedAt
  });
  business.disallowSafeRerun();
  const report = () => {
    business.setResumeState(state.kycStage ?? state.stage);
    business.setBusinessData({
      accountType: source.accountType, registrationUser: source.displayName,
      registrationLoginIdentity: maskRegistrationEmail(source.email), sourceRunId: source.runId,
      registrationReviewId: state.reviewId ? `****${state.reviewId.slice(-2)}` : undefined,
      registrationUserId: state.userId ? `****${state.userId.slice(-4)}` : undefined,
      resumeStage: state.kycStage ?? state.stage, adminFinalState: state.adminFinalState,
      clientFinalState: state.clientFinalState,
      registrationKycApprovalAttempts: (state.approvalAttempts ?? []).map(item => ({
        step: item.step, attempts: 1, confirmed: Boolean(item.confirmedAt)
      })), noSecondUserCreated: true, repeatedSigning: false, repeatedClientSubmission: false
    });
  };
  report();
  let mutationUnconfirmed = false;
  try {
    await business.step({ action: '注册后双端认证及审核权限预检',
      expected: '同一已提交账号；Admin案件工作台有效；仅授权的Sandbox单次审核' }, async context => {
      const guard = new MoneyMutationGuard(config.flowId);
      if (runtime.safetySwitches.ALLOW_ADMIN_MUTATION_TESTS !== true) {
        throw new Error('ALLOW_ADMIN_MUTATION_TESTS must be explicitly enabled for KYC approval.');
      }
      guard.validateRuntime(runtime);
      await driver.preflight();
      context.setActual('Admin认证及Client身份有效；不创建账号、不重新提交KYC。');
    });
    let current = await business.step({ action: `定位${config.tab}中的原KYC案件`,
      expected: '正确Tab，候选严格等于1；已有reviewId不得换案' }, async context => {
      const result = await driver.locate(state);
      context.setBusinessData({ adminKycTab: config.tab, candidateCount: result.candidateCount, candidateStages: result.stages });
      if (result.candidateCount !== 1 || !result.candidate) {
        throw new Error(`KYC_CANDIDATE_NOT_UNIQUE: candidateCount=${result.candidateCount}; resume the same account, never register again.`);
      }
      assertRegistrationCaseIdentity(source, result.candidate, state);
      state = store.bindCase(state, result.candidate);
      for (const attempt of state.approvalAttempts ?? []) {
        if (!attempt.confirmedAt && (result.candidate.approved || result.candidate.completedSteps.includes(attempt.step))) {
          state = store.confirmStageApproval(state, attempt.step);
        }
      }
      report();
      context.setActual(`${config.tab}，candidateCount=1；邮箱、姓名、账号类型及原案件引用匹配。`);
      return result.candidate;
    });

    // Each real review stage is a separate, journaled mutation. List disappearance
    // or a successful click is never a substitute for the original case's status.
    for (let stage = 0; !current.approved; stage += 1) {
      if (current.rejected) throw new Error('KYC_REJECTED: the original case is in a rejected state.');
      if (state.kycVerifiedAt || stage >= 4) throw new Error('KYC_STAGE_CONFLICT: read-only reconciliation required.');
      const pending = current;
      current = await business.step({ action: `完成原案件审核阶段：${pending.step}`,
        expected: '二次核对原案件，当前阶段仅通过一次，读取真实下一阶段或成功终态' }, async context => {
        const latest = await driver.readOriginal(pending);
        assertRegistrationCaseIdentity(source, latest, state);
        if (latest.approved || latest.completedSteps.includes(pending.step)) return latest;
        if (latest.step !== pending.step || latest.rejected) throw new Error('KYC_STAGE_CHANGED_BEFORE_APPROVAL');
        if (!allowedSteps.includes(latest.step) || !(config.approvalSteps as readonly string[]).includes(latest.step)) {
          throw new Error('KYC_NEW_STAGE_REQUIRES_AUTHORIZATION: no mutation performed for this new stage.');
        }
        if (state.approvalAttempts?.some(item => item.step === latest.step)) {
          mutationUnconfirmed = !state.approvalAttempts.find(item => item.step === latest.step)?.confirmedAt;
          throw new Error('KYC_APPROVAL_ALREADY_ATTEMPTED: query only; a second approval is forbidden.');
        }
        // Old runs journaled only the initial approval. A proven completed info_review
        // permits the distinct doc_review; it never permits repeating the old action.
        if (state.adminApproveCount === 1 && !state.approvalAttempts?.length &&
            !(source.accountType === 'PERSONAL' && latest.step === 'doc_review' && latest.completedSteps.includes('info_review'))) {
          mutationUnconfirmed = true;
          throw new Error('LEGACY_KYC_APPROVAL_UNCONFIRMED: preserve the existing approval attempt.');
        }
        const guard = new MoneyMutationGuard(`${config.flowId}:${latest.step}`);
        guard.validateRuntime(runtime);
        guard.markAuthenticationReady(true, true);
        guard.recordClientSubmission();
        guard.recordUniqueAdminCandidate(1);
        const note = `AUTO_REG_${source.accountType}_APPROVE_${source.runId}_${latest.step}`;
        await driver.prepareApproval(latest, note);
        guard.assertAdminActionAllowed(runtime.safetySwitches);
        state = store.recordStageApprovalAttempt(state, latest.step);
        guard.recordAdminAction();
        mutationUnconfirmed = true;
        business.markPotentiallySubmitted();
        business.markMutationPerformed(`Admin KYC ${latest.step} approval`);
        report();
        try {
          const response = await driver.approveOnce();
          context.setBusinessData({ adminKycApprovalRequest: response });
        } catch {
          context.setBusinessData({ adminApprovalUiResult: 'Unclear; querying original case only' });
        }
        const after = await driver.waitForAdvance(latest);
        assertRegistrationCaseIdentity(source, after, state);
        if (!after.approved && !after.completedSteps.includes(latest.step)) {
          throw new Error('KYC_APPROVAL_RESULT_UNCONFIRMED');
        }
        state = store.confirmStageApproval(state, latest.step);
        mutationUnconfirmed = false;
        context.setActual(`原reviewId不变；${latest.step}通过1次；真实当前状态=${after.status}。`);
        report();
        return after;
      });
    }
    state = store.updateKyc(state, {
      kycStage: 'KYC_APPROVED', adminFinalState: current.status,
      stage: state.stage === 'COMPLETED' ? state.stage : 'ADMIN_APPROVED'
    });
    business.recordPrimaryOracle({ id: 'admin-kyc-approved', name: '原案件全部KYC审核完成',
      expected: '唯一原案件进入真实成功终态，未重复审核', actual: current.status, status: 'passed' });
    report();
    await business.step({ action: '重新干净登录Client验证KYC最终通过',
      expected: '空storageState登录原账号；真实KYC/KYB状态通过且Client可正常使用' }, async context => {
      const result = await driver.verifyClientWithCleanLogin();
      if (!result.approved) throw new Error('CLIENT_KYC_NOT_APPROVED: waiting-for-review is not completion.');
      state = store.updateKyc(state, {
        kycStage: 'CLIENT_KYC_APPROVED', kycVerifiedAt: result.observedAt,
        clientFinalState: 'KYC Approved', stage: 'COMPLETED'
      });
      context.setActual(`原${source.accountType}账号干净登录成功；${config.clientStatusField}=${result.status}；首页可访问。`);
      business.recordPrimaryOracle({ id: 'client-kyc-approved', name: 'Client真实KYC审核通过',
        expected: '原账号真实KYC终态通过，不以等待审核或单独Dashboard判成功',
        actual: `${config.clientStatusField}=${result.status}`, status: 'passed' });
    });
    report();
    return state;
  } catch (error) {
    if (mutationUnconfirmed) business.requireManualReview('原Admin KYC案件；不得再次Approve或重新注册');
    business.recordPrimaryOracle({ id: 'registration-kyc-completed', name: '注册审核完整闭环',
      expected: 'Admin审核通过并干净登录确认Client KYC通过',
      actual: `保留同一账号和reviewId，阶段=${state.kycStage ?? state.stage}`, status: 'failed' });
    report();
    throw error;
  }
}
