import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { RegistrationReviewDashboardPage } from '../../../pages/admin/RegistrationReviewDashboardPage';
import { AccountTypeSelectionPage } from '../../../pages/client/AccountTypeSelectionPage';
import { CorporateRegistrationPage } from '../../../pages/client/CorporateRegistrationPage';
import { LoginPage } from '../../../pages/client/LoginPage';
import { PersonalRegistrationPage } from '../../../pages/client/PersonalRegistrationPage';
import { CorporateRegistrationSigner } from '../../../pages/client/registration/CorporateRegistrationSigner';
import { expect, test } from '../../../fixtures/registration.fixture';
import { authStatePaths, existingAuthState } from '../../../src/config/auth';
import { env } from '../../../src/config/env';
import { pendingRegistrationApprovalRunId, preflightRegistrationAdmin, rememberRegistrationSubmission, runRegistrationKycTail, submittedRegistrationSource } from '../../../src/registration/registration-kyc-tail';
import {
  CORPORATE_DOCUMENT_MAPPING,
  CorporateRegistrationGuard,
  CorporateRegistrationJourneyStore,
  corporateJourneyStageAtLeast,
  corporateProfileForJourney,
  maskRegistrationEmail,
  maskRegistrationPhone,
  type CorporateDocumentDefinition,
  type CorporateRegistrationJourney,
  type CorporateRegistrationJourneyStage
} from '../../../src/registration';
import type { BusinessStepDefinition } from '../../../src/reporting/business-report.types';

test.describe.configure({ mode: 'serial', retries: 0 });

const steps: readonly BusinessStepDefinition[] = [
  { action: 'Corporate Journey与Sandbox门禁', expected: '只分配一个企业身份并启用单次Mutation保护' },
  { action: '创建或恢复企业Client账号', expected: '账号创建最多一次，后续始终Resume同一账号' },
  { action: '1. 基本档案', expected: '只填写并保存企业基本档案' },
  { action: '2. 运营信息', expected: '填写运营信息，并按真实字段上传运营资料' },
  { action: '3. 资产来源', expected: '填写并保存企业资产来源' },
  { action: '4. 合规问询', expected: '填写合规问询，并按真实字段上传反洗钱资料' },
  { action: '5. 授权代表', expected: '填写授权代表，并按真实字段上传授权代表资料' },
  { action: '6. 企业董事', expected: '只创建一名自然人董事，并上传该自然人董事的4份映射资料' },
  { action: '7. 企业股东', expected: '只创建一名自然人股东，不创建企业股东；最后4份资料上传成功' },
  { action: '资料完整性门禁', expected: '本次自然人董事Journey适用的20份映射资料均已由页面接受' },
  { action: '8. 授权', expected: 'Corporate独立Signer完成TEST签署，经等待签署结果中转页确认回调后进入提交申请' },
  { action: '9. 提交申请', expected: '签署完成后Corporate KYC最终提交只点击一次' },
  { action: 'Client提交结果', expected: '进入真实提交后/等待审核状态且认证仍有效' },
  { action: 'Admin Post-Registration Diagnostic', expected: '尽力定位企业用户，结果不参与REG-C-002计分' }
];

const journeyDocuments = CORPORATE_DOCUMENT_MAPPING.filter(
  document => document.variant !== 'legal-director'
);

