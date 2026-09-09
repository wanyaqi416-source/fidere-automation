import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { BrowserContext, Page } from '@playwright/test';

import { AdminClientUsersPage } from '../../../pages/admin/AdminClientUsersPage';
import { clientRouteUrl } from '../../../pages/client/HomePage';
import { LoginPage } from '../../../pages/client/LoginPage';
import { PersonalOnboardingPage } from '../../../pages/client/PersonalOnboardingPage';
import { RegistrationAgreementSigner } from '../../../pages/client/registration/RegistrationAgreementSigner';
import { expect, test } from '../../../fixtures/registration.fixture';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment } from '../../../src/flow-engine/mutation-guard';
import {
  FidereSigningStatusReader,
  loadPersonalRegistrationProfile,
  maskRegistrationEmail,
  maskRegistrationPhone,
  PersonalJourneyContextStore,
  summarizeFidereSigningStatus,
  type FidereSigningStatusSnapshot,
  TestUserFactory
} from '../../../src/registration';

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for REG-P Resume Preflight.`);
  return value;
}

function journeyAuthPath(runId: string): string {
  return resolve('auth', 'journeys', `${runId}.json`);
}

async function blockAuthorizationDocumentCreation(
  page: Page,
  onBlocked: () => void
): Promise<void> {
  await page.route('**/api/create-kyc-doc', async route => {
    onBlocked();
    await route.abort('blockedbyclient');
  });
}

async function attemptConfiguredPasswordLogin(input: {
  page: Page;
  clientBaseUrl: string;
  email: string;
  password: string;
  otp: string;
}): Promise<{ credentialAccepted: boolean; authenticated: boolean }> {
  const login = new LoginPage(input.page);
  await login.goto(clientRouteUrl(input.clientBaseUrl, 'login'));
  await login.fillCredentials({ username: input.email, password: input.password });
  await login.submitCredentials();

  try {
    await login.expectOtpStep();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { credentialAccepted: false, authenticated: false };
  }

  await login.fillOtp(input.otp);
  try {
    await login.confirmLoginToAuthenticatedRoute();
    return { credentialAccepted: true, authenticated: true };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { credentialAccepted: true, authenticated: false };
  }
}

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'REG-P existing Journey Resume只读Preflight',
  {
    tag: ['@registration', '@personal', '@readonly', '@dry-run', '@L3'],
    annotation: [
      { type: 'caseId', description: 'REG-P-RESUME-PREFLIGHT' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ adminPage, browser, business, registrationPage }) => {
    test.setTimeout(120_000);
    business.flow('personal-registration', {
      caseId: 'REG-P-RESUME-PREFLIGHT',
      name: '个人注册原Journey Resume只读检查',
      level: 'L3',
      type: ['Dry Run', 'Read-only', 'Resume'],
      expectedResult:
        '只尝试一次CLIENT_PASSWORD登录，并只读确认原KYC与Documenso草稿能否继续；不签名、不Complete、不提交。',
      changesData: false,
      affectsMoney: false
    });

    const clientBaseUrl = required('CLIENT_BASE_URL', env.client.baseUrl);
    const adminBaseUrl = required('ADMIN_BASE_URL', env.admin.baseUrl);
    const targetEmail = required('PERSONAL_REGISTRATION_EMAIL', env.personalRegistration.email);
    const clientPassword = required('CLIENT_PASSWORD', env.client.password);
    const clientOtp = required('CLIENT_OTP', env.client.otp);
    assertSandboxEnvironment(clientBaseUrl);
    assertSandboxEnvironment(adminBaseUrl);
    expect(env.allowClientMutationTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);

    const store = new PersonalJourneyContextStore();
    const journey = store.findByEmail(targetEmail);
    expect(journey).toBeTruthy();
    expect(journey!.stage).toBe('AUTHORIZATION_REQUIRED');
    const identity = new TestUserFactory(env.personalRegistration.dataPoolPath, store)
      .findByRunId(journey!.runId);
    expect(identity).toBeTruthy();

    let resumeLoginAttemptCount = 0;
    let resumeCredentialAccepted = false;
    let resumeClientAuthenticated = false;
    let journeySessionActive = false;
    let unfinishedKycRestored = false;
    let documensoDraftAvailable = false;
    let resumeSigningReady = false;
    let fieldsRemainingBefore: number | undefined;
    let submitEnabledBeforeSigning: boolean | undefined;
    let submitGateWarning = false;
    let documentFrameUrl: string | undefined;
    let signerMatchesJourney: boolean | undefined;
    let documentCreationRequestsBlocked = 0;
    let fidereSigningStatus: FidereSigningStatusSnapshot | undefined;
    let storedJourneyContext: BrowserContext | undefined;
    let inspectionPage = registrationPage;

    await blockAuthorizationDocumentCreation(registrationPage, () => {
      documentCreationRequestsBlocked += 1;
    });

    await business.step(
      {
        action: '1. 验证Admin会话与原Journey身份',
        expected: 'Admin会话有效；KYC最终资料提交前，该账号尚不应出现在Admin KYC候选中。'
      },
      async context => {
        const adminUsers = new AdminClientUsersPage(adminPage);
        await adminUsers.goto(adminBaseUrl);
        const candidateCount = await adminUsers.exactCandidateCount(targetEmail);
        expect(candidateCount).toBe(0);
        context.setActual('Admin认证有效；原账号尚未提交KYC，candidateCount=0。');
        context.setBusinessData({ adminUserCandidateCount: candidateCount });
      }
    );

    await business.step(
      {
        action: '2. 使用CLIENT_PASSWORD执行一次Client登录Preflight',
        expected: '原账号接受统一Sandbox密码并通过固定Client登录OTP；不重复尝试。'
      },
      async context => {
        resumeLoginAttemptCount += 1;
        const result = await attemptConfiguredPasswordLogin({
          page: registrationPage,
          clientBaseUrl,
          email: targetEmail,
          password: clientPassword,
          otp: clientOtp
        });
        resumeCredentialAccepted = result.credentialAccepted;
        resumeClientAuthenticated = result.authenticated;
        context.setActual(
          `登录尝试=${resumeLoginAttemptCount}；凭证被接受=${resumeCredentialAccepted}；认证成功=${resumeClientAuthenticated}。`
        );
        context.setBusinessData({
          credentialSource: 'CLIENT_PASSWORD',
          credentialConfigured: true,
          resumeLoginAttemptCount,
          resumeCredentialAccepted,
          resumeClientAuthenticated
        });
      }
    );

    if (!resumeClientAuthenticated) {
      const statePath = journeyAuthPath(journey!.runId);
      if (existsSync(statePath)) {
        storedJourneyContext = await browser.newContext({
          baseURL: clientBaseUrl,
          storageState: statePath
        });
        inspectionPage = await storedJourneyContext.newPage();
        await blockAuthorizationDocumentCreation(inspectionPage, () => {
          documentCreationRequestsBlocked += 1;
        });
      }
    }

    try {
      await business.step(
        {
          action: '3. 只读恢复原KYC授权步骤',
          expected: '原Journey会话仍有效并回到authorization；不重新创建账号、不填写或提交资料。'
        },
        async context => {
          await inspectionPage.goto(
            new URL('/zh-CN/registration?type=individual', clientBaseUrl).toString(),
            { waitUntil: 'domcontentloaded' }
          );
          journeySessionActive = !/\/login(?:$|[?#])/.test(inspectionPage.url());
          if (journeySessionActive) {
            unfinishedKycRestored =
              await new PersonalOnboardingPage(inspectionPage).currentStep() === 'authorization';
          }
          context.setActual(
            `原Journey会话有效=${journeySessionActive}；恢复authorization=${unfinishedKycRestored}。`
          );
          context.setBusinessData({ journeySessionActive, unfinishedKycRestored });
        }
      );

      if (unfinishedKycRestored) {
        await business.step(
          {
            action: '4. 只读检查原Registration Agreement和签署能力',
            expected: '独立RegistrationAgreementSigner可附着原协议并读取字段；不绘制、不完成签署。'
          },
          async context => {
            const onboarding = new PersonalOnboardingPage(inspectionPage);
            submitEnabledBeforeSigning = await onboarding.isFinalSubmitEnabled();
            fidereSigningStatus = await new FidereSigningStatusReader(inspectionPage).read();
            submitGateWarning = submitEnabledBeforeSigning && !fidereSigningStatus.recognized;
            if (submitGateWarning) {
              context.warn(
                'POTENTIAL_PRODUCT_DEFECT: 未完成Documenso时Client最终提交按钮已可操作；Preflight未点击。'
              );
            }

            if (!(await onboarding.isAuthorizationDocumentRetryVisible())) {
              const signing = new RegistrationAgreementSigner(inspectionPage);
              try {
                const profile = loadPersonalRegistrationProfile(
                  env.personalRegistration.profilePath
                );
                const initial = await signing.open(
                  journey!.displayName ?? `${profile.firstName} ${profile.lastName}`
                );
                documensoDraftAvailable = true;
                fieldsRemainingBefore = initial.initialRemainingFields;
                documentFrameUrl = initial.safeFrameUrl;
                signerMatchesJourney = initial.documentBelongsToTestUser;
                resumeSigningReady =
                  initial.documentBelongsToTestUser &&
                  !initial.identityChallengePresent &&
                  !fidereSigningStatus.recognized;
              } catch (error) {
                if (!(error instanceof Error)) throw error;
                documensoDraftAvailable = false;
                resumeSigningReady = false;
              }
            }

            context.setActual(
              `草稿可读取=${documensoDraftAvailable}；Fields Remaining=${fieldsRemainingBefore ?? '未读取'}；可继续签署=${resumeSigningReady}；未执行签署动作。`
            );
            context.setBusinessData({
              documentOpened: documensoDraftAvailable,
              documentIframeLoaded: documensoDraftAvailable,
              documentFrameUrl,
              documentBelongsToCurrentJourney: signerMatchesJourney,
              fieldsRemainingBefore,
              documensoDraftAvailable,
              resumeSigningReady,
              submitEnabledBeforeSigning,
              submitGateWarning,
              fidereSigningStatusAfter: summarizeFidereSigningStatus(fidereSigningStatus),
              fidereStatusSyncObserved: fidereSigningStatus.recognized,
              documensoFieldSignCount: 0,
              completeClickCount: 0,
              signConfirmClickCount: 0,
              finalRegistrationSubmitCount: 0
            });
          }
        );
      }
    } finally {
      await storedJourneyContext?.close();
    }

    const resumeReady =
      resumeClientAuthenticated &&
      unfinishedKycRestored &&
      documensoDraftAvailable &&
      resumeSigningReady;
    if (!resumeReady) {
      business.warn(
        'REG-P Resume当前未满足一次性真实执行条件；不得Fresh重建原账号或直接提交。'
      );
    }
    if (submitGateWarning) {
      business.recordSecondaryOracle({
        id: 'pre-signing-submit-gate',
        name: '签署前Client提交门禁',
        expected: 'Documenso完成前最终提交按钮不可用',
        actual: '按钮提前可用，Preflight未点击',
        status: 'failed'
      });
    }
    business.setBusinessData({
      readinessStatus: resumeReady ? 'RESUME_READY' : 'BLOCKED_TEST_DATA',
      registrationLoginIdentity: maskRegistrationEmail(targetEmail),
      registrationContactIdentity: maskRegistrationPhone(identity!.phone),
      registrationStage: journey!.stage,
      resumeMode: true,
      resumeStartStage: journey!.stage,
      credentialSource: 'CLIENT_PASSWORD',
      credentialConfigured: true,
      resumeLoginAttemptCount,
      resumeCredentialAccepted,
      resumeClientAuthenticated,
      journeySessionActive,
      unfinishedKycRestored,
      documensoDraftAvailable,
      resumeSigningReady,
      submitGateWarning,
      documentCreationRequestsBlocked,
      fidereSigningStatusAfter: fidereSigningStatus
        ? summarizeFidereSigningStatus(fidereSigningStatus)
        : 'Not Read',
      fidereStatusSyncObserved: fidereSigningStatus?.recognized,
      accountCreationStatus: 'ACCOUNT_CREATED',
      kycSubmissionStatus: 'KYC_NOT_SUBMITTED',
      documensoCompletionStatus: 'DOCUMENSO_NOT_COMPLETED',
      mutationPerformed: false,
      noSecondUserCreated: true,
      finalRegistrationSubmitCount: 0
    });
  }
);
