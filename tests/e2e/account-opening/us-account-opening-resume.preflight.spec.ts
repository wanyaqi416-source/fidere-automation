import { AccountOpeningReviewPage } from '../../../pages/admin/AccountOpeningReviewPage';
import { AccountTypeConfigurationPage } from '../../../pages/admin/AccountTypeConfigurationPage';
import { JurisdictionAccountChooserPage } from '../../../pages/client/JurisdictionAccountChooserPage';
import { UsAccountOpeningPage } from '../../../pages/client/UsAccountOpeningPage';
import { DocumentSigningPage } from '../../../pages/third-party/DocumentSigningPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { resolveUsOpeningDocumentAssets } from '../../../src/account-opening/account-opening-assets';
import {
  US_ACCOUNT_OPENING_FLOW_ID,
  UsAccountOpeningExecutionGuard,
  activeUsAccountOpeningStates
} from '../../../src/account-opening/account-opening-e2e';
import { runUsAccountOpeningResumePreflight } from '../../../src/account-opening/us-account-opening-resume-preflight';
import { env } from '../../../src/config/env';
import { FlowStateStore, assertSandboxEnvironment } from '../../../src/flow-engine';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'OPEN-US-003 Resume只读Preflight',
  {
    tag: ['@e2e', '@account-opening', '@us', '@resume', '@readonly', '@preflight', '@L2'],
    annotation: [
      { type: 'caseId', description: 'OPEN-US-003-RESUME-PREFLIGHT' },
      { type: 'flowId', description: US_ACCOUNT_OPENING_FLOW_ID },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ clientPage, adminPage, business }) => {
    test.setTimeout(2 * 60 * 1000);
    if (
      !env.client.baseUrl ||
      !env.admin.baseUrl ||
      !env.accountOpening.testEmail ||
      !env.accountOpening.signatureText ||
      !env.accountOpening.initials
    ) {
      throw new Error('OPEN-US-003 Resume Preflight requires Client/Admin URLs and OPENING_* settings.');
    }
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);
    assertSandboxEnvironment(env.client.baseUrl);
    assertSandboxEnvironment(env.admin.baseUrl);

    const store = new FlowStateStore();
    const states = activeUsAccountOpeningStates(store);
    expect(states).toHaveLength(1);
    const state = states[0];
    expect([
      'DOCUMENTS_UPLOADED',
      'DOCUMENT_READY_TO_COMPLETE'
    ]).toContain(state.stage);

    const guard = new UsAccountOpeningExecutionGuard();
    const chooser = new JurisdictionAccountChooserPage(clientPage);
    const application = new UsAccountOpeningPage(clientPage);
    const signer = new DocumentSigningPage(clientPage);
    const reviews = new AccountOpeningReviewPage(adminPage);
    const accountTypes = new AccountTypeConfigurationPage(adminPage);
    const assets = resolveUsOpeningDocumentAssets();

    business.flow(US_ACCOUNT_OPENING_FLOW_ID, {
      caseId: 'OPEN-US-003-RESUME-PREFLIGHT',
      name: 'OPEN-US-003 Resume只读Preflight',
      description: '只读取原草稿与Documenso字段，不上传、不签名、不Complete、不提交、不审核。',
      level: 'L2',
      type: ['Readonly', 'Preflight'],
      changesData: false,
      affectsMoney: false,
      safetySwitches: []
    });

    const result = await business.step(
      {
        action: '验证原草稿满足OPEN-US-003 Resume全部前置条件',
        expected: '五份资料、非空预填Full Name、TEST Canvas签名、0 Fields Remaining与Complete可用，四个最终动作均为0次'
      },
      async context => {
        const value = await runUsAccountOpeningResumePreflight({
          clientPage,
          adminPage,
          clientBaseUrl: env.client.baseUrl!,
          adminBaseUrl: env.admin.baseUrl!,
          customerIdentity: env.accountOpening.testEmail!,
          signerIdentity: {
            signatureText: env.accountOpening.signatureText!,
            initials: env.accountOpening.initials!
          },
          assets,
          guard,
          chooser,
          application,
          signer,
          reviews,
          accountTypes
        });
        expect(value.persistedUploads).toHaveLength(5);
        expect(value.preparedSigning.signerFullName.trim().length).toBeGreaterThan(0);
        expect(value.preparedSigning.signatureValue).toBe('TEST');
        expect(value.preparedSigning.fieldsRemaining).toBe(0);
        expect(value.preparedSigning.signatureFieldsCompleted).toBe(true);
        expect(signer.completeClickCount()).toBe(0);
        expect(signer.signingConfirmationClickCount()).toBe(0);
        expect(application.submissionClickCount()).toBe(0);
        expect(store.load(state.flowId, state.runId)?.stage).toBe(state.stage);
        context.setBusinessData({
          resumeMode: 'OPEN-US-003 Resume Preflight',
          resumeStartStage: state.stage,
          documentsUploaded: true,
          openingDocumentAssetCount: value.persistedUploads.length,
          signatureFieldsCompleted: true,
          fieldsRemaining: 0,
          fidereModuleName: value.preparedSigning.fidereModuleName,
          signatureValue: value.preparedSigning.signatureValue,
          signerFullNamePresent: value.preparedSigning.signerFullName.trim().length > 0,
          documensoCompleteClicks: signer.completeClickCount(),
          documensoSigningConfirmationClicks: signer.signingConfirmationClickCount(),
          finalSubmissionClicks: application.submissionClickCount(),
          adminOpeningApprovalClicks: 0,
          existingUsOpeningApplicationCount: value.existingUsApplicationCount,
          noSecondOpeningApplication: true,
          noRepeatedDocumentSigning: true,
          resumeStage: state.stage,
          confirmed: true
        });
        context.setActual('Resume草稿全部前置条件通过；未上传、未签名、未Complete、未Client提交、未Admin审核。');
        return value;
      }
    );

    expect(result.channelEnabled).toBe(true);
  }
);
