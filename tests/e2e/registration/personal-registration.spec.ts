import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type { BrowserContext, TestInfo } from '@playwright/test';

import { AdminClientUsersPage } from '../../../pages/admin/AdminClientUsersPage';
import { AccountTypeSelectionPage } from '../../../pages/client/AccountTypeSelectionPage';
import { HomePage, clientRouteUrl } from '../../../pages/client/HomePage';
import { LoginPage } from '../../../pages/client/LoginPage';
import {
  PersonalOnboardingPage,
  type AuthorizationDocumentCreationEvidence,
  type FinalSubmitAttemptDiagnostic,
  type PersonalAddressProofUploadEvidence,
  type PersonalProfileSubmissionEvidence
} from '../../../pages/client/PersonalOnboardingPage';
import { PersonalRegistrationPage } from '../../../pages/client/PersonalRegistrationPage';
import { RegistrationAgreementSigner } from '../../../pages/client/registration/RegistrationAgreementSigner';
import { expect, test } from '../../../fixtures/registration.fixture';
import { authStatePaths, existingAuthState } from '../../../src/config/auth';
import { env } from '../../../src/config/env';
import { pendingRegistrationApprovalRunId, preflightRegistrationAdmin, rememberRegistrationSubmission, runRegistrationKycTail, submittedRegistrationSource } from '../../../src/registration/registration-kyc-tail';
import {
  FidereSigningStatusReader,
  loadPersonalRegistrationProfile,
  maskRegistrationEmail,
  maskRegistrationPhone,
  PersonalJourneyContextStore,
  PersonalRegistrationGuard,
  registrationTestNameForSequence,
  RegistrationSequenceStore,
  SigningNetworkEvidenceRecorder,
  TestUserFactory,
  summarizeFidereSigningStatus,
  uniqueSyntheticIdentity,
  type FidereSigningStatusSnapshot,
  type PersonalJourneyContext,
  type FreshPersonalTestIdentity,
  type SafeSigningNetworkObservation,
  type SafeStatusRequestEvidence
} from '../../../src/registration';

test.describe.configure({ mode: 'serial', retries: 0 });

type SigningConclusion = 'A' | 'B' | 'C' | 'D' | 'UNDETERMINED';