const stageLabels: Record<CorporateRegistrationJourneyStage, string> = {
  PREPARED: '准备企业Journey',
  ACCOUNT_CREATED: '选择企业账户',
  BASIC_PROFILE: '基本档案',
  OPERATIONS: '运营信息',
  SOURCE_OF_ASSETS: '资产来源',
  COMPLIANCE: '合规问询',
  AUTHORIZED_REPRESENTATIVE: '授权代表',
  DIRECTORS: '企业董事',
  SHAREHOLDERS: '企业股东',
  UBO: '企业股东 / UBO',
  DOCUMENTS: '资料完整性门禁',
  AUTHORIZATION: '授权',
  SIGNING_COMPLETED: '授权已完成',
  KYC_SUBMITTED: '提交申请',
  COMPLETED: '等待审核'
};

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for REG-C-002.`);
  return value;
}

function journeyAuthPath(runId: string): string {
  return path.resolve('auth', 'journeys', `${runId}.json`);
}

function documentsFor(
  variant: CorporateDocumentDefinition['variant'],
  step?: CorporateDocumentDefinition['step']
): CorporateDocumentDefinition[] {
  return CORPORATE_DOCUMENT_MAPPING.filter(document =>
    document.variant === variant && (!step || document.step === step)
  );
}

test(
  'REG-C-002 Corporate Registration Full Happy Path',
  {
    tag: ['@registration', '@corporate', '@mutation', '@L4'],
    annotation: [
      { type: 'caseId', description: 'REG-C-002' },
      { type: 'changesData', description: 'true' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ browser, business, registrationContext, registrationPage, adminPage }, testInfo) => {
    test.setTimeout(1_200_000);
    business.flow('corporate-registration', {
      caseId: 'REG-C-002',
      name: 'Corporate Registration Full Happy Path',
      level: 'L4',
      type: ['E2E', 'Mutation', 'Third Party'],
      expectedResult: '企业资料及签署提交后，复用同一账号在企业用户Tab完成KYC审核，干净登录确认Client审核通过。'
    });
    business.plan(steps);

    const clientBaseUrl = required('CLIENT_BASE_URL', env.client.baseUrl);
    const password = required('CLIENT_PASSWORD', env.client.password);
    const registerOtp = required('CLIENT_REGISTER_OTP', env.personalRegistration.otp);
    const loginOtp = required('CLIENT_OTP or CLIENT_REGISTER_OTP', env.client.otp ?? registerOtp);
    const store = new CorporateRegistrationJourneyStore();
    await preflightRegistrationAdmin(adminPage, testInfo);
    const submittedUser = store.load();
    const requestedEmail = env.corporateRegistration.email?.trim().toLowerCase();
    const explicitlyDifferentJourney = Boolean(
      env.corporateRegistration.startNewJourney && requestedEmail &&
      submittedUser?.email.trim().toLowerCase() !== requestedEmail
    );
    const approvalRunId = process.env.BUSINESS_REGISTRATION_APPROVAL_SOURCE_RUN_ID?.trim() ||
      env.personalRegistration.adminApprovalSourceRunId ||
      (!explicitlyDifferentJourney ? pendingRegistrationApprovalRunId('BUSINESS', requestedEmail) ||
        (submittedUser && corporateJourneyStageAtLeast(submittedUser.stage, 'KYC_SUBMITTED')
          ? submittedUser.runId : undefined) : undefined);
    if (approvalRunId) {
      const source = submittedRegistrationSource('BUSINESS', approvalRunId);
      if (requestedEmail && source.email.trim().toLowerCase() !== requestedEmail) {
        throw new Error('REGISTRATION_KYC_SOURCE_EMAIL_MISMATCH: the selected case is not the requested user.');
      }
      await runRegistrationKycTail({ source,
        browser, adminPage, business, testInfo });
      return;
    }
    const guard = new CorporateRegistrationGuard();
    let journey!: CorporateRegistrationJourney;
    let accountCreatedThisExecution = false;
    let recoverableCorrections = 0;
    let signingMethod = 'Not reached';
    let signingInitialFields: number | undefined;
    let signingFinalFields: number | undefined;
    let signerImplementation = 'CorporateRegistrationSigner';
    let finalState = 'Not submitted';
    let authorizationInitializationStatus: number | undefined;
    let signingCallbackPageObserved = false;
    let signingCallbackStatus = 'Not reached';
    let signingCallbackTransitionClicks = 0;
    let signingCallbackNetwork: Array<{ path: string; status: number; method: string }> = [];

    for (const document of journeyDocuments) {
      business.setDocumentProgress({
        id: document.id,
        field: `${document.step} / ${document.pageLabel}`,
        file: document.asset,
        status: 'PENDING'
      });
    }

    const updateReport = (): void => {
      business.setBusinessData({
        runId: journey?.runId,
        corporateUser: journey?.companyName ?? journey?.displayName,
        corporateEmail: journey ? maskRegistrationEmail(journey.email) : undefined,
        corporatePhone: journey ? maskRegistrationPhone(journey.phone) : undefined,
        passwordSource: 'CLIENT_PASSWORD',
        passwordConfigured: true,
        accountCreateCount: journey?.accountCreateCount ?? 0,
        accountCreateAttemptCount: journey?.accountCreateAttemptCount ?? 0,
        totalRegistrationSteps: 9,
        currentRegistrationStep: journey ? stageLabels[journey.stage] : undefined,
        directorCount: journey?.directorCount ?? 0,
        shareholderCount: journey?.shareholderCount ?? 0,
        uboCount: journey?.uboCount ?? 0,
        uploadedDocumentCount: journey?.uploadedDocumentIds.length ?? 0,
        totalDocumentCount: journeyDocuments.length,
        missingDocumentCount: journeyDocuments.length - (journey?.uploadedDocumentIds.length ?? 0),
        signerImplementation,
        signingMethod,
        signingInitialFields,
        signingFinalFields,
        signingCompleted: journey?.signingCompleted ?? false,
        signingCallbackPageObserved,
        signingCallbackStatus,
        signingCallbackTransitionClicks,
        signingCallbackNetwork,
        finalSubmitCount: journey?.finalSubmitCount ?? 0,
        clientFinalState: journey?.clientFinalState ?? finalState,
        resumeStage: journey?.stage,
        recoverablePreSubmitCorrections: recoverableCorrections,
        secondAccountCreated: false
      });
      if (journey) business.setResumeState(journey.stage);
    };

    const advance = (
      stage: CorporateRegistrationJourneyStage,
      updates: Partial<Omit<CorporateRegistrationJourney, 'schemaVersion' | 'runId' | 'stage'>> = {}
    ): void => {
      if (corporateJourneyStageAtLeast(journey.stage, stage)) {
        journey = store.update(journey, updates);
      } else {
        journey = store.advance(journey, stage, updates);
      }
      updateReport();
    };

    const corporate = new CorporateRegistrationPage(registrationPage);

    const uploadDocuments = async (
      definitions: readonly CorporateDocumentDefinition[],
      setCurrentAction: (action: string) => void
    ): Promise<void> => {
      for (const document of definitions) {
        const alreadyRecorded = journey.uploadedDocumentIds.includes(document.id);
        setCurrentAction(
          `${alreadyRecorded ? '复核' : '上传'} ${document.pageLabel} (${journey.uploadedDocumentIds.length}/${journeyDocuments.length})`
        );
        business.setDocumentProgress({
          id: document.id,
          field: `${document.step} / ${document.pageLabel}`,
          file: document.asset,
          status: 'RUNNING'
        });
        try {
          const result = await corporate.uploadDocument(document);
          journey = store.recordDocument(journey, document.id);
          business.setDocumentProgress({
            id: document.id,
            field: `${document.step} / ${document.pageLabel}`,
            file: document.asset,
            status: 'PASS',
            actual: result.alreadyUploaded
              ? 'Resume复核：页面已保留本Journey文件'
              : `页面上传成功；HTTP ${result.httpStatus}`
          });
          updateReport();
        } catch (error) {
          business.setDocumentProgress({
            id: document.id,
            field: `${document.step} / ${document.pageLabel}`,
            file: document.asset,
            status: 'FAIL',
            actual: error instanceof Error ? error.message : String(error)
          });
          throw error;
        }
      }
    };

    const authenticateExistingJourney = async (): Promise<void> => {
      const login = new LoginPage(registrationPage);
      await registrationPage.goto(clientBaseUrl, { waitUntil: 'domcontentloaded' });
      if (/\/login(?:$|[?#])/.test(registrationPage.url())) {
        await login.fillCredentials({ username: journey.email, password });
        await login.submitCredentials();
        await login.expectOtpStep();
        await login.fillOtp(loginOtp);
        await login.confirmLoginToAuthenticatedRoute();
      }
      await expect(registrationPage).not.toHaveURL(/\/login(?:$|[?#])/);
      mkdirSync(path.dirname(journeyAuthPath(journey.runId)), { recursive: true });
      await registrationContext.storageState({ path: journeyAuthPath(journey.runId) });
    };

    try {
      await business.step(steps[0], async ({ setActual, setBusinessData }) => {
        guard.validateRuntime({
          baseURL: clientBaseUrl,
          workers: testInfo.config.workers,
          retries: testInfo.project.retries,
          repeatEach: testInfo.project.repeatEach,
          allowClientMutationTests: env.allowClientMutationTests
        });
        expect(testInfo.repeatEachIndex).toBe(0);
        const existingJourney = store.load();
        const startExplicitNewJourney = Boolean(
          existingJourney &&
          existingJourney.stage !== 'COMPLETED' &&
          explicitlyDifferentJourney
        );
        journey = !existingJourney || existingJourney.stage === 'COMPLETED' || startExplicitNewJourney
          ? store.create(
            new Date(),
            env.corporateRegistration.email,
            env.corporateRegistration.phone,
            {
              archiveIncomplete: startExplicitNewJourney,
              companyName: env.corporateRegistration.companyName
            }
          )
          : existingJourney;
        if (journey.accountCreateCount === 1 && journey.stage === 'ACCOUNT_CREATED') {
          recoverableCorrections = 1;
          business.recordDiagnostic({
            id: 'corporate-recovered-step-entry',
            name: 'RECOVERABLE_PRE_SUBMIT',
            status: 'info',
            summary: '基本档案步骤入口已按真实Overview DOM修正并Resume同一账号',
            affectsCoreBusiness: false
          });
        }
        guard.restore({
          accountCreateAttemptCount: journey.accountCreateAttemptCount,
          signingCompleted: journey.signingCompleted,
          finalSubmitCount: journey.finalSubmitCount
        });
        for (const document of journeyDocuments) {
          expect(existsSync(path.resolve(document.asset))).toBe(true);
        }
        setBusinessData({
          corporateUser: journey.companyName ?? journey.displayName,
          corporateEmail: maskRegistrationEmail(journey.email),
          corporatePhone: maskRegistrationPhone(journey.phone),
          sequence: journey.sequence,
          nameSuffix: journey.nameSuffix
        });
        setActual(`Sandbox门禁通过；Journey=${journey.runId}；起点=${journey.stage}；仅允许此企业账号。`);
        updateReport();
      });

      const profile = corporateProfileForJourney(journey!);

      await business.step(steps[1], async ({ setActual, setBusinessData }) => {
        if (journey.stage === 'PREPARED') {
          if (journey.accountCreateAttemptCount !== 0) {
            throw new Error('Corporate account creation was previously attempted with an unknown result; second account creation is forbidden.');
          }
          const registration = new PersonalRegistrationPage(registrationPage);
          await registration.goto(clientBaseUrl);
          await registration.fillEmail(journey.email);
          await registration.requestVerificationCode();
          await registration.verifyEmail(registerOtp);
          await registration.fillPassword(password);
          const agreements = await registration.acceptVisibleAgreements();
          guard.assertAccountCreationAllowed();
          guard.recordAccountCreationAttempt();
          journey = store.recordAccountCreateAttempt(journey);
          business.markPotentiallySubmitted();
          business.disallowSafeRerun();
          updateReport();
          await registration.submitRegistration();
          await registration.expectAuthenticatedOnboarding();
          journey = store.markAccountCreated(journey);
          accountCreatedThisExecution = true;
          mkdirSync(path.dirname(journeyAuthPath(journey.runId)), { recursive: true });
          await registrationContext.storageState({ path: journeyAuthPath(journey.runId) });
          const accountType = new AccountTypeSelectionPage(registrationPage);
          await accountType.expectOpen();
          await accountType.selectCorporate();
          setBusinessData({ accountAgreementCount: agreements });
        } else {
          await authenticateExistingJourney();
        }
        await expect(registrationPage).not.toHaveURL(/\/login(?:$|[?#])/);
        setActual(
          accountCreatedThisExecution
            ? '企业Client账号创建1次并选择企业账户；已持久化Resume。'
            : `Resume同一企业账号；未创建新账号；阶段=${journey.stage}。`
        );
        updateReport();
      });

      await business.step(steps[2], async ({ setActual, setCurrentAction }) => {
        if (!corporateJourneyStageAtLeast(journey.stage, 'BASIC_PROFILE')) {
          setCurrentAction('填写并保存企业基本档案');
          await corporate.gotoStep(clientBaseUrl, 1);
          await corporate.fillBasicProfile(profile);
          await corporate.saveCurrentStep('/kyb/update-base-info', 2);
          advance('BASIC_PROFILE');
        }
        if (journey.companyName) {
          await corporate.gotoStep(clientBaseUrl, 1);
          await corporate.expectCompanyName(profile.companyName);
        }
        setActual(`企业名称=${profile.companyName}；输入值完整接受，保存后重新打开基本档案读取一致。`);
      });

      await business.step(steps[3], async ({ setActual, setCurrentAction }) => {
        if (!corporateJourneyStageAtLeast(journey.stage, 'OPERATIONS')) {
          await corporate.gotoStep(clientBaseUrl, 2);
          setCurrentAction('填写企业运营信息');
          await corporate.fillOperations({
            phone: journey.phone,
            email: journey.email,
            businessNature: profile.businessNature
          });
          await uploadDocuments(documentsFor('company', '运营信息'), setCurrentAction);
          await corporate.saveCurrentStep('/kyb/update-operation-info', 3);
          advance('OPERATIONS');
        }
        const operationDocuments = documentsFor('company', '运营信息');
        const uploaded = operationDocuments.filter(document => journey.uploadedDocumentIds.includes(document.id));
        setActual(`企业运营信息已保存；本页资料=${uploaded.length}/${operationDocuments.length}。`);
      });

      await business.step(steps[4], async ({ setActual, setCurrentAction }) => {
        if (!corporateJourneyStageAtLeast(journey.stage, 'SOURCE_OF_ASSETS')) {
          await corporate.gotoStep(clientBaseUrl, 3);
          setCurrentAction('填写并保存企业资产来源');
          await corporate.fillSourceOfAssets(profile.sourceOfAssets);
          await corporate.saveCurrentStep('/kyb/update-fund-source', 4);
          advance('SOURCE_OF_ASSETS');
        }
        setActual('企业资产来源已独立填写并保存。');
      });

      await business.step(steps[5], async ({ setActual, setCurrentAction }) => {
        if (!corporateJourneyStageAtLeast(journey.stage, 'COMPLIANCE')) {
          await corporate.gotoStep(clientBaseUrl, 4);
          setCurrentAction('填写企业合规问询');
          await corporate.fillCompliance(profile.accountPurpose);
          await uploadDocuments(documentsFor('company', '合规问询'), setCurrentAction);
          await corporate.saveCurrentStep('/kyb/update-compliance', 5);
          advance('COMPLIANCE');
        }
        const complianceDocuments = documentsFor('company', '合规问询');
        const uploaded = complianceDocuments.filter(document => journey.uploadedDocumentIds.includes(document.id));
        setActual(`企业合规问询已保存；本页资料=${uploaded.length}/${complianceDocuments.length}。`);
      });

      await business.step(steps[6], async ({ setActual, setCurrentAction }) => {
        if (!corporateJourneyStageAtLeast(journey.stage, 'AUTHORIZED_REPRESENTATIVE')) {
          await corporate.gotoStep(clientBaseUrl, 5);
          setCurrentAction('填写授权代表及页面真实UBO字段');
          await corporate.fillAuthorizedRepresentative(profile.representative);
          await uploadDocuments(documentsFor('authorized-representative'), setCurrentAction);
          await corporate.saveCurrentStep('/kyb/add-related-person', 6);
          advance('AUTHORIZED_REPRESENTATIVE', { uboCount: 1 });
        }
        const representativeDocuments = documentsFor('authorized-representative');
        const uploaded = representativeDocuments.filter(document => journey.uploadedDocumentIds.includes(document.id));
        setActual(`授权代表已保存；本页资料=${uploaded.length}/${representativeDocuments.length}；UBO=1。`);
      });

      await business.step(steps[7], async ({ setActual, setCurrentAction }) => {
        if (!corporateJourneyStageAtLeast(journey.stage, 'DIRECTORS')) {
          await corporate.gotoStep(clientBaseUrl, 6);
          const initialCounts = await corporate.directorCounts();
          expect(initialCounts.legal, 'REG-C-002 must not create a legal director.').toBe(0);
          if (initialCounts.natural === 0) {
            setCurrentAction('创建自然人董事并上传13-16号资料');
            await corporate.openNaturalDirectorForm();
            await corporate.fillNaturalDirector(profile.naturalDirector);
            await uploadDocuments(documentsFor('natural-director'), setCurrentAction);
            await corporate.createRelatedPerson('创建董事档案');
          } else if (initialCounts.natural !== 1) {
            throw new Error(`Natural director candidate count must equal 0 or 1; received ${initialCounts.natural}.`);
          }

          const finalCounts = await corporate.directorCounts();
          expect(finalCounts).toEqual({ natural: 1, legal: 0 });
          await corporate.continueFromRelatedPersonList(7);
          advance('DIRECTORS', { directorCount: 1 });
        }
        setActual('自然人董事1名、法人董事0名；自然人董事资料4份已完成。');
      });

      await business.step(steps[8], async ({ setActual, setCurrentAction }) => {
        if (!corporateJourneyStageAtLeast(journey.stage, 'SHAREHOLDERS')) {
          await corporate.gotoStep(clientBaseUrl, 7);
          const initialCounts = await corporate.shareholderCounts();
          expect(initialCounts.legal, 'REG-C-002 must not create a legal shareholder.').toBe(0);
          if (initialCounts.natural === 0) {
            setCurrentAction('创建自然人股东并上传25-28号资料');
            await corporate.openNaturalShareholderForm();
            await corporate.fillNaturalShareholder(profile.shareholder);
            await uploadDocuments(documentsFor('natural-shareholder'), setCurrentAction);
            await corporate.createRelatedPerson('创建股东档案');
          } else if (initialCounts.natural !== 1) {
            throw new Error(`Natural shareholder candidate count must equal 0 or 1; received ${initialCounts.natural}.`);
          }
          expect(await corporate.shareholderCounts()).toEqual({ natural: 1, legal: 0 });
          const initialization = await corporate.continueFromShareholdersToAuthorization();
          authorizationInitializationStatus = initialization.httpStatus;
          advance('SHAREHOLDERS', { shareholderCount: 1 });
        }
        if (!corporateJourneyStageAtLeast(journey.stage, 'UBO')) {
          advance('UBO', { uboCount: 1 });
        }
        setActual('自然人股东1名、企业股东0名；授权代表为唯一UBO；页面未提供持股比例输入，因此未编造该字段。');
      });

      await business.step(steps[9], async ({ setActual }) => {
        const missing = journeyDocuments.filter(
          document => !journey.uploadedDocumentIds.includes(document.id)
        );
        expect(missing, `Missing corporate documents: ${missing.map(item => item.id).join(', ')}`).toEqual([]);
        if (!corporateJourneyStageAtLeast(journey.stage, 'DOCUMENTS')) advance('DOCUMENTS');
        setActual(`本Journey适用资料 ${journeyDocuments.length}/${journeyDocuments.length}；Missing=0；法人董事资料不适用。`);
      });

      await business.step(steps[10], async ({ setActual, setCurrentAction }) => {
        if (!corporateJourneyStageAtLeast(journey.stage, 'SIGNING_COMPLETED')) {
          await corporate.ensureAuthorizationStep(clientBaseUrl);
          if (!corporateJourneyStageAtLeast(journey.stage, 'AUTHORIZATION')) advance('AUTHORIZATION');
          setCurrentAction('验证Corporate嵌入DOM并绘制固定TEST签名');
          const signer = new CorporateRegistrationSigner(registrationPage);
          const inspection = await signer.open(
            `${profile.representative.firstName} ${profile.representative.lastName}`
          );
          signerImplementation = inspection.implementation;
          signingInitialFields = inspection.initialRemainingFields;
          expect(inspection.domContractVerified).toBe(true);
          expect(inspection.identityChallengePresent).toBe(false);
          expect(signingInitialFields).toBeGreaterThan(0);
          const result = await signer.signSandboxDocument({
            signatureText: env.personalRegistration.signatureText,
            testTitle: env.personalRegistration.testTitle
          });
          signingMethod = result.signatureMethod;
          signingFinalFields = result.finalRemainingFields;
          expect(result.testSignatureApplied).toBe(true);
          expect(result.finalRemainingFields).toBe(0);
          expect(result.agreementActionClickCount).toBeLessThanOrEqual(1);
          expect(result.agreementConfirmationClickCount).toBeLessThanOrEqual(1);
          const callback = await signer.waitForCorporateSubmissionStep();
          signingCallbackPageObserved = callback.waitingPageObserved;
          signingCallbackStatus = callback.waitingStatusText;
          signingCallbackTransitionClicks = callback.transitionClickCount;
          signingCallbackNetwork = callback.networkObservations;
          guard.markSigningCompleted();
          advance('SIGNING_COMPLETED', { signingCompleted: true });
        } else {
          guard.markSigningCompleted();
          await corporate.gotoStep(clientBaseUrl, 9);
        }
        setActual(`初始化HTTP=${authorizationInitializationStatus ?? 'Resume'}；Signer=${signerImplementation}；方式=${signingMethod}；Remaining=${signingFinalFields ?? 0}；等待签署结果页=${signingCallbackPageObserved}。`);
      });

      await business.step(steps[11], async ({ setActual }) => {
        await corporate.expectSubmissionStep();
        if (journey.finalSubmitCount !== 0) {
          throw new Error('Corporate final submit was already attempted; a second click is forbidden.');
        }
        guard.assertFinalSubmissionAllowed();
        guard.recordFinalSubmissionAttempt();
        journey = store.update(journey, { finalSubmitCount: 1 });
        business.markPotentiallySubmitted();
        business.disallowSafeRerun();
        business.markMutationPerformed('Corporate KYC final submit');
        updateReport();
        const evidence = await corporate.submitCorporateApplicationOnce();
        advance('KYC_SUBMITTED', { clientSubmittedAt: new Date().toISOString() });
        rememberRegistrationSubmission({ accountType: 'BUSINESS', runId: journey.runId,
          email: journey.email, displayName: journey.companyName ?? journey.displayName,
          userId: journey.userId, clientSubmittedAt: journey.clientSubmittedAt });
        setActual(`最终提交点击1次；/kyb/submit-application HTTP ${evidence.httpStatus}。`);
      });

      await business.step(steps[12], async ({ setActual }) => {
        finalState = await corporate.expectSubmittedState();
        advance('COMPLETED', { clientFinalState: finalState });
        await registrationPage.reload({ waitUntil: 'domcontentloaded' });
        await expect(registrationPage).not.toHaveURL(/\/login(?:$|[?#])/);
        setActual(`Client最终状态=${finalState}；同一企业账号认证仍有效。`);
      });

      await business.step(steps[13], async context => {
        if (!env.admin.baseUrl || !existsSync(authStatePaths.admin)) {
          business.recordDiagnostic({
            id: 'corporate-admin-post-registration',
            name: 'Admin Post-Registration Verification',
            status: 'unavailable',
            summary: 'Admin只读诊断未执行',
            reason: 'Admin URL或storageState当前不可用',
            affectsCoreBusiness: false
          });
          context.setActual('Admin只读诊断不可用；不影响Corporate Registration核心结果。');
          return;
        }
        const adminContext = await browser.newContext({
          baseURL: env.admin.baseUrl,
          storageState: existingAuthState(authStatePaths.admin)
        });
        try {
          const adminPage = await adminContext.newPage();
          const dashboard = new RegistrationReviewDashboardPage(adminPage);
          await dashboard.goto(env.admin.baseUrl);
          const result = await dashboard.locateUniquePendingCandidate({
            accountType: 'corporate',
            email: journey.email,
            displayName: profile.companyName
          });
          business.recordDiagnostic({
            id: 'corporate-admin-post-registration',
            name: 'Admin Post-Registration Verification',
            status: result.candidateCount === 1 ? 'available' : 'unavailable',
            summary: result.candidateCount === 1 ? 'Admin唯一定位企业用户' : 'Admin暂未定位企业用户',
            reason: `candidateCount=${result.candidateCount}; route=/zh-CN/kyc/dashboard; tab=企业用户`,
            affectsCoreBusiness: false
          });
          context.setActual(`Admin Diagnostic candidateCount=${result.candidateCount}；不参与计分。`);
        } catch (error) {
          business.recordDiagnostic({
            id: 'corporate-admin-post-registration',
            name: 'Admin Post-Registration Verification',
            status: 'unavailable',
            summary: 'Admin用户检索暂不可用',
            reason: error instanceof Error ? error.message : String(error),
            affectsCoreBusiness: false
          });
          context.setActual('Admin Diagnostic暂不可用；不影响Corporate Registration核心结果。');
        } finally {
          await adminContext.close();
        }
      });

      const primaryOracles = [
        ['one-account', '只创建一个企业账号', `创建次数=${journey.accountCreateCount}`, journey.accountCreateCount === 1],
        ['basic-profile', '基本档案独立完成', `阶段=${journey.stage}`, corporateJourneyStageAtLeast(journey.stage, 'BASIC_PROFILE')],
        ['operations', '运营信息独立完成', `阶段=${journey.stage}`, corporateJourneyStageAtLeast(journey.stage, 'OPERATIONS')],
        ['source-of-assets', '资产来源独立完成', `阶段=${journey.stage}`, corporateJourneyStageAtLeast(journey.stage, 'SOURCE_OF_ASSETS')],
        ['compliance', '合规问询独立完成', `阶段=${journey.stage}`, corporateJourneyStageAtLeast(journey.stage, 'COMPLIANCE')],
        ['authorized-representative', '授权代表独立完成', `阶段=${journey.stage}`, corporateJourneyStageAtLeast(journey.stage, 'AUTHORIZED_REPRESENTATIVE')],
        ['directors', '只创建一名自然人董事', `自然人董事=${journey.directorCount}；法人董事=0`, journey.directorCount === 1],
        ['shareholder-ubo', '只创建一名自然人股东并完成UBO', `自然人股东=${journey.shareholderCount}；企业股东=0；UBO=${journey.uboCount}`, journey.shareholderCount === 1 && journey.uboCount === 1],
        ['documents', '本Journey适用资料完成', `上传=${journey.uploadedDocumentIds.length}/${journeyDocuments.length}`, journey.uploadedDocumentIds.length === journeyDocuments.length],
        ['signing', 'Corporate授权签署完成', `Signer=${signerImplementation}；Remaining=${signingFinalFields ?? 0}`, journey.signingCompleted],
        ['submit-once', 'Corporate KYC提交一次', `提交次数=${journey.finalSubmitCount}`, journey.finalSubmitCount === 1],
        ['client-final', 'Client进入提交后状态', `状态=${journey.clientFinalState}`, journey.stage === 'COMPLETED']
      ] as const;
      for (const [id, name, actual, passed] of primaryOracles) {
        business.recordPrimaryOracle({
          id,
          name,
          expected: '通过',
          actual,
          status: passed ? 'passed' : 'failed'
        });
      }
      updateReport();
    } catch (error) {
      if (typeof journey !== 'undefined') {
        updateReport();
        if (journey.accountCreateCount === 1 || journey.accountCreateAttemptCount === 1) {
          business.disallowSafeRerun();
        }
      }
      throw error;
    }
    await runRegistrationKycTail({ source: submittedRegistrationSource('BUSINESS', journey.runId),
      browser, adminPage, business, testInfo });
  }
);
