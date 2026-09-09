import type { Page } from '@playwright/test';

import { AccountOpeningReviewPage } from '../../pages/admin/AccountOpeningReviewPage';
import { AccountTypeConfigurationPage } from '../../pages/admin/AccountTypeConfigurationPage';
import { JurisdictionAccountChooserPage } from '../../pages/client/JurisdictionAccountChooserPage';
import { UsAccountOpeningPage } from '../../pages/client/UsAccountOpeningPage';
import { DocumentSigningPage } from '../../pages/third-party/DocumentSigningPage';
import type { UsOpeningDocumentAsset } from './account-opening-assets';
import type { UsAccountOpeningExecutionGuard } from './account-opening-e2e';
import { runUsAccountOpeningEnvironmentPreflight } from './us-account-opening-environment-preflight';

export type UsAccountOpeningResumePreflightResult = {
  baselineReferences: Set<string>;
  existingUsApplicationCount: number;
  clientStatus: '可申请';
  persistedUploads: Awaited<ReturnType<UsAccountOpeningPage['verifyUploadedDocuments']>>;
  preparedSigning: Awaited<ReturnType<DocumentSigningPage['inspectPreparedSandboxSignature']>>;
  channel: 'interlace';
  channelEnabled: true;
};

export async function runUsAccountOpeningResumePreflight(input: {
  clientPage: Page;
  adminPage: Page;
  clientBaseUrl: string;
  adminBaseUrl: string;
  customerIdentity: string;
  signerIdentity: {
    signatureText: string;
    initials: string;
  };
  assets: readonly UsOpeningDocumentAsset[];
  guard: UsAccountOpeningExecutionGuard;
  chooser: JurisdictionAccountChooserPage;
  application: UsAccountOpeningPage;
  signer: DocumentSigningPage;
  reviews: AccountOpeningReviewPage;
  accountTypes: AccountTypeConfigurationPage;
}): Promise<UsAccountOpeningResumePreflightResult> {
  const environment = await runUsAccountOpeningEnvironmentPreflight({
    clientPage: input.clientPage,
    adminPage: input.adminPage,
    clientBaseUrl: input.clientBaseUrl,
    adminBaseUrl: input.adminBaseUrl,
    customerIdentity: input.customerIdentity,
    guard: input.guard,
    reviews: input.reviews,
    accountTypes: input.accountTypes
  });

  await input.chooser.goto(input.clientBaseUrl);
  await input.chooser.openChooser();
  const option = await input.chooser.readOption('美国账户');
  if (option.status !== '可申请' || !option.actionAvailable) {
    throw new Error(`OPEN-US-003 Resume requires a Client 可申请 draft; received ${option.status}.`);
  }
  await input.chooser.openApplication('美国账户');
  await input.application.expectLoaded();
  const persistedUploads = await input.application.verifyUploadedDocuments(input.assets);
  if (persistedUploads.length !== 5) {
    throw new Error(`OPEN-US-003 Resume requires 5 persisted documents; received ${persistedUploads.length}.`);
  }

  await input.signer.open(() => input.application.openTaxDocumentSigning());
  const preparedSigning = await input.signer.inspectPreparedSandboxSignature(input.signerIdentity);
  if (
    preparedSigning.signerFullName.trim().length === 0 ||
    preparedSigning.signatureValue !== 'TEST' ||
    preparedSigning.fieldsRemaining !== 0 ||
    !preparedSigning.signatureFieldsCompleted ||
    preparedSigning.finalActionName !== 'Complete'
  ) {
    throw new Error('OPEN-US-003 Resume Documenso draft is not ready for a single Complete action.');
  }
  if (
    input.signer.completeClickCount() !== 0 ||
    input.signer.signingConfirmationClickCount() !== 0
  ) {
    throw new Error('OPEN-US-003 Resume Preflight must not click Documenso Complete.');
  }

  return {
    baselineReferences: environment.baselineReferences,
    existingUsApplicationCount: environment.existingUsApplicationCount,
    clientStatus: '可申请',
    persistedUploads,
    preparedSigning,
    channel: environment.channel,
    channelEnabled: environment.channelEnabled
  };
}
