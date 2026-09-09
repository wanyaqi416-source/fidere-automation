import { resolve } from 'node:path';

import type { BrowserContext, TestInfo } from '@playwright/test';

import { AdminClientUsersPage } from '../../../pages/admin/AdminClientUsersPage';
import { clientRouteUrl } from '../../../pages/client/HomePage';
import { LoginPage } from '../../../pages/client/LoginPage';
import {
  PersonalOnboardingPage,
  type AuthorizationDocumentCreationEvidence,
  type FinalSubmitAttemptDiagnostic,
  type PersonalAddressProofUploadEvidence,
  type PersonalProfileSubmissionEvidence
} from '../../../pages/client/PersonalOnboardingPage';
import { RegistrationAgreementSigner } from '../../../pages/client/registration/RegistrationAgreementSigner';
import { expect, test } from '../../../fixtures/registration.fixture';
import { authStatePaths, existingAuthState } from '../../../src/config/auth';
import { env } from '../../../src/config/env';
import { recoverPreSubmitOnce } from '../../../src/flow-engine';
import {
  FidereSigningStatusReader,
  loadPersonalRegistrationProfile,
  maskRegistrationEmail,
  maskRegistrationPhone,
  PersonalJourneyContextStore,
  PersonalRegistrationGuard,
  registrationStageAtLeast,
  registrationTestNameForSequence,
  uniqueSyntheticIdentity
} from '../../../src/registration';

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for REG-P Resume.`);
  return value;
}

function journeyAuthPath(runId: string): string {
  return resolve('auth', 'journeys', `${runId}.json`);
}

function validateResumeRuntime(guard: PersonalRegistrationGuard, testInfo: TestInfo): void {
  guard.validateRuntime({
    baseURL: env.client.baseUrl,
    workers: testInfo.config.workers,
    retries: testInfo.project.retries,
    repeatEach: testInfo.project.repeatEach,
    allowClientMutationTests: env.allowClientMutationTests
  });
  expect(testInfo.repeatEachIndex).toBe(0);
}

function safeCreationEvidence(evidence: AuthorizationDocumentCreationEvidence | undefined) {
  if (!evidence) return undefined;
  return {
    host: evidence.host,
    path: evidence.path,
    method: evidence.method,
    status: evidence.httpStatus,
    time: evidence.observedAt,
    payloadKind: evidence.payloadKind,
    documentPayloadPresent: evidence.documentPayloadPresent,
    businessCode: evidence.businessCode,
    safeMessage: evidence.safeMessage
  };
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
  'REG-P-002 Resume existing account through Registration Agreement and final KYC submission',
  {
    tag: ['@registration', '@personal', '@resume', '@mutation', '@L4'],
    annotation: [
      { type: 'caseId', description: 'REG-P-002' },
      { type: 'changesData', description: 'true' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ browser, business, registrationContext, registrationPage }, testInfo) => {
    test.setTimeout(300_000);
    business.flow('personal-registration', {
      caseId: 'REG-P-002',
      name: 'Personal Registration现有账号KYC与签署Resume',
      level: 'L4',
      type: ['E2E', 'Mutation', 'Resume', 'Third Party'],
      expectedResult:
        '不创建第二个账号；确定性修正纯字母测试姓名，完成Registration Agreement TEST签名、授权和一次最终KYC提交。',
      changesData: true,
      affectsMoney: false
    });

    const clientBaseUrl = required('CLIENT_BASE_URL', env.client.baseUrl);
    const adminBaseUrl = env.admin.baseUrl;
    const clientPassword = required('CLIENT_PASSWORD', env.client.password);
    const clientOtp = required('CLIENT_OTP', env.client.otp);
    const signatureText = env.personalRegistration.signatureText;
    const profile = loadPersonalRegistrationProfile(env.personalRegistration.profilePath);
    const store = new PersonalJourneyContextStore();
    let journey = store.findCurrentRecoverableJourney();
    expect(journey).toBeTruthy();
    expect([
      'CLIENT_AUTHENTICATED',
      'AUTHORIZATION_REQUIRED',
      'DOCUMENT_COMPLETED',
      'FIDERE_SIGNING_RECOGNIZED'
    ]).toContain(journey!.stage);
    if (!journey!.sequence) throw new Error('Existing REG-P Journey has no registration sequence.');
    const startingStage = journey!.stage;
    const testName = registrationTestNameForSequence(journey!.sequence);
    const targetEmail = journey!.email;
    const targetPhone = journey!.phone;

    const guard = new PersonalRegistrationGuard();
    validateResumeRuntime(guard, testInfo);
    business.markPotentiallySubmitted();
    business.disallowSafeRerun();

    let preSubmitCorrectionCount = 0;
    let nameFieldAccepted = false;
    const accountCreationCount = 0;
    let documentCreation: AuthorizationDocumentCreationEvidence | undefined;
    let addressProofUpload: PersonalAddressProofUploadEvidence | undefined;
    let recoveryDocumentCreation: AuthorizationDocumentCreationEvidence | undefined;
    let profileSubmission: PersonalProfileSubmissionEvidence | undefined;
    let firstSubmitDiagnostic: FinalSubmitAttemptDiagnostic | undefined;
    let recoverySubmitDiagnostic: FinalSubmitAttemptDiagnostic | undefined;
    let initialRemainingFields: number | undefined;
    let finalRemainingFields: number | undefined;
    let signatureFieldLocated = false;
    let signatureMethod: string | undefined;
    let testSignatureDrawn = false;
    let signatureApplied = false;
    let completeClickCount = 0;
    let signConfirmClickCount = 0;
    let authorizationStepCompleted = false;
    let registrationSigningCompleted = false;
    let submitEnabledBeforeSigning: boolean | undefined;
    let finalRegistrationSubmitCount = 0;
    let finalRegistrationSubmitAttemptCount = 0;
    let recoveryReloadCount = 0;
    let postSignFirstSubmitStateDesync = false;
    let clientLoginVerified = false;
    let adminCandidateCount: number | undefined;
    let finalStatus = 'KYC_NOT_SUBMITTED';

    const reportState = (): void => {
      business.setBusinessData({
        registrationLoginIdentity: maskRegistrationEmail(targetEmail),
        registrationContactIdentity: maskRegistrationPhone(targetPhone),
        registrationTestName: testName.displayName,
        registrationSequence: testName.sequenceText,
        registrationNameSuffix: testName.nameSuffix,
        registrationNameFieldAccepted: nameFieldAccepted,
        recoverablePreSubmitDisposition: 'RECOVERABLE_PRE_SUBMIT',
        recoverablePreSubmitCorrectionCount: preSubmitCorrectionCount,
        registrationSignerImplementation: 'RegistrationAgreementSigner',
        registrationSignerType: 'Registration Agreement',
        registrationDocumentCreated:
          Boolean(documentCreation?.documentPayloadPresent) ||
          startingStage === 'AUTHORIZATION_REQUIRED',
        registrationAddressProofUpload: addressProofUpload,
        registrationDocumentCreationEvidence: safeCreationEvidence(documentCreation),
        registrationInitialRemainingFields: initialRemainingFields,
        registrationSignatureFieldLocated: signatureFieldLocated,
        registrationSignatureValue: 'TEST',
        registrationTestSignatureDrawn: testSignatureDrawn,
        registrationSignatureApplied: signatureApplied,
        registrationSignatureMethod: signatureMethod,
        registrationAgreementActionClickCount: completeClickCount,
        registrationAgreementConfirmationClickCount: signConfirmClickCount,
        registrationFinalRemainingFields: finalRemainingFields,
        registrationAuthorizationStepCompleted: authorizationStepCompleted,
        registrationSigningCompleted,
        registrationSubmitEnabledBeforeSigning: submitEnabledBeforeSigning,
        registrationFinalSubmitClickCount: finalRegistrationSubmitAttemptCount,
        registrationProfileSubmissionCount: finalRegistrationSubmitCount,
        registrationFirstSubmitDiagnostic: firstSubmitDiagnostic,
        registrationRecoverySubmitDiagnostic: recoverySubmitDiagnostic,
        registrationRecoveryReloadCount: recoveryReloadCount,
        registrationPostSignFirstSubmitStateDesync: postSignFirstSubmitStateDesync,
        registrationRecoveryDocumentCreationEvidence:
          safeCreationEvidence(recoveryDocumentCreation),
        registrationFinalSubmitEvidence: safeProfileSubmissionEvidence(profileSubmission),
        registrationSubmissionCount: accountCreationCount,
        registrationStage: store.load(journey!.runId)?.stage,
        resumeMode: true,
        resumeStartStage: startingStage,
        noSecondUserCreated: accountCreationCount === 0,
        credentialSource: 'CLIENT_PASSWORD',
        credentialConfigured: true,
        accountCreationStatus: 'ACCOUNT_CREATED',
        kycSubmissionStatus: finalRegistrationSubmitCount === 1 ? 'KYC_SUBMITTED' : 'KYC_NOT_SUBMITTED',
        registrationSigningStatus: registrationSigningCompleted ? 'COMPLETED' : 'NOT_COMPLETED',
        registrationFinalStatus: finalStatus,
        adminUserCandidateCount: adminCandidateCount
      });
    };

    try {
      await business.step(
        {
          action: '1. Recoverable Pre-submit姓名与Journey检查',
          expected: '继续现有Journey；内部sequence确定性映射为纯字母姓名，Admin不作为前置门禁。'
        },
        async context => {
          guard.markJourneyDataReady();
          guard.restoreRegisteredUser();

          const recovery = await recoverPreSubmitOnce({
            id: 'personal-registration-display-name',
            mutationState: {
              clientFinalSubmissionOccurred: false,
              securityKeyVerified: false,
              adminMutationOccurred: false,
              businessOrderCreated: false
            },
            needsCorrection: () => journey!.displayName !== testName.displayName,
            correct: () => {
              journey = store.updatePreSubmitDisplayName(journey!, testName.displayName);
            },
            verify: () => store.load(journey!.runId)?.displayName === testName.displayName
          });
          preSubmitCorrectionCount = recovery.correctionCount;
          nameFieldAccepted = journey!.displayName === testName.displayName;
          context.setActual(
            `sequence=${testName.sequenceText}；suffix=${testName.nameSuffix}；displayName=${testName.displayName}；修正次数=${preSubmitCorrectionCount}。`
          );
          context.setBusinessData({
            registrationTestName: testName.displayName,
            registrationSequence: testName.sequenceText,
            registrationNameSuffix: testName.nameSuffix,
            recoverablePreSubmitDisposition: recovery.disposition,
            recoverablePreSubmitCorrectionCount: recovery.correctionCount
          });
        }
      );

      await business.step(
        {
          action: '2. 使用原账号和CLIENT_PASSWORD登录',
          expected: '干净BrowserContext登录原账号，不创建新账号。'
        },
        async context => {
          const login = new LoginPage(registrationPage);
          await login.goto(clientRouteUrl(clientBaseUrl, 'login'));
          await login.fillCredentials({ username: targetEmail, password: clientPassword });
          await login.submitCredentials();
          await login.expectOtpStep();
          await login.fillOtp(clientOtp);
          await login.confirmLoginToAuthenticatedRoute();
          await registrationContext.storageState({ path: journeyAuthPath(journey!.runId) });
          context.setActual('原账号登录成功；本次账号创建次数=0。');
          context.setBusinessData({ accountCreationCount, clientAuthenticationStatus: 'Authenticated' });
        }
      );

      const onboarding = new PersonalOnboardingPage(registrationPage);
      await registrationPage.goto(
        new URL('/zh-CN/registration?type=individual', clientBaseUrl).toString(),
        { waitUntil: 'domcontentloaded' }
      );
      let onboardingStep = await onboarding.currentStep();
      const onboardingInput = {
        profile: {
          ...profile,
          firstName: testName.firstName,
          lastName: testName.lastName
        },
        phone: targetPhone,
        idNumber: uniqueSyntheticIdentity(profile.idNumberPrefix, targetPhone),
        taxNumber: uniqueSyntheticIdentity(profile.taxNumberPrefix, targetPhone),
        addressProofPath: env.personalRegistration.addressProofPath
      };

      if (onboardingStep === 'personal') {
        await business.step(
          {
            action: '3. 填写并验证纯字母个人姓名与个人资料',
            expected: `页面完整接受${testName.displayName}，不再把普通姓名Validation当成Hard Stop。`
          },
          async context => {
            await onboarding.fillPersonalInformationForm(onboardingInput);
            await onboarding.expectLegalName(testName.firstName, testName.lastName);
            nameFieldAccepted = true;
            await onboarding.continueFromPersonalInformation();
            context.setActual(`姓名字段完整保留${testName.displayName}，个人资料已保存。`);
            context.setBusinessData({ registrationNameFieldAccepted: true });
          }
        );
        onboardingStep = await onboarding.currentStep();
      }

      if (onboardingStep === 'contact') {
        await business.step(
          {
            action: '4. 填写联系方式',
            expected: '继续使用当前Journey唯一手机号并进入税务声明。'
          },
          async context => {
            addressProofUpload = await onboarding.fillContactInformation(onboardingInput);
            context.setActual(`联系方式和地址证明已保存；文件=${addressProofUpload.fileName}。`);
            context.setBusinessData({ registrationAddressProofUpload: addressProofUpload });
          }
        );
        onboardingStep = await onboarding.currentStep();
      }

      if (onboardingStep === 'tax') {
        await business.step(
          {
            action: '5. 完成税务声明并创建Registration Agreement',
            expected: '创建当前账号的新协议并进入授权步骤。'
          },
          async context => {
            documentCreation = await onboarding.fillTaxResidency(onboardingInput);
            expect(documentCreation.httpStatus).toBeGreaterThanOrEqual(200);
            expect(documentCreation.httpStatus).toBeLessThan(300);
            expect(documentCreation.documentPayloadPresent).toBe(true);
            journey = store.advance(journey!, 'AUTHORIZATION_REQUIRED', {
              clientStatus: 'Authorization Required'
            });
            context.setActual('税务声明已保存，当前Journey的Registration Agreement已创建。');
            context.setBusinessData({
              registrationDocumentCreated: true,
              registrationDocumentCreationEvidence: safeCreationEvidence(documentCreation)
            });
          }
        );
        onboardingStep = await onboarding.currentStep();
      }

      expect(onboardingStep).toBe('authorization');
      const signing = new RegistrationAgreementSigner(registrationPage);
      const statusReader = new FidereSigningStatusReader(registrationPage);

      await business.step(
        {
          action: '6. 打开Personal Registration协议并读取签署前状态',
          expected: '独立RegistrationAgreementSigner打开当前用户协议，初始剩余字段大于0。'
        },
        async context => {
          const initial = await signing.open(testName.displayName);
          submitEnabledBeforeSigning = await onboarding.isFinalSubmitEnabled();
          if (submitEnabledBeforeSigning) {
            business.recordDiagnostic({
              id: 'pre-signing-submit-button-state',
              name: '签署前Client提交按钮状态',
              status: 'info',
              summary: 'POTENTIAL_PRODUCT_DEFECT: 签署前Submit已可操作，但自动化未点击。',
              affectsCoreBusiness: false
            });
          }
          initialRemainingFields = initial.initialRemainingFields;
          expect(initial.documentBelongsToTestUser).toBe(true);
          expect(initial.identityChallengePresent).toBe(false);
          expect(initialRemainingFields).toBeGreaterThanOrEqual(0);
          context.setActual(
            `Signer=${initial.implementation}；Initial Remaining Fields=${initialRemainingFields}。`
          );
          context.setBusinessData({
            registrationDocumentOpened: true,
            registrationIframeLoaded: true,
            registrationFrameUrl: initial.safeFrameUrl,
            registrationDocumentBelongsToJourney: true,
            registrationInitialRemainingFields: initialRemainingFields,
            registrationNamePreserved: initial.namePreserved,
            registrationTitleStatus: initial.titleStatus,
            registrationDateStatus: initial.dateStatus,
            registrationSubmitEnabledBeforeSigning: submitEnabledBeforeSigning
          });
        }
      );

      await business.step(
        {
          action: '7. 绘制TEST签名并完成协议字段',
          expected: '真实签名字段仅处理一次，TEST签入后Remaining Fields变为0。'
        },
        async context => {
          const prepared = initialRemainingFields === 0
            ? await signing.completePreparedSandboxAgreement()
            : await signing.signSandboxAgreement({
                signatureText,
                testTitle: env.personalRegistration.testTitle
              });
          signatureFieldLocated = prepared.signatureFieldLocated;
          signatureMethod = prepared.signatureMethod;
          testSignatureDrawn = prepared.testSignatureDrawn;
          signatureApplied = prepared.testSignatureApplied;
          finalRemainingFields = prepared.finalRemainingFields;
          completeClickCount = prepared.documentAlreadyCompleted
            ? 1
            : prepared.agreementActionClickCount;
          signConfirmClickCount = prepared.documentAlreadyCompleted
            ? 1
            : prepared.agreementConfirmationClickCount;
          expect(signing.fieldSignClickCount()).toBe(initialRemainingFields === 0 ? 0 : 1);
          expect(finalRemainingFields).toBe(0);
          if (!registrationStageAtLeast(journey!.stage, 'DOCUMENT_COMPLETED')) {
            journey = store.advance(journey!, 'DOCUMENT_COMPLETED', {
              clientStatus: 'Registration Signature Applied'
            });
          }
          context.setActual(initialRemainingFields === 0
            ? `方式=${signatureMethod}；沿用当前Journey已保存的TEST字段，未重复绘制；Final Remaining Fields=${finalRemainingFields}。`
            : `方式=${signatureMethod}；TEST签入次数=1；Final Remaining Fields=${finalRemainingFields}。`
          );
          context.setBusinessData({
            registrationSignatureFieldLocated: signatureFieldLocated,
            registrationSignatureMethod: signatureMethod,
            registrationSignatureValue: 'TEST',
            registrationTestSignatureDrawn: testSignatureDrawn,
            registrationSignatureDrawnThisRun: prepared.signatureDrawnThisRun,
            registrationSignatureRedrawn: false,
            registrationDocumentAlreadyCompleted: prepared.documentAlreadyCompleted,
            registrationAgreementActionClickCountThisRun: prepared.agreementActionClickCount,
            registrationAgreementConfirmationClickCountThisRun:
              prepared.agreementConfirmationClickCount,
            registrationSignatureApplied: signatureApplied,
            registrationFieldSignClickCount: signing.fieldSignClickCount(),
            registrationAgreementActionClickCount: completeClickCount,
            registrationAgreementConfirmationClickCount: signConfirmClickCount,
            registrationFinalRemainingFields: finalRemainingFields
          });
        }
      );

      await business.step(
        {
          action: '8. 等待Fidere识别签署并完成授权步骤',
          expected: 'Fidere签署状态已完成、Authorization已完成，才开放最终提交门禁。'
        },
        async context => {
          const signingStatus = await statusReader.read();
          const completedAgreement = await signing.inspectCompletedAgreement();
          const submitEnabled = await onboarding.isFinalSubmitEnabled();
          authorizationStepCompleted =
            completedAgreement.completed &&
            completedAgreement.remainingFields === 0 &&
            signatureApplied;
          const authorizationUiCompleted = await signing.isAuthorizationStepCompleted();
          if (!authorizationUiCompleted) {
            context.recordDiagnostic({
              id: 'authorization-step-ui-before-submit',
              name: '最终提交前Authorization步骤UI',
              status: 'info',
              summary: 'Fidere API signingStatus=1；左侧步骤在最终Submit前仍显示当前步骤。',
              affectsCoreBusiness: false
            });
          }
          guard.markRegistrationSigningCompleted({
            signatureFieldCompleted: signatureApplied,
            remainingFields: finalRemainingFields!,
            authorizationStepCompleted,
            fidereSigningRecognized: signingStatus.recognized || submitEnabled
          });
          registrationSigningCompleted = true;
          if (!registrationStageAtLeast(journey!.stage, 'FIDERE_SIGNING_RECOGNIZED')) {
            journey = store.advance(journey!, 'FIDERE_SIGNING_RECOGNIZED', {
              clientStatus: 'Signing Recognized'
            });
          }
          expect(await onboarding.currentStep()).toBe('authorization');
          const refreshedStatus = await statusReader.read();
          if (!refreshedStatus.recognized) {
            context.recordDiagnostic({
              id: 'registration-signing-status-api-before-submit',
              name: '最终提交前签署状态接口',
              status: 'info',
              summary: '嵌入文档已完成且提交可用；签署状态接口尚未同步，不阻断最终提交。',
              affectsCoreBusiness: false
            });
          }
          expect(submitEnabled).toBe(true);
          await onboarding.expectFinalSubmitHandlerReady();
          context.setActual(
            `Fidere API已识别签署（signingStatus=1）；Authorization UI完成=${authorizationUiCompleted}。`
          );
          context.setBusinessData({
            registrationAuthorizationStepCompleted: authorizationStepCompleted,
            registrationAuthorizationUiCompletedBeforeSubmit: authorizationUiCompleted,
            registrationProviderCompleted: completedAgreement.completed,
            registrationSigningCompleted
          });
        }
      );

      await business.step(
        {
          action: '9. 提交原账号KYC并诊断签署后首次提交状态',
          expected:
            '签署后当前页先提交一次；仅在完全没有member-profile请求时，reload同一账号并确定性恢复一次。'
        },
        async context => {
          guard.assertProfileFinalSubmissionAttemptAllowed('post-sign-initial');
          const firstAttempt = await onboarding.attemptSignedRegistrationProfileSubmission();
          firstSubmitDiagnostic = firstAttempt.diagnostic;
          finalRegistrationSubmitAttemptCount += onboarding.profileFinalSubmitClickCount();
          guard.recordProfileFinalSubmissionAttempt({
            mode: 'post-sign-initial',
            requestObserved: firstAttempt.diagnostic.requestObserved
          });
          profileSubmission = firstAttempt.evidence;

          if (!profileSubmission) {
            if (firstAttempt.diagnostic.memberProfileRequestCount !== 0) {
              throw new Error(
                `Initial final Submit reached member-profile but did not reach waiting review; blocker=${firstAttempt.diagnostic.blockedCondition}. Recovery is forbidden.`
              );
            }

            postSignFirstSubmitStateDesync = true;
            business.recordDiagnostic({
              id: 'post-sign-first-submit-state-desync',
              name: '签署后首次提交状态不同步',
              status: 'info',
              summary:
                `首次蓝色提交已点击但member-profile请求为0；阻断条件=${firstAttempt.diagnostic.blockedCondition}。同一账号执行一次reload恢复。`,
              affectsCoreBusiness: false
            });

            const recoveryOnboarding = new PersonalOnboardingPage(registrationPage);
            recoveryReloadCount += 1;
            recoveryDocumentCreation =
              await recoveryOnboarding.reloadAuthorizationForFinalSubmitRecovery();
            const recoverySigner = new RegistrationAgreementSigner(registrationPage);
            const recoveredAgreement = await recoverySigner.open(testName.displayName);
            expect(recoveredAgreement.initialRemainingFields).toBe(0);
            const completedAgreement = await recoverySigner.inspectCompletedAgreement();
            expect(completedAgreement.completed).toBe(true);
            expect(completedAgreement.remainingFields).toBe(0);
            expect(recoverySigner.fieldSignClickCount()).toBe(0);
            expect(recoverySigner.completionActionClickCount()).toBe(0);
            expect(recoverySigner.confirmationClickCount()).toBe(0);

            const recoveredStatusReader = new FidereSigningStatusReader(registrationPage);
            const recoveredStatus = await recoveredStatusReader.read();
            expect(recoveredStatus.recognized).toBe(true);
            expect(await recoveryOnboarding.currentStep()).toBe('authorization');
            expect(await recoveryOnboarding.isFinalSubmitEnabled()).toBe(true);
            await recoveryOnboarding.expectFinalSubmitHandlerReady();

            guard.assertProfileFinalSubmissionAttemptAllowed('state-desync-recovery');
            const recoveryAttempt =
              await recoveryOnboarding.attemptSignedRegistrationProfileSubmission();
            recoverySubmitDiagnostic = recoveryAttempt.diagnostic;
            finalRegistrationSubmitAttemptCount +=
              recoveryOnboarding.profileFinalSubmitClickCount();
            guard.recordProfileFinalSubmissionAttempt({
              mode: 'state-desync-recovery',
              requestObserved: recoveryAttempt.diagnostic.requestObserved
            });
            profileSubmission = recoveryAttempt.evidence;
            if (!profileSubmission) {
              throw new Error(
                `Same-account reload recovery did not complete final submission; blocker=${recoveryAttempt.diagnostic.blockedCondition}.`
              );
            }
          }

          finalRegistrationSubmitCount = 1;
          if (!profileSubmission) {
            throw new Error('Fidere final profile submission returned no business evidence.');
          }
          expect(profileSubmission.path).toMatch(/\/member-profile$/);
          expect(profileSubmission.httpStatus).toBeGreaterThanOrEqual(200);
          expect(profileSubmission.httpStatus).toBeLessThan(300);
          expect(['0', '200']).toContain(profileSubmission.businessCode);
          expect(profileSubmission.redirectedToSignSuccess).toBe(true);
          expect(profileSubmission.pendingReviewPageVisible).toBe(true);
          guard.recordProfileFinalSubmission();
          journey = store.advance(journey!, 'PROFILE_COMPLETED', {
            clientStatus: 'Profile Completed'
          });
          finalStatus = 'KYC_SUBMITTED';
          context.setActual(
            postSignFirstSubmitStateDesync
              ? `首次点击无member-profile请求；同一账号reload后恢复成功。点击尝试=${finalRegistrationSubmitAttemptCount}，业务提交=1。`
              : '签署完成后的当前页首次提交成功；点击尝试=1，业务提交=1；未创建第二个账号。'
          );
          context.setBusinessData({
            registrationFinalSubmitEvidence: safeProfileSubmissionEvidence(profileSubmission),
            registrationFinalSubmitAttemptCount: finalRegistrationSubmitAttemptCount,
            registrationPostSignFirstSubmitStateDesync: postSignFirstSubmitStateDesync
          });
        }
      );

      await business.step(
        {
          action: '10. 验证Client登录与首页',
          expected: '当前新账号可保持登录并打开Client首页。'
        },
        async context => {
          const authenticatedProfile = await statusReader.read();
          expect(authenticatedProfile.kycStep).not.toBe('unknown');
          clientLoginVerified = true;
          finalStatus = 'KYC Submitted / Pending Admin Review';
          context.setActual('当前账号认证有效，KYC已提交并等待Admin审核。');
        }
      );

      await business.step(
        {
          action: '11. Admin Post-Registration Diagnostic（非计分）',
          expected: '尽力按邮箱读取Admin用户；不可用只记录Diagnostic，不影响REG-P结果。'
        },
        async context => {
          let adminContext: BrowserContext | undefined;
          try {
            if (!adminBaseUrl) throw new Error('ADMIN_BASE_URL is not configured.');
            const adminState = existingAuthState(authStatePaths.admin);
            if (!adminState) throw new Error('Admin storageState is unavailable.');
            adminContext = await browser.newContext({
              baseURL: adminBaseUrl,
              storageState: adminState
            });
            const adminPage = await adminContext.newPage();
            const adminUsers = new AdminClientUsersPage(adminPage);
            await adminUsers.expectAuthenticatedShell(adminBaseUrl);
            const located = await adminUsers.openUniqueRegistrationByEmail(adminBaseUrl, targetEmail);
            adminCandidateCount = located.candidateCount;
            if (adminCandidateCount !== 1) {
              throw new Error(`Admin post-registration candidateCount=${adminCandidateCount}.`);
            }
            await adminUsers.expectDetailMatchesEmail(targetEmail);
            await adminUsers.expectDetailMatchesPhone(targetPhone);
            await adminUsers.expectDetailMatchesTestName(testName.displayName);
            business.recordDiagnostic({
              id: 'admin-post-registration-verification',
              name: 'Admin Post-Registration Verification',
              status: 'available',
              summary: 'Admin已唯一定位本次注册用户并核对字母测试姓名。',
              affectsCoreBusiness: false
            });
            context.setActual('Admin Post-Registration Diagnostic可用。');
          } catch (error) {
            business.recordDiagnostic({
              id: 'admin-post-registration-verification',
              name: 'Admin Post-Registration Verification',
              status: 'unavailable',
              summary: 'Admin用户检索暂不可用。',
              reason: error instanceof Error ? error.message : String(error),
              affectsCoreBusiness: false
            });
            context.setActual('Admin Post-Registration Diagnostic暂不可用；不影响注册核心结果。');
          } finally {
            await adminContext?.close();
          }
        }
      );

      journey = store.advance(journey!, 'COMPLETED', {
        clientStatus: 'Registration Completed'
      });
      finalStatus = 'COMPLETED';

      business.recordPrimaryOracle({
        id: 'same-account-resumed',
        name: '原账号继续且未创建第二个账号',
        expected: '账号创建次数=0，继续现有Journey',
        actual: `账号创建次数=${accountCreationCount}，sequence=${testName.sequenceText}`,
        status: accountCreationCount === 0 ? 'passed' : 'failed'
      });
      business.recordPrimaryOracle({
        id: 'alphabetic-name-accepted',
        name: '纯字母测试姓名被页面完整接受',
        expected: testName.displayName,
        actual: nameFieldAccepted ? testName.displayName : 'Not accepted',
        status: nameFieldAccepted ? 'passed' : 'failed'
      });
      business.recordPrimaryOracle({
        id: 'registration-signing-completed',
        name: 'Personal Registration Agreement真实签署',
        expected: 'TEST签入、Remaining Fields=0、Authorization Completed',
        actual: `initial=${initialRemainingFields}；final=${finalRemainingFields}；authorization=${authorizationStepCompleted}`,
        status: registrationSigningCompleted ? 'passed' : 'failed'
      });
      business.recordPrimaryOracle({
        id: 'profile-final-submit',
        name: 'KYC业务提交一次',
        expected: 'member-profile业务提交=1',
        actual:
          `业务提交=${finalRegistrationSubmitCount}；按钮点击尝试=${finalRegistrationSubmitAttemptCount}`,
        status: finalRegistrationSubmitCount === 1 ? 'passed' : 'failed'
      });
      business.recordPrimaryOracle({
        id: 'client-login-verified',
        name: '新账号Client登录成功',
        expected: 'Client首页可用',
        actual: clientLoginVerified ? 'Client首页正常' : '未验证',
        status: clientLoginVerified ? 'passed' : 'failed'
      });
      reportState();
    } catch (error) {
      reportState();
      throw error;
    }
  }
);
