import type { Page } from '@playwright/test';

import { AccountOpeningReviewPage } from '../../pages/admin/AccountOpeningReviewPage';
import { AccountTypeConfigurationPage } from '../../pages/admin/AccountTypeConfigurationPage';
import {
  AccountDetailPage,
  type JurisdictionBalance
} from '../../pages/client/AccountDetailPage';
import { JurisdictionAccountChooserPage } from '../../pages/client/JurisdictionAccountChooserPage';
import {
  UsAccountOpeningPage,
  type UsOpeningFeeConfirmation
} from '../../pages/client/UsAccountOpeningPage';
import type { UsOpeningDocumentAsset } from './account-opening-assets';
import type { UsAccountOpeningExecutionGuard } from './account-opening-e2e';
import { runUsAccountOpeningEnvironmentPreflight } from './us-account-opening-environment-preflight';

export type UsAccountOpeningFeePreflightResult = {
  baselineReferences: Set<string>;
  existingUsApplicationCount: 0;
  clientStatus: '可申请';
  persistedDocumentCount: 5;
  taxFormStatus: string;
  fee: UsOpeningFeeConfirmation;
  feeBalanceAccountType: string;
  feeBalanceBefore: string;
  balanceSufficient: true;
  channel: 'interlace';
  channelEnabled: true;
  feeDialogOpen: boolean;
};

export async function runUsAccountOpeningFeePreflight(input: {
  clientPage: Page;
  adminPage: Page;
  clientBaseUrl: string;
  adminBaseUrl: string;
  customerIdentity: string;
  assets: readonly UsOpeningDocumentAsset[];
  guard: UsAccountOpeningExecutionGuard;
  chooser: JurisdictionAccountChooserPage;
  application: UsAccountOpeningPage;
  reviews: AccountOpeningReviewPage;
  accountTypes: AccountTypeConfigurationPage;
  keepFeeDialogOpen?: boolean;
}): Promise<UsAccountOpeningFeePreflightResult> {
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
    throw new Error(`OPEN-US-003 Fee Resume requires Client 可申请; received ${option.status}.`);
  }
  await input.chooser.openApplication('美国账户');
  await input.application.expectLoaded();
  const persistedUploads = await input.application.verifyUploadedDocuments(input.assets);
  if (persistedUploads.length !== 5) {
    throw new Error(`OPEN-US-003 Fee Resume requires 5 persisted documents; received ${persistedUploads.length}.`);
  }
  const taxFormStatus = await input.application.waitForTaxDocumentSigned();
  input.guard.markExistingDocumentSigned();
  input.guard.assertOpenFeeConfirmationAllowed();
  await input.application.openFeeConfirmationOnce();
  input.guard.recordOpenFeeConfirmation();
  const fee = await input.application.readOpeningFeeConfirmation();

  const keepFeeDialogOpen = input.keepFeeDialogOpen ?? true;
  if (!keepFeeDialogOpen) {
    await input.application.closeFeeConfirmationWithoutConfirming();
  }
  const balancePage = keepFeeDialogOpen
    ? await input.clientPage.context().newPage()
    : input.clientPage;
  let balance: JurisdictionBalance | undefined;
  try {
    const accounts = new AccountDetailPage(balancePage);
    await accounts.goto(input.clientBaseUrl);
    balance = await accounts.readUniqueAvailableBalanceByCurrency(
      fee.currency,
      fee.paymentAccount
    );
  } finally {
    if (keepFeeDialogOpen) await balancePage.close();
  }
  if (!balance) {
    throw new Error('OPEN-US-003 Fee Resume could not read the payment account balance.');
  }
  if (balance.availableBalance.lessThan(fee.openingFeeAmount)) {
    throw new Error(
      `BLOCKED_TEST_DATA: ${balance.accountType} ${fee.currency} balance is below the displayed opening fee.`
    );
  }

  return {
    baselineReferences: environment.baselineReferences,
    existingUsApplicationCount: 0,
    clientStatus: '可申请',
    persistedDocumentCount: 5,
    taxFormStatus,
    fee,
    feeBalanceAccountType: balance.accountType,
    feeBalanceBefore: balance.availableBalance.toString(),
    balanceSufficient: true,
    channel: environment.channel,
    channelEnabled: environment.channelEnabled,
    feeDialogOpen: keepFeeDialogOpen
  };
}
