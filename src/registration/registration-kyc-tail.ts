import { expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { RegistrationReviewDashboardPage } from '../../pages/admin/RegistrationReviewDashboardPage';
import { RegistrationProcessingReviewsPage } from '../../pages/admin/RegistrationProcessingReviewsPage';
import { RegistrationReviewProcessPage } from '../../pages/admin/RegistrationReviewProcessPage';
import { RegistrationKycStatusPage } from '../../pages/client/RegistrationKycStatusPage';
import { env } from '../config/env';
import { assertSandboxEnvironment, MoneyMutationGuard } from '../flow-engine/mutation-guard';
import type { BusinessReportApi } from '../reporting/business-report.types';
import { completeRegistrationKyc, type RegistrationKycDriver } from './registration-kyc-approval';
import { RegistrationAdminApprovalJourneyStore } from './registration-admin-approval-journey';
import { assertRegistrationCaseIdentity, REGISTRATION_KYC, type RegistrationAccountType, type RegistrationKycCase, type RegistrationKycSource } from './registration-kyc-contract';
import { PersonalJourneyContextStore, registrationStageAtLeast } from './personal-registration-state';
import { CorporateRegistrationJourneyStore, corporateJourneyStageAtLeast } from './corporate-registration-journey';
import { PersonalPostRegistrationJourneyStore, postRegistrationStageAtLeast } from '../journey/personal-post-registration-journey';

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for the Registration KYC tail.`);
  return value;
}

export function registrationKycRuntime(testInfo: TestInfo) {
  return {
    baseURL: required('ADMIN_BASE_URL', env.admin.baseUrl), workers: testInfo.config.workers,
    retries: testInfo.project.retries, repeatEach: testInfo.project.repeatEach,
    safetySwitches: { ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests }
  };
}

export async function preflightRegistrationAdmin(adminPage: Page, testInfo: TestInfo): Promise<void> {
  const runtime = registrationKycRuntime(testInfo);
  new MoneyMutationGuard('registration-kyc').validateRuntime(runtime);
  assertSandboxEnvironment(env.client.baseUrl);
  await new RegistrationReviewDashboardPage(adminPage).goto(runtime.baseURL, { waitForTable: false });
}

export function rememberRegistrationSubmission(source: RegistrationKycSource) {
  const config = REGISTRATION_KYC[source.accountType];
  const store = new RegistrationAdminApprovalJourneyStore(config.storageType, source.runId);
  const state = store.initialize({
    flowId: config.flowId, sourceRunId: source.runId, displayName: source.displayName,
    email: source.email, userId: source.userId, reviewId: source.reviewId,
    clientSubmittedAt: source.clientSubmittedAt
  });
  store.markActive(source.runId);
  return state;
}

export function pendingRegistrationApprovalRunId(accountType: RegistrationAccountType, requestedEmail?: string): string | undefined {
  const storageType = REGISTRATION_KYC[accountType].storageType;
  const runId = RegistrationAdminApprovalJourneyStore.activeSourceRunId(storageType);
  if (!runId) return undefined;
  const state = new RegistrationAdminApprovalJourneyStore(storageType, runId).load();
  if (!state || state.kycVerifiedAt) return undefined;
  if (requestedEmail && requestedEmail.trim().toLowerCase() !== state.email.trim().toLowerCase()) {
    throw new Error('REGISTRATION_KYC_PENDING_OTHER_ACCOUNT: finish the pinned registration; do not create a replacement.');
  }
  return runId;
}

export function submittedRegistrationSource(accountType: RegistrationAccountType, runId: string): RegistrationKycSource {
  if (!/^[A-Z0-9._-]+$/i.test(runId)) throw new Error('An explicit existing Registration runId is required.');
  if (accountType === 'PERSONAL') {
    const source = new PersonalJourneyContextStore().load(runId);
    if (!source?.displayName || !registrationStageAtLeast(source.stage, 'PROFILE_COMPLETED')) {
      throw new Error('PERSONAL_REGISTRATION_NOT_SUBMITTED: Resume existing Client KYC, do not register another user.');
    }
    return { accountType, runId, email: source.email, displayName: source.displayName,
      userId: source.userId, clientSubmittedAt: source.clientSubmittedAt };
  }
  const source = new CorporateRegistrationJourneyStore().loadRun(runId);
  if (!source || source.finalSubmitCount !== 1 || !corporateJourneyStageAtLeast(source.stage, 'KYC_SUBMITTED')) {
    throw new Error('BUSINESS_REGISTRATION_NOT_SUBMITTED: Resume existing Client KYC, do not register another user.');
  }
  return { accountType, runId, email: source.email, displayName: source.companyName ?? source.displayName,
    userId: source.userId, clientSubmittedAt: source.clientSubmittedAt };
}

export async function runRegistrationKycTail(input: {
  source: RegistrationKycSource; browser: Browser; adminPage: Page; business: BusinessReportApi; testInfo: TestInfo;
}) {
  const { source, browser, adminPage, business, testInfo } = input;
  const config = REGISTRATION_KYC[source.accountType];
  const adminURL = required('ADMIN_BASE_URL', env.admin.baseUrl);
  const clientURL = required('CLIENT_BASE_URL', env.client.baseUrl);
  const login = () => RegistrationKycStatusPage.cleanLogin({
    browser, baseURL: clientURL, email: source.email,
    password: required('CLIENT_PASSWORD', env.client.password),
    otp: required('CLIENT_OTP', env.client.otp ?? env.personalRegistration.otp)
  });
  let processPage = new RegistrationReviewProcessPage(adminPage);
  const read = async (path: string) => {
    processPage = new RegistrationReviewProcessPage(adminPage);
    return processPage.readKycCase(source.accountType, path, adminURL);
  };
  const driver: RegistrationKycDriver = {
    async preflight() {
      await preflightRegistrationAdmin(adminPage, testInfo);
      const session = await login();
      try { await session.statusPage.read(source); } finally { await session.context.close(); }
    },
    async locate(state) {
      const dashboard = new RegistrationReviewDashboardPage(adminPage);
      await dashboard.goto(adminURL);
      await dashboard.selectAccountType(config.storageType);
      if (state.processPath && state.reviewId) {
        const candidate = await read(state.processPath);
        assertRegistrationCaseIdentity(source, candidate, state);
        return { candidateCount: 1, candidate, stages: [{ field: `${config.tab} / 固定原reviewId详情`, count: 1 }] };
      }
      const result = await dashboard.locateUniquePendingCandidate({
        accountType: config.storageType, email: source.email, displayName: source.displayName,
        reviewId: state.reviewId ?? source.reviewId, userId: state.userId ?? source.userId
      });
      if (result.candidateCount === 1) {
        return { candidateCount: 1, candidate: await read(result.candidates[0].processUrl), stages: result.candidateStages };
      }
      if (result.candidateCount > 1) return { candidateCount: result.candidateCount, stages: result.candidateStages };
      // A previously started case can leave the pending tab. Only Resume a pinned
      // review in processing, never substitute another pending case for that user.
      if (state.reviewId) {
        const processing = new RegistrationProcessingReviewsPage(adminPage);
        await processing.goto(adminURL);
        const resumed = await processing.locateCandidate({ email: source.email,
          displayName: source.displayName, reviewId: state.reviewId });
        return { candidateCount: resumed.candidateCount,
          candidate: resumed.candidateCount === 1 ? await read(resumed.candidates[0].processUrl) : undefined,
          stages: [...result.candidateStages, { field: '处理中 / 固定原reviewId', count: resumed.candidateCount }] };
      }
      return { candidateCount: 0, stages: result.candidateStages };
    },
    async readOriginal(candidate) { return read(candidate.processPath); },
    async prepareApproval(candidate, note) {
      await processPage.verifyIdentityAndType({ accountType: config.storageType, displayName: source.displayName });
      if ((candidate.step === 'doc_review' || source.accountType === 'BUSINESS') && !candidate.signed) {
        throw new Error('KYC_DOCUMENTS_NOT_SIGNED: no approval performed.');
      }
      if (source.accountType === 'BUSINESS') await processPage.verifyCorporateSubmissionCompleteness();
      await processPage.expectCurrentApprovalForm();
      await processPage.fillApprovalForm(note);
    },
    async approveOnce() { return processPage.confirmApproveOnce(); },
    async waitForAdvance(before) {
      let after: RegistrationKycCase = before;
      await expect.poll(async () => {
        after = await read(before.processPath);
        assertRegistrationCaseIdentity(source, after, before);
        return after.approved || after.rejected || after.completedSteps.includes(before.step);
      }, { timeout: 90_000, intervals: [1_000, 2_000, 5_000],
        message: 'Original KYC case did not confirm the attempted approval; never click again.' }).toBe(true);
      return after;
    },
    async verifyClientWithCleanLogin() {
      const session = await login();
      try { return await session.statusPage.expectApproved(source, clientURL); }
      finally { await session.context.close(); }
    }
  };
  const store = new RegistrationAdminApprovalJourneyStore(config.storageType, source.runId);
  rememberRegistrationSubmission(source);
  const postStore = new PersonalPostRegistrationJourneyStore(source.runId);
  const legacyPost = postStore.load();
  if (legacyPost && (legacyPost.email !== source.email || legacyPost.accountType !== source.accountType)) {
    throw new Error('KYC_POST_REGISTRATION_IDENTITY_MISMATCH');
  }
  if (source.accountType === 'PERSONAL' && legacyPost?.documentApproveCount === 1) {
    const state = store.load()!;
    if (state.reviewId && legacyPost.reviewId && state.reviewId !== legacyPost.reviewId) {
      throw new Error('KYC_LEGACY_REVIEW_ID_MISMATCH');
    }
    if (!state.approvalAttempts?.some(attempt => attempt.step === 'doc_review')) {
      store.updateKyc(state, { reviewId: state.reviewId ?? legacyPost.reviewId, adminApproveCount: 1,
        approvalAttempts: [...state.approvalAttempts ?? [], { step: 'doc_review', attemptedAt: legacyPost.updatedAt }] });
    }
  }
  const result = await completeRegistrationKyc({ source, business, driver, store,
    runtime: registrationKycRuntime(testInfo) });
  const post = postStore.initialize({ accountType: source.accountType, displayName: source.displayName,
    email: source.email, reviewId: result.reviewId });
  if (!postRegistrationStageAtLeast(post.stage, 'CLIENT_USABLE')) {
    postStore.advance(post, 'CLIENT_USABLE', { reviewId: result.reviewId,
      profileApproveCount: result.approvalAttempts?.some(item => item.step === 'info_review') ? 1 : post.profileApproveCount,
      documentApproveCount: result.approvalAttempts?.some(item => item.step === 'doc_review') ? 1 : post.documentApproveCount });
  }
  return result;
}
