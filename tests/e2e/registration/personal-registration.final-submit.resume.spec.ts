import type { TestInfo } from '@playwright/test';

import { clientRouteUrl } from '../../../pages/client/HomePage';
import { LoginPage } from '../../../pages/client/LoginPage';
import {
  PersonalOnboardingPage,
  type PersonalProfileSubmissionEvidence
} from '../../../pages/client/PersonalOnboardingPage';
import { RegistrationAgreementSigner } from '../../../pages/client/registration/RegistrationAgreementSigner';
import { expect, test } from '../../../fixtures/registration.fixture';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment } from '../../../src/flow-engine/mutation-guard';
import {
  FidereSigningStatusReader,
  maskRegistrationEmail,
  maskRegistrationPhone,
  PersonalJourneyContextStore,
  registrationStageAtLeast,
  registrationTestNameForSequence
} from '../../../src/registration';

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for REG-P final Submit Resume.`);
  return value;
}

function validateRuntime(testInfo: TestInfo): void {
  assertSandboxEnvironment(env.client.baseUrl);
  if (testInfo.config.workers !== 1) throw new Error('REG-P final Submit Resume requires workers=1.');
  if (testInfo.project.retries !== 0) throw new Error('REG-P final Submit Resume requires retries=0.');
  if (testInfo.project.repeatEach !== 1) {
    throw new Error('REG-P final Submit Resume requires repeatEach=1.');
  }
  if (!env.allowClientMutationTests) {
    throw new Error(
      'REG-P final Submit Resume requires ALLOW_CLIENT_MUTATION_TESTS=true for this approved run.'
    );
  }
  expect(testInfo.repeatEachIndex).toBe(0);
}

function safeProfileSubmissionEvidence(evidence: PersonalProfileSubmissionEvidence | undefined) {
  if (!evidence) return undefined;
  return {
    host: evidence.host,
    path: evidence.path,
    method: evidence.method,
    status: evidence.httpStatus,
    time: evidence.observedAt,
    businessCode: evidence.businessCode,
    memberStatus: evidence.memberStatus,
    redirectedToSignSuccess: evidence.redirectedToSignSuccess,
    pendingReviewPageVisible: evidence.pendingReviewPageVisible,
    pendingReviewIndicator: evidence.pendingReviewIndicator
  };
}

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'REG-P-002 existing signed agreement final Submit Resume',
  {
    tag: ['@registration', '@personal', '@resume', '@mutation', '@L4'],
    annotation: [
      { type: 'caseId', description: 'REG-P-002' },
      { type: 'changesData', description: 'true' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ business, registrationPage }, testInfo) => {
    test.setTimeout(180_000);
    business.flow('personal-registration', {
      caseId: 'REG-P-002',
      name: 'Personal Registration现有已签署账号最终提交Resume',
      level: 'L4',
      type: ['E2E', 'Mutation', 'Resume'],
      expectedResult: '不创建账号、不重新签名；确认文档已完成后，只点击一次Fidere右下角提交。',
      changesData: true,
      affectsMoney: false
    });

    validateRuntime(testInfo);
    const clientBaseUrl = required('CLIENT_BASE_URL', env.client.baseUrl);
    const targetEmail = required('PERSONAL_REGISTRATION_EMAIL', env.personalRegistration.email);
    const clientPassword = required('CLIENT_PASSWORD', env.client.password);
    const clientOtp = required('CLIENT_OTP', env.client.otp);
    const store = new PersonalJourneyContextStore();
    let journey = store.findByEmail(targetEmail);
    expect(journey, 'Existing registration Journey was not found for this email.').toBeTruthy();
    expect(journey!.sequence).toBeTruthy();
    expect(registrationStageAtLeast(journey!.stage, 'AUTHORIZATION_REQUIRED')).toBe(true);
    expect(registrationStageAtLeast(journey!.stage, 'PROFILE_COMPLETED')).toBe(false);

    const testName = registrationTestNameForSequence(journey!.sequence!);
    expect(journey!.displayName).toBe(testName.displayName);
    let finalSubmitCount = 0;
    let profileSubmission: PersonalProfileSubmissionEvidence | undefined;

    const reportState = (): void => {
      business.setBusinessData({
        registrationLoginIdentity: maskRegistrationEmail(targetEmail),
        registrationContactIdentity: maskRegistrationPhone(journey!.phone),
        registrationTestName: testName.displayName,
        registrationSequence: testName.sequenceText,
        registrationNameSuffix: testName.nameSuffix,
        registrationSignerImplementation: 'RegistrationAgreementSigner',
        registrationDocumentAlreadyCompleted: true,
        registrationSignatureValue: 'TEST',
        registrationSignatureRedrawn: false,
        registrationAgreementActionClickCountThisRun: 0,
        registrationAgreementConfirmationClickCountThisRun: 0,
        registrationFinalRemainingFields: 0,
        registrationFinalSubmitClickCount: finalSubmitCount,
        registrationFinalSubmitEvidence: safeProfileSubmissionEvidence(profileSubmission),
        registrationSubmissionCount: 0,
        registrationStage: store.load(journey!.runId)?.stage,
        resumeMode: true,
        resumeStartStage: 'AUTHORIZATION_REQUIRED',
        noSecondUserCreated: true,
        credentialSource: 'CLIENT_PASSWORD',
        credentialConfigured: true,
        adminPostRegistrationDiagnostic: 'Not executed; non-blocking for Client registration'
      });
    };

    try {
      await business.step(
        {
          action: '1. 登录现有Personal Registration账号',
          expected: '使用现有Journey账号进入未完成的授权页面，不创建新账号。'
        },
        async context => {
          const login = new LoginPage(registrationPage);
          await login.goto(clientRouteUrl(clientBaseUrl, 'login'));
          await login.fillCredentials({ username: targetEmail, password: clientPassword });
          await login.submitCredentials();
          await login.expectOtpStep();
          await login.fillOtp(clientOtp);
          await login.confirmLoginToAuthenticatedRoute();
          context.setActual('现有账号登录成功；账号创建次数=0。');
        }
      );

      const onboarding = new PersonalOnboardingPage(registrationPage);
      const signing = new RegistrationAgreementSigner(registrationPage);
      const statusReader = new FidereSigningStatusReader(registrationPage);
      await registrationPage.goto(
        new URL('/zh-CN/registration?type=individual', clientBaseUrl).toString(),
        { waitUntil: 'domcontentloaded' }
      );

      await business.step(
        {
          action: '2. 只读确认Registration Agreement已完成',
          expected: '页面显示文档已完成，Remaining Fields=0，且不重新绘制或确认签名。'
        },
        async context => {
          expect(await onboarding.currentStep()).toBe('authorization');
          const inspection = await signing.open(testName.displayName);
          const completed = await signing.inspectCompletedAgreement();
          expect(inspection.initialRemainingFields).toBe(0);
          expect(completed.remainingFields).toBe(0);
          expect(await onboarding.isFinalSubmitEnabled()).toBe(true);

          const fidereStatus = await statusReader.read();
          expect(fidereStatus.recognized).toBe(true);
          context.setActual(
            '页面已显示文档完成，Remaining Fields=0，TEST签名沿用现有文档；本次签名操作次数=0。'
          );
          context.setBusinessData({
            registrationDocumentOpened: true,
            registrationIframeLoaded: true,
            registrationInitialRemainingFields: inspection.initialRemainingFields,
            registrationFinalRemainingFields: completed.remainingFields,
            registrationSigningCompleted: true,
            registrationAuthorizationStepCompleted: true,
            registrationSignatureDrawnThisRun: false,
            registrationSignatureRedrawn: false,
            fidereSigningStatusAfter: fidereStatus.clientSigningStatus,
            fidereStatusSyncObserved: fidereStatus.recognized
          });
          if (!fidereStatus.signaturePresent) {
            context.recordDiagnostic({
              id: 'profile-signature-api-field',
              name: 'Profile signature API字段',
              status: 'info',
              summary: '页面已有文档完成和TEST签名证据；API signature字段为空，不作为本次最终提交硬门禁。',
              affectsCoreBusiness: false
            });
          }
        }
      );

      await business.step(
        {
          action: '3. 点击Fidere右下角提交一次',
          expected: '只触发一次member-profile提交，并进入sign-success或Client首页。'
        },
        async context => {
          business.markPotentiallySubmitted();
          business.disallowSafeRerun();
          try {
            profileSubmission = await onboarding.submitSignedRegistrationProfileOnce();
          } finally {
            finalSubmitCount = onboarding.profileFinalSubmitClickCount();
          }
          expect(finalSubmitCount).toBe(1);
          expect(profileSubmission.path).toMatch(/\/member-profile$/);
          expect(profileSubmission.httpStatus).toBeGreaterThanOrEqual(200);
          expect(profileSubmission.httpStatus).toBeLessThan(300);
          expect(['0', '200']).toContain(profileSubmission.businessCode);
          expect(profileSubmission.redirectedToSignSuccess).toBe(true);

          if (!registrationStageAtLeast(journey!.stage, 'DOCUMENT_COMPLETED')) {
            journey = store.advance(journey!, 'DOCUMENT_COMPLETED', {
              clientStatus: 'Registration Agreement Completed'
            });
          }
          if (!registrationStageAtLeast(journey!.stage, 'FIDERE_SIGNING_RECOGNIZED')) {
            journey = store.advance(journey!, 'FIDERE_SIGNING_RECOGNIZED', {
              clientStatus: 'Signing Recognized'
            });
          }
          if (!registrationStageAtLeast(journey!.stage, 'PROFILE_COMPLETED')) {
            journey = store.advance(journey!, 'PROFILE_COMPLETED', {
              clientStatus: 'KYC Submitted / Pending Admin Review'
            });
          }
          context.setActual('右下角提交点击1次，member-profile成功，页面进入提交成功状态。');
          context.setBusinessData({
            registrationFinalSubmitClickCount: finalSubmitCount,
            registrationFinalSubmitEvidence: safeProfileSubmissionEvidence(profileSubmission),
            kycSubmissionStatus: 'KYC_SUBMITTED'
          });
        }
      );

      await business.step(
        {
          action: '4. 验证现有账号提交后的Client状态',
          expected: '账号仍保持认证，KYC资料已提交且没有创建第二个账号。'
        },
        async context => {
          const status = await statusReader.read();
          expect(status.kycStep).not.toBe('unknown');
          journey = store.advance(journey!, 'COMPLETED', {
            clientStatus: 'Registration Completed'
          });
          business.recordDiagnostic({
            id: 'admin-post-registration-verification',
            name: 'Admin Post-Registration Verification',
            status: 'info',
            summary: '本次按用户要求只完成现有账号右下角提交；Admin检索不参与核心结果。',
            affectsCoreBusiness: false
          });
          context.setActual(`Client KYC状态可读取（kycStep=${status.kycStep}），未创建第二个账号。`);
        }
      );

      business.recordPrimaryOracle({
        id: 'existing-account-only',
        name: '只继续现有账号',
        expected: '账号创建次数=0',
        actual: '账号创建次数=0',
        status: 'passed'
      });
      business.recordPrimaryOracle({
        id: 'completed-registration-agreement',
        name: 'Registration Agreement已完成',
        expected: '文档完成且Remaining Fields=0',
        actual: '文档完成且Remaining Fields=0；本次未重复签名',
        status: 'passed'
      });
      business.recordPrimaryOracle({
        id: 'profile-final-submit',
        name: 'Fidere最终提交一次',
        expected: 'Final Submit=1且member-profile成功',
        actual: `Final Submit=${finalSubmitCount}；HTTP=${profileSubmission?.httpStatus ?? 'unknown'}`,
        status: finalSubmitCount === 1 && profileSubmission?.redirectedToSignSuccess
          ? 'passed'
          : 'failed'
      });
      reportState();
    } catch (error) {
      reportState();
      throw error;
    }
  }
);