function requireValue(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for REG-P-002.`);
  return value;
}

function createRunId(now = new Date()): string {
  return `REGP-${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
}

function journeyAuthPath(runId: string): string {
  return resolve('auth', 'journeys', `${runId}.json`);
}

function addBlocker(testInfo: TestInfo, description: string): void {
  if (!testInfo.annotations.some(annotation => annotation.type === 'blocker')) {
    testInfo.annotations.push({ type: 'blocker', description });
  }
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
    documentPayloadPresent: evidence.documentPayloadPresent
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

test(
  'REG-P-002 Personal Registration Agreement hard gate',
  {
    tag: ['@registration', '@personal', '@mutation', '@L4'],
    annotation: [
      { type: 'caseId', description: 'REG-P-002' },
      { type: 'changesData', description: 'true' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ browser, business, registrationContext, registrationPage, adminPage }, testInfo) => {
    test.setTimeout(900_000);
    business.flow('personal-registration', {
      caseId: 'REG-P-002',
      name: 'Fresh Personal Registration Agreement完整注册闭环',
      level: 'L4',
      type: ['E2E', 'Mutation', 'Third Party'],
      expectedResult:
        '同一Sandbox个人用户完成资料和签署提交后，在个人用户Tab完成KYC审核，干净登录确认Client审核通过。',
      changesData: true,
      affectsMoney: false
    });

    const clientBaseUrl = requireValue('CLIENT_BASE_URL', env.client.baseUrl);
    await preflightRegistrationAdmin(adminPage, testInfo);
    const submittedUser = env.personalRegistration.email
      ? new PersonalJourneyContextStore().findByEmail(env.personalRegistration.email) : undefined;
    const approvalRunId = process.env.PERSONAL_REGISTRATION_APPROVAL_SOURCE_RUN_ID?.trim() || env.personalRegistration.adminApprovalSourceRunId ||
      (submittedUser && ['PROFILE_COMPLETED', 'ADMIN_USER_LOCATED', 'COMPLETED'].includes(submittedUser.stage)
        ? submittedUser.runId : undefined) || pendingRegistrationApprovalRunId('PERSONAL', env.personalRegistration.email);
    if (approvalRunId) {
      await runRegistrationKycTail({ source: submittedRegistrationSource('PERSONAL', approvalRunId),
        browser, adminPage, business, testInfo });
      return;
    }
    const adminBaseUrl = env.admin.baseUrl;
    const clientPassword = requireValue('CLIENT_PASSWORD', env.client.password);
    const registerOtp = requireValue('CLIENT_REGISTER_OTP', env.personalRegistration.otp);
    const profile = loadPersonalRegistrationProfile(env.personalRegistration.profilePath);
    const registrationSignatureText = env.personalRegistration.signatureText;
    const registrationTestTitle = env.personalRegistration.testTitle;
    const guard = new PersonalRegistrationGuard();
    guard.validateRuntime({
      baseURL: clientBaseUrl,
      workers: testInfo.config.workers,
      retries: testInfo.project.retries,
      repeatEach: testInfo.project.repeatEach,
      allowClientMutationTests: env.allowClientMutationTests
    });
    expect(testInfo.repeatEachIndex).toBe(0);

    const store = new PersonalJourneyContextStore();
    const factory = new TestUserFactory(
      env.personalRegistration.dataPoolPath,
      store,
      new RegistrationSequenceStore(env.personalRegistration.sequencePath)
    );

    let journey: PersonalJourneyContext | undefined;
    let data: FreshPersonalTestIdentity | undefined;
    let registrationSubmissionCount = 0;
    let finalRegistrationSubmitCount = 0;
    let finalRegistrationSubmitAttemptCount = 0;
    let firstSubmitDiagnostic: FinalSubmitAttemptDiagnostic | undefined;
    let recoverySubmitDiagnostic: FinalSubmitAttemptDiagnostic | undefined;
    let recoveryReloadCount = 0;
    let postSignFirstSubmitStateDesync = false;
    let recoveryDocumentCreation: AuthorizationDocumentCreationEvidence | undefined;
    let adminCandidateCount = 0;
    let documentCreation: AuthorizationDocumentCreationEvidence | undefined;
    let addressProofUpload: PersonalAddressProofUploadEvidence | undefined;
    let profileSubmission: PersonalProfileSubmissionEvidence | undefined;
    let documentCreated = false;
    let documentOpened = false;
    let documentIframeLoaded = false;
    let documentBelongsToCurrentJourney = false;
    let staleDraftDetected = false;
    let fieldsRemainingBefore: number | undefined;
    let fieldsRemainingAfter: number | undefined;
    let signatureFieldLocated = false;
    let signatureMethod: string | undefined;
    let namePreserved = false;
    let titleStatus: string | undefined;
    let dateStatus: string | undefined;
    let authorizationStepCompleted = false;
    let registrationSigningCompleted = false;
    let signatureFieldCompleted = false;
    let testSignatureDrawn = false;
    let registrationFieldSignCount = 0;
    let completeClickCount = 0;
    let signConfirmClickCount = 0;
    let registrationProviderCompleted = false;
    let fidereSigningStatusBefore: FidereSigningStatusSnapshot | undefined;
    let fidereSigningStatusAfter: FidereSigningStatusSnapshot | undefined;
    let submitEnabledBeforeSigning: boolean | undefined;
    let submitGateWarning = false;
    let submitEnabledAfterSigning: boolean | undefined;
    let fidereStatusSyncObserved = false;
    let signingDiagnosticConclusion: SigningConclusion = 'UNDETERMINED';
    let registrationFailureCategory = 'NONE';
    let registrationFinalStatus: string | undefined;
    let documentFrameUrl: string | undefined;
    let browserNetworkObservations: SafeSigningNetworkObservation[] = [];
    let diagnosticStatusObservations: SafeStatusRequestEvidence[] = [];
    const networkRecorder = new SigningNetworkEvidenceRecorder(registrationPage);
    let networkRecorderStarted = false;

    const reportDiagnostics = (): void => {
      const allNetworkObservations = [
        ...browserNetworkObservations,
        ...diagnosticStatusObservations
      ];
      const automaticStatusRequestObserved = browserNetworkObservations.some(observation =>
        observation.path.includes('get-profile-info-test')
      );
      business.setBusinessData({
        registrationTestName: data?.displayName,
        registrationSequence: data?.sequenceText,
        registrationSignerImplementation: 'RegistrationAgreementSigner',
        registrationSignerType: 'Registration Agreement',
        registrationDocumentCreated: documentCreated,
        registrationAddressProofUpload: addressProofUpload,
        registrationDocumentOpened: documentOpened,
        registrationIframeLoaded: documentIframeLoaded,
        registrationFrameUrl: documentFrameUrl,
        registrationDocumentCreationEvidence: safeCreationEvidence(documentCreation),
        registrationDocumentBelongsToJourney: documentBelongsToCurrentJourney,
        registrationNoOldDocumentReused: documentOpened ? !staleDraftDetected : undefined,
        registrationInitialRemainingFields: fieldsRemainingBefore,
        registrationSignatureFieldLocated: signatureFieldLocated,
        registrationSignatureValue: 'TEST',
        registrationNamePreserved: namePreserved,
        registrationTitleStatus: titleStatus,
        registrationDateStatus: dateStatus,
        registrationTestSignatureDrawn: testSignatureDrawn,
        registrationSignatureApplied: signatureFieldCompleted,
        registrationSignatureMethod: signatureMethod,
        registrationFieldSignClickCount: registrationFieldSignCount,
        registrationAgreementActionClickCount: completeClickCount,
        registrationAgreementConfirmationClickCount: signConfirmClickCount,
        registrationFinalRemainingFields: fieldsRemainingAfter,
        registrationAuthorizationStepCompleted: authorizationStepCompleted,
        registrationSigningCompleted,
        registrationSubmitEnabledBeforeSigning: submitEnabledBeforeSigning,
        registrationFinalSubmitClickCount: finalRegistrationSubmitCount,
        registrationFinalSubmitAttemptCount: finalRegistrationSubmitAttemptCount,
        registrationFirstSubmitDiagnostic: firstSubmitDiagnostic,
        registrationRecoverySubmitDiagnostic: recoverySubmitDiagnostic,
        registrationRecoveryReloadCount: recoveryReloadCount,
        registrationPostSignFirstSubmitStateDesync: postSignFirstSubmitStateDesync,
        registrationRecoveryDocumentCreationEvidence:
          safeCreationEvidence(recoveryDocumentCreation),
        registrationFinalSubmitEvidence: safeProfileSubmissionEvidence(profileSubmission),
        fidereSigningStatusBefore: fidereSigningStatusBefore
          ? summarizeFidereSigningStatus(fidereSigningStatusBefore)
          : 'Not Read',
        fidereSigningStatusAfter: fidereSigningStatusAfter
          ? summarizeFidereSigningStatus(fidereSigningStatusAfter)
          : 'Not Read',
        submitEnabledBeforeSigning,
        submitEnabledAfterSigning,
        fidereStatusSyncObserved,
        fidereAutomaticStatusRequestObserved: automaticStatusRequestObserved,
        signingDiagnosticConclusion,
        finalRegistrationSubmitCount,
        credentialSource: 'CLIENT_PASSWORD',
        credentialConfigured: true,
        submitGateWarning,
        registrationFailureCategory,
        registrationFinalStatus,
        accountCreationStatus:
          registrationSubmissionCount === 1 ? 'ACCOUNT_CREATED' : 'ACCOUNT_NOT_CREATED',
        kycSubmissionStatus:
          finalRegistrationSubmitCount === 1 ? 'KYC_SUBMITTED' : 'KYC_NOT_SUBMITTED',
        registrationSigningStatus:
          registrationSigningCompleted ? 'COMPLETED' : 'NOT_COMPLETED',
        networkObservations: allNetworkObservations
      });
    };

    try {
      await business.step(
        {
          action: '1. Fresh User数据Preflight',
          expected: 'Fresh User唯一性由本地测试数据注册表保证；Admin不作为Client注册前置门禁。'
        },
        async context => {
          const preparedJourney = env.personalRegistration.email
            ? store.findByEmail(env.personalRegistration.email)
            : undefined;
          if (preparedJourney?.stage === 'PREPARED') {
            const reservedIdentity = factory.findByRunId(preparedJourney.runId);
            if (
              !reservedIdentity ||
              preparedJourney.sequence === undefined ||
              preparedJourney.displayName === undefined
            ) {
              throw new Error('Prepared Fresh Journey is missing its reserved Sandbox identity.');
            }
            journey = preparedJourney;
            data = {
              ...reservedIdentity,
              ...registrationTestNameForSequence(preparedJourney.sequence)
            };
            if (data.displayName !== preparedJourney.displayName) {
              throw new Error('Prepared Fresh Journey display name no longer matches its sequence.');
            }
          } else {
            const candidate = factory.previewFreshIdentity(env.personalRegistration.email);
            if (!candidate) {
              addBlocker(testInfo, 'BLOCKED_TEST_DATA: no available Sandbox identity remains.');
              throw new Error('No available Sandbox email/phone identity remains in the registration pool.');
            }
            const runId = createRunId();
            data = factory.reserveFreshIdentity(
              runId,
              candidate.id,
              env.personalRegistration.email
            );
            journey = store.create({
              runId,
              email: data.email,
              phone: data.phone,
              sequence: data.sequence,
              displayName: data.displayName
            });
          }
          guard.markJourneyDataReady();
          context.setActual(
            preparedJourney
              ? `复用尚未访问注册页的PREPARED Journey；身份仍为${data.displayName}，未分配下一账号。`
              : `未执行Admin前置搜索；本地数据注册表已分配${data.displayName}。`
          );
          context.setBusinessData({
            runId: journey.runId,
            registrationTestName: data.displayName,
            registrationSequence: data.sequenceText,
            registrationLoginIdentity: maskRegistrationEmail(data.email),
            registrationContactIdentity: maskRegistrationPhone(data.phone),
            loginIdentityUnique: true,
            registrationEmailAdminPreflight: 'Not part of Registration Preflight',
            contactIdentityUnique: true,
            registrationTestNameUnique: true,
            credentialSource: 'CLIENT_PASSWORD',
            credentialConfigured: true,
            resumeMode: Boolean(preparedJourney),
            resumeStartStage: 'PREPARED'
          });
        }
      );

      if (!journey || !data) throw new Error('Fresh registration Journey allocation failed.');

      const registration = new PersonalRegistrationPage(registrationPage);
      await business.step(
        {
          action: '2. 注册新邮箱并完成Sandbox邮箱OTP',
          expected: '验证码只请求一次；密码表单和协议可完成；不输出OTP或凭证。'
        },
        async context => {
          await registration.goto(clientBaseUrl);
          await registration.fillEmail(data!.email);
          guard.assertOtpRequestAllowed();
          await registration.requestVerificationCode();
          guard.recordOtpRequest();
          await registration.verifyEmail(registerOtp);
          await registration.fillPassword(clientPassword);
          const agreementCount = await registration.acceptVisibleAgreements();
          context.setActual(`邮箱OTP验证完成；已勾选可见协议${agreementCount}项。`);
          context.setBusinessData({ registrationAgreementCount: agreementCount });
        }
      );

      await business.step(
        {
          action: '3. 创建Fresh Client用户一次',
          expected: '注册按钮只点击一次；自动进入已认证的个人开户流程。'
        },
        async context => {
          guard.assertRegistrationSubmissionAllowed();
          journey = store.advance(journey!, 'REGISTRATION_SUBMITTED');
          business.markPotentiallySubmitted();
          business.disallowSafeRerun();
          await registration.submitRegistration();
          registrationSubmissionCount += 1;
          guard.recordRegistrationSubmission();
          await registration.expectAuthenticatedOnboarding();
          factory.markConsumed(journey!.runId);
          const registrationTime = new Date().toISOString();
          journey = store.advance(journey!, 'USER_REGISTERED', { registrationTime });
          mkdirSync(resolve('auth', 'journeys'), { recursive: true });
          await registrationContext.storageState({ path: journeyAuthPath(journey!.runId) });
          context.setActual('Fresh Client用户已创建一次，并进入已认证开户流程。');
          context.setBusinessData({ registrationSubmissionCount, registrationTime });
        }
      );

      await business.step(
        {
          action: '4. 验证新用户自动认证',
          expected: '新用户无需人工介入即可保持Client认证，并且不加载上一轮用户会话。'
        },
        async context => {
          const login = new LoginPage(registrationPage);
          await registrationPage.goto(clientRouteUrl(clientBaseUrl, 'dashboard'), {
            waitUntil: 'domcontentloaded'
          });
          if (/\/login(?:$|[?#])/.test(registrationPage.url())) {
            await login.goto(clientRouteUrl(clientBaseUrl, 'login'));
            await login.fillCredentials({ username: data!.email, password: clientPassword });
            await login.submitCredentials();
            await login.expectOtpStep();
            await login.fillOtp(requireValue('CLIENT_OTP', env.client.otp));
            await login.confirmLoginToAuthenticatedRoute();
          }
          await expect(registrationPage).not.toHaveURL(/\/login(?:$|[?#])/);
          await registrationContext.storageState({ path: journeyAuthPath(journey!.runId) });
          journey = store.advance(journey!, 'CLIENT_AUTHENTICATED', {
            clientStatus: 'Authenticated'
          });
          context.setActual('本次Fresh User Client认证有效；旧Journey storageState未加载。');
          context.setBusinessData({ clientAuthenticationStatus: 'Authenticated' });
        }
      );

      const onboarding = new PersonalOnboardingPage(registrationPage);
      let onboardingStep = await onboarding.currentStep();
      if (onboardingStep === 'completed') {
        await registrationPage.goto(clientRouteUrl(clientBaseUrl, 'account-type-selection'), {
          waitUntil: 'domcontentloaded'
        });
        onboardingStep = await onboarding.currentStep();
      }

      if (onboardingStep === 'account-type') {
        await business.step(
          { action: '5. 选择个人账户', expected: '进入individual个人资料流程，不进入企业注册。' },
          async context => {
            const accountType = new AccountTypeSelectionPage(registrationPage);
            await accountType.expectOpen();
            await accountType.selectPersonal();
            context.setActual('已选择个人账户。');
            context.setBusinessData({ registrationAccountType: 'Personal' });
          }
        );
        onboardingStep = await onboarding.currentStep();
      }

      const onboardingInput = {
        profile: {
          ...profile,
          firstName: data.firstName,
          lastName: data.lastName
        },
        phone: data.phone,
        idNumber: uniqueSyntheticIdentity(profile.idNumberPrefix, data.phone),
        taxNumber: uniqueSyntheticIdentity(profile.taxNumberPrefix, data.phone),
        addressProofPath: env.personalRegistration.addressProofPath
      };

      if (onboardingStep === 'personal') {
        await business.step(
          { action: '6. 填写Sandbox个人资料', expected: '个人与经济资料通过页面校验。' },
          async context => {
            await onboarding.fillPersonalInformation(onboardingInput);
            context.setActual('Sandbox个人与经济资料已保存。');
          }
        );
        onboardingStep = await onboarding.currentStep();
      }

      if (onboardingStep === 'contact') {
        await business.step(
          { action: '7. 填写唯一手机号和Sandbox地址', expected: '本次唯一手机号及合成地址通过校验。' },
          async context => {
            addressProofUpload = await onboarding.fillContactInformation(onboardingInput);
            context.setActual(`联系方式已保存；地址证明已选择${addressProofUpload.fileName}。`);
            context.setBusinessData({ registrationAddressProofUpload: addressProofUpload });
          }
        );
        onboardingStep = await onboarding.currentStep();
      }

      if (onboardingStep !== 'tax') {
        throw new Error(`Fresh registration expected tax step; received ${onboardingStep}.`);
      }

      networkRecorder.start();
      networkRecorderStarted = true;
      await business.step(
        {
          action: '8. 完成税务声明并建立本次Registration Agreement',
          expected: 'Sumsub不出现；本次用户会话触发新的create-kyc-doc并进入授权页。'
        },
        async context => {
          documentCreation = await onboarding.fillTaxResidency(onboardingInput);
          documentCreated =
            documentCreation.httpStatus >= 200 &&
            documentCreation.httpStatus < 300 &&
            documentCreation.documentPayloadPresent;
          journey = store.advance(journey!, 'AUTHORIZATION_REQUIRED', {
            clientStatus: 'Authorization Required'
          });
          if (
            documentCreation.httpStatus < 200 ||
            documentCreation.httpStatus >= 300 ||
            !documentCreation.documentPayloadPresent
          ) {
            signingDiagnosticConclusion = 'C';
            addBlocker(testInfo, 'Registration Agreement creation did not return a usable document.');
            context.setBusinessData({
              sumsubRequired: false,
              documentCreated,
              documentCreationEvidence: safeCreationEvidence(documentCreation),
              signingDiagnosticConclusion
            });
            throw new Error('Registration Agreement creation did not return a usable current-user document.');
          }
          context.setActual('税务声明已保存；本次会话创建了新的Registration Agreement。');
          context.setBusinessData({
            sumsubRequired: false,
            documentCreated,
            documentCreationEvidence: safeCreationEvidence(documentCreation)
          });
        }
      );

      const signing = new RegistrationAgreementSigner(registrationPage);
      const statusReader = new FidereSigningStatusReader(registrationPage);
      await business.step(
        {
          action: '9. 核验签署前硬门禁与新文档归属',
          expected: 'Fidere签署状态未完成时绝不提交；按钮若提前可用仅记警告，并继续核验本次新文档。'
        },
        async context => {
          if (await onboarding.isAuthorizationDocumentRetryVisible()) {
            signingDiagnosticConclusion = 'C';
            addBlocker(testInfo, 'Registration Agreement failed to load.');
            throw new Error('Registration authorization page displayed Retry instead of an agreement.');
          }
          fidereSigningStatusBefore = await statusReader.read();
          diagnosticStatusObservations.push(fidereSigningStatusBefore.request);
          submitEnabledBeforeSigning = await onboarding.isFinalSubmitEnabled();
          if (submitEnabledBeforeSigning) {
            submitGateWarning = true;
            business.recordDiagnostic({
              id: 'pre-signing-submit-button-state',
              name: '签署前Client提交按钮状态',
              status: 'info',
              summary: 'POTENTIAL_PRODUCT_DEFECT: 签署前Submit已可操作，但自动化硬门禁未放行',
              affectsCoreBusiness: false
            });
          }
          const initial = await signing.open(data!.displayName);
          documentOpened = true;
          documentIframeLoaded = true;
          documentFrameUrl = initial.safeFrameUrl;
          fieldsRemainingBefore = initial.initialRemainingFields;
          namePreserved = initial.namePreserved;
          titleStatus = initial.titleStatus;
          dateStatus = initial.dateStatus;
          staleDraftDetected = fieldsRemainingBefore === 0 || fidereSigningStatusBefore.recognized;
          documentBelongsToCurrentJourney = Boolean(
            documentCreation?.documentPayloadPresent &&
            initial.documentBelongsToTestUser &&
            !fidereSigningStatusBefore.signaturePresent
          );
          context.setBusinessData({
            registrationSignerImplementation: initial.implementation,
            registrationSignerType: 'Registration Agreement',
            registrationDocumentOpened: documentOpened,
            registrationIframeLoaded: documentIframeLoaded,
            registrationFrameUrl: documentFrameUrl,
            registrationDocumentBelongsToJourney: documentBelongsToCurrentJourney,
            registrationNoOldDocumentReused: !staleDraftDetected,
            registrationInitialRemainingFields: fieldsRemainingBefore,
            registrationNamePreserved: namePreserved,
            registrationTitleStatus: titleStatus,
            registrationDateStatus: dateStatus,
            fidereSigningStatusBefore: summarizeFidereSigningStatus(fidereSigningStatusBefore),
            registrationSubmitEnabledBeforeSigning: submitEnabledBeforeSigning,
            submitGateWarning
          });

          expect(initial.identityChallengePresent).toBe(false);
          expect(documentBelongsToCurrentJourney).toBe(true);
          if (staleDraftDetected || fieldsRemainingBefore === 0) {
            signingDiagnosticConclusion = 'C';
            throw new Error('The Fresh User authorization page exposed a completed or stale document state.');
          }
          context.setActual(
            `新Registration Agreement已加载；初始剩余字段=${fieldsRemainingBefore}；签署前按钮可用=${submitEnabledBeforeSigning}；自动化未提前提交。`
          );
        }
      );

      await business.step(
        {
          action: '10. 使用RegistrationAgreementSigner完成TEST签名',
          expected: '定位真实Registration签名字段，TEST只签入一次，Remaining Fields最终为0。'
        },
        async context => {
          business.markPotentiallySubmitted();
          business.disallowSafeRerun();
          const prepared = await signing.signSandboxAgreement({
            signatureText: registrationSignatureText,
            testTitle: registrationTestTitle
          });
          registrationFieldSignCount = signing.fieldSignClickCount();
          fieldsRemainingAfter = prepared.finalRemainingFields;
          signatureFieldLocated = prepared.signatureFieldLocated;
          signatureMethod = prepared.signatureMethod;
          testSignatureDrawn = prepared.testSignatureDrawn;
          namePreserved = prepared.namePreserved;
          titleStatus = prepared.titleStatus;
          dateStatus = prepared.dateStatus;
          signatureFieldCompleted =
            prepared.testSignatureApplied &&
            prepared.finalRemainingFields === 0 &&
            registrationFieldSignCount === 1;
          expect(signatureFieldCompleted).toBe(true);
          completeClickCount = prepared.agreementActionClickCount;
          signConfirmClickCount = prepared.agreementConfirmationClickCount;
          journey = store.advance(journey!, 'DOCUMENT_COMPLETED', {
            clientStatus: 'Registration Signature Applied'
          });
          context.setActual(
            `已定位真实签名字段；方式=${signatureMethod}；TEST签入1次；最终剩余字段=${fieldsRemainingAfter}。`
          );
          context.setBusinessData({
            registrationSignatureFieldLocated: signatureFieldLocated,
            registrationSignatureMethod: signatureMethod,
            registrationSignatureValue: 'TEST',
            registrationNamePreserved: namePreserved,
            registrationTitleStatus: titleStatus,
            registrationDateStatus: dateStatus,
            registrationTestSignatureDrawn: testSignatureDrawn,
            registrationSignatureApplied: signatureFieldCompleted,
            registrationFieldSignClickCount: registrationFieldSignCount,
            registrationAgreementActionClickCount: completeClickCount,
            registrationAgreementConfirmationClickCount: signConfirmClickCount,
            registrationFinalRemainingFields: fieldsRemainingAfter
          });
        }
      );

      await business.step(
        {
          action: '11. 验证Registration签署与授权步骤完成',
          expected: 'Fidere识别签名，左侧授权变为已完成，且最终提交硬门禁全部满足。'
        },
        async context => {
          fidereSigningStatusAfter = await statusReader.read();
          fidereStatusSyncObserved = fidereSigningStatusAfter.recognized;
          const completedAgreement = await signing.inspectCompletedAgreement();
          const authorizationUiCompleted = await signing.isAuthorizationStepCompleted();
          authorizationStepCompleted =
            completedAgreement.completed &&
            fieldsRemainingAfter === 0 &&
            signatureFieldCompleted;
          if (!authorizationUiCompleted && authorizationStepCompleted) {
            business.recordDiagnostic({
              id: 'authorization-step-ui-before-profile-submit',
              name: '最终资料提交前授权步骤UI',
              status: 'info',
              summary: '文档与Fidere签署状态均已完成；左侧授权仍显示当前步骤，等待最终资料提交后推进。',
              affectsCoreBusiness: false
            });
          }
          submitEnabledAfterSigning = await onboarding.isFinalSubmitEnabled();
          registrationProviderCompleted = completedAgreement.completed;
          context.setBusinessData({
            fidereSigningStatusAfter: summarizeFidereSigningStatus(fidereSigningStatusAfter),
            fidereStatusSyncObserved,
            submitEnabledAfterSigning,
            registrationAuthorizationStepCompleted: authorizationStepCompleted,
            registrationAuthorizationUiCompletedBeforeSubmit: authorizationUiCompleted
          });

          if (
            !registrationProviderCompleted ||
            !authorizationStepCompleted ||
            fieldsRemainingAfter !== 0 ||
            !signatureFieldCompleted ||
            !submitEnabledAfterSigning
          ) {
            signingDiagnosticConclusion = 'B';
            addBlocker(testInfo, 'BLOCKED_CALLBACK_OR_STATE_SYNC');
            context.setActual(
              `Fidere状态同步=${fidereStatusSyncObserved}；授权完成=${authorizationStepCompleted}；剩余字段=${fieldsRemainingAfter}；最终提交可用=${submitEnabledAfterSigning}。`
            );
            throw new Error(
              'BLOCKED_CALLBACK_OR_STATE_SYNC: Registration Agreement did not satisfy every final-submit gate.'
            );
          }

          registrationSigningCompleted = true;
          registrationProviderCompleted = true;
          journey = store.advance(journey!, 'FIDERE_SIGNING_RECOGNIZED', {
            clientStatus: 'Registration Signing Completed'
          });
          guard.markRegistrationSigningCompleted({
            signatureFieldCompleted,
            remainingFields: fieldsRemainingAfter,
            authorizationStepCompleted,
            fidereSigningRecognized: fidereStatusSyncObserved || submitEnabledAfterSigning
          });
          context.setActual(
            `Fidere已识别Registration Agreement签名；签署门禁完成；左侧授权UI完成=${authorizationUiCompleted}。`
          );
          context.setBusinessData({ registrationSigningCompleted });
        }
      );

      await business.step(
        {
          action: '12. 最终提交个人注册资料并处理首次签署状态不同步',
          expected: '签署后当前页先提交一次；仅在完全没有member-profile请求时，reload同一账号并确定性恢复一次。'
        },
        async context => {
          expect(registrationSigningCompleted).toBe(true);
          expect(authorizationStepCompleted).toBe(true);
          expect(fieldsRemainingAfter).toBe(0);
          expect(signatureFieldCompleted).toBe(true);
          expect(registrationProviderCompleted).toBe(true);
          expect(submitEnabledAfterSigning).toBe(true);
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
            registrationFailureCategory = 'POST_SIGN_FIRST_SUBMIT_STATE_DESYNC';
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
            const recoveredAgreement = await recoverySigner.open(data!.displayName);
            expect(recoveredAgreement.initialRemainingFields).toBe(0);
            const completedAgreement = await recoverySigner.inspectCompletedAgreement();
            expect(completedAgreement.completed).toBe(true);
            expect(completedAgreement.remainingFields).toBe(0);
            expect(recoverySigner.fieldSignClickCount()).toBe(0);
            expect(recoverySigner.completionActionClickCount()).toBe(0);
            expect(recoverySigner.confirmationClickCount()).toBe(0);

            const recoveredStatusReader = new FidereSigningStatusReader(registrationPage);
            const recoveredStatus = await recoveredStatusReader.read();
            diagnosticStatusObservations.push(recoveredStatus.request);
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
          const pendingStatus = await statusReader.read();
          expect(
            /pending|review|审核/i.test(pendingStatus.kycStepStatus) ||
            pendingStatus.kycStep === 'Four'
          ).toBe(true);
          guard.recordProfileFinalSubmission();
          journey = store.advance(journey!, 'PROFILE_COMPLETED', {
            clientStatus: 'Profile Completed', clientSubmittedAt: new Date().toISOString()
          });
          rememberRegistrationSubmission({ accountType: 'PERSONAL', runId: journey.runId,
            email: journey.email, displayName: journey.displayName!, userId: journey.userId,
            clientSubmittedAt: journey.clientSubmittedAt });
          context.setActual(
            postSignFirstSubmitStateDesync
              ? `首次点击无member-profile请求；同一账号reload后恢复提交成功。总点击=${finalRegistrationSubmitAttemptCount}，页面进入等待审核（${profileSubmission.pendingReviewIndicator}）。`
              : `签署完成后的当前页首次提交成功；总点击=1，页面进入等待审核（${profileSubmission.pendingReviewIndicator}）。`
          );
          context.setBusinessData({
            finalRegistrationSubmitCount,
            finalRegistrationSubmitAttemptCount,
            postSignFirstSubmitStateDesync,
            registrationProfileSubmissionCount: finalRegistrationSubmitCount,
            registrationFinalSubmitEvidence: safeProfileSubmissionEvidence(profileSubmission),
            personalProfileCompleted: true,
            pendingReviewPageVisible: true,
            pendingReviewKycStep: pendingStatus.kycStep,
            pendingReviewKycStepStatus: pendingStatus.kycStepStatus
          });
        }
      );

      await business.step(
        {
          action: '13. 使用新邮箱和CLIENT_PASSWORD重新登录Client',
          expected: '干净Client上下文可自动登录，Dashboard核心区域正常。'
        },
        async context => {
          const verificationContext = await browser.newContext({
            baseURL: clientBaseUrl,
            storageState: { cookies: [], origins: [] }
          });
          try {
            const verificationPage = await verificationContext.newPage();
            const login = new LoginPage(verificationPage);
            await login.goto(clientRouteUrl(clientBaseUrl, 'login'));
            await login.fillCredentials({ username: data!.email, password: clientPassword });
            await login.submitCredentials();
            await login.expectOtpStep();
            await login.fillOtp(requireValue('CLIENT_OTP', env.client.otp));
            await login.confirmLoginToAuthenticatedRoute();
            const home = new HomePage(verificationPage);
            await home.gotoDashboard(clientBaseUrl);
            await home.expectDashboardLoaded();
            await home.expectNoObviousError();
            await verificationContext.storageState({ path: journeyAuthPath(journey!.runId) });
          } finally {
            await verificationContext.close();
          }
          context.setActual('新用户通过新邮箱和CLIENT_PASSWORD完成干净登录；Dashboard正常。');
          registrationFinalStatus = 'KYC Submitted / Client Authenticated';
          context.setBusinessData({
            clientHomeVerified: true,
            clientAuthenticationStatus: 'Authenticated with new credentials'
          });
        }
      );

      await business.step(
        {
          action: '14. Post-Registration Diagnostic（非计分）',
          expected: '尽力通过Admin邮箱搜索核对用户；任何不可用只记录Diagnostic，不影响REG-P结果。'
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
            const located = await adminUsers.openUniqueRegistrationByEmail(
              adminBaseUrl,
              data!.email
            );
            adminCandidateCount = located.candidateCount;
            if (adminCandidateCount !== 1) {
              throw new Error(`Admin post-registration candidateCount=${adminCandidateCount}.`);
            }
            await adminUsers.expectDetailMatchesEmail(data!.email);
            await adminUsers.expectDetailMatchesPhone(data!.phone);
            await adminUsers.expectDetailMatchesTestName(data!.displayName);
            const userId = await adminUsers.readUserId();
            if (!userId) throw new Error('Admin post-registration detail did not expose userId.');
            const clientStatus = await adminUsers.readStatus();
            registrationFinalStatus = clientStatus;
            journey = store.advance(journey!, 'ADMIN_USER_LOCATED', { userId, clientStatus });
            business.recordDiagnostic({
              id: 'admin-post-registration-verification',
              name: 'Admin Post-Registration Verification',
              status: 'available',
              summary: `candidateCount=1；详情姓名为${data!.displayName}`,
              affectsCoreBusiness: false
            });
            context.setActual('Admin Post-Registration Verification可用，详情属于本次用户。');
            context.setBusinessData({
              adminUserCandidateCount: adminCandidateCount,
              adminRegistrationView: located.route,
              adminUserReference: userId
            });
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            business.recordDiagnostic({
              id: 'admin-post-registration-verification',
              name: 'Admin Post-Registration Verification',
              status: 'unavailable',
              summary: 'Admin用户检索暂不可用',
              reason,
              affectsCoreBusiness: false
            });
            context.setActual('Admin Post-Registration Verification暂不可用；不影响注册核心结果。');
          } finally {
            await adminContext?.close();
          }
        }
      );

      journey = store.advance(journey, 'COMPLETED');
      signingDiagnosticConclusion = 'A';
      browserNetworkObservations = networkRecorder.stop();
      networkRecorderStarted = false;
      reportDiagnostics();

      business.recordPrimaryOracle({
        id: 'new-user-created',
        name: 'Fresh User唯一创建',
        expected: '唯一邮箱、唯一手机号和三位编号测试姓名只创建一个用户',
        actual: `${data.displayName}注册提交1次，未创建第二个用户`,
        status: 'passed'
      });
      business.recordPrimaryOracle({
        id: 'kyc-profile-submitted',
        name: 'KYC资料最终提交',
        expected: 'Registration Agreement完成后最终提交1次，并进入等待审核页面',
        actual: `最终资料提交=${finalRegistrationSubmitCount}次；等待审核页面=${profileSubmission?.pendingReviewPageVisible === true}`,
        status: finalRegistrationSubmitCount === 1 && profileSubmission?.pendingReviewPageVisible
          ? 'passed'
          : 'failed'
      });
      business.recordPrimaryOracle({
        id: 'registration-agreement-completed',
        name: 'Personal Registration Agreement真实签署',
        expected: '独立Signer定位签名字段、TEST签入一次、剩余字段为0且授权步骤完成',
        actual: `方式=${signatureMethod}；初始=${fieldsRemainingBefore}；最终=${fieldsRemainingAfter}；授权已完成`,
        status: 'passed'
      });
      business.recordPrimaryOracle({
        id: 'fidere-signing-recognized',
        name: 'Fidere识别签署完成',
        expected: '签署状态同步后才启用最终提交',
        actual: '状态已同步，最终提交已启用',
        status: 'passed'
      });
      business.recordPrimaryOracle({
        id: 'client-authenticated',
        name: 'Client自动认证与首页',
        expected: 'Dashboard可用',
        actual: 'Dashboard正常',
        status: 'passed'
      });
      business.setBusinessData({
        registrationStage: journey.stage,
        journeyContextLocation: '.journey-context/personal/[runId].json',
        noSecondUserCreated: true,
        mutationPerformed: true
      });
    } catch (error) {
      if (networkRecorderStarted) {
        browserNetworkObservations = networkRecorder.stop();
        networkRecorderStarted = false;
      }
      if (signingDiagnosticConclusion === 'UNDETERMINED') {
        signingDiagnosticConclusion = 'C';
      }
      if (registrationFailureCategory === 'NONE') {
        registrationFailureCategory = registrationProviderCompleted
          ? 'FINAL_PROFILE_SUBMISSION_FAILED'
          : documentCreated
            ? 'REGISTRATION_AGREEMENT_SIGNING_FAILED'
            : 'PRECONDITION_OR_REGISTRATION_FAILED';
      }
      reportDiagnostics();
      const persisted = journey ? store.load(journey.runId) : undefined;
      if (persisted?.stage && persisted.stage !== 'PREPARED') {
        business.disallowSafeRerun();
        business.setBusinessData({
          registrationStage: persisted.stage,
          noSecondUserCreated: true,
          mutationPerformed: registrationSubmissionCount > 0
        });
      }
      if (registrationProviderCompleted) {
        business.recordPrimaryOracle({
          id: 'profile-final-submit',
          name: 'Fidere最终资料提交',
          expected: '同一账号最多进行首次提交和一次确定性reload恢复，并进入等待审核页',
          actual:
            `提交请求成功数=${finalRegistrationSubmitCount}；点击尝试=${finalRegistrationSubmitAttemptCount}；分类=${registrationFailureCategory}`,
          status: 'failed'
        });
      } else {
        business.recordPrimaryOracle({
          id: 'signing-hard-gate',
          name: 'Registration Agreement签署硬门禁',
          expected: '签名字段完成、剩余字段为0、Fidere同步且授权步骤完成',
          actual: `结论=${signingDiagnosticConclusion}`,
          status: 'failed'
        });
      }
      throw error;
    }
    await runRegistrationKycTail({ source: submittedRegistrationSource('PERSONAL', journey!.runId),
      browser, adminPage, business, testInfo });
  }
);
