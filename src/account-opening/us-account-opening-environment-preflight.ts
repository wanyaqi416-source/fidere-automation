import type { Page } from '@playwright/test';

import { AccountOpeningReviewPage } from '../../pages/admin/AccountOpeningReviewPage';
import { AccountTypeConfigurationPage } from '../../pages/admin/AccountTypeConfigurationPage';
import { runUsAccountOpeningAuthPreflight } from './account-opening-auth-preflight';
import type { UsAccountOpeningExecutionGuard } from './account-opening-e2e';

export type UsAccountOpeningEnvironmentPreflightResult = {
  baselineReferences: Set<string>;
  existingUsApplicationCount: number;
  channel: 'interlace';
  channelEnabled: true;
};

export async function runUsAccountOpeningEnvironmentPreflight(input: {
  clientPage: Page;
  adminPage: Page;
  clientBaseUrl: string;
  adminBaseUrl: string;
  customerIdentity: string;
  guard: UsAccountOpeningExecutionGuard;
  reviews: AccountOpeningReviewPage;
  accountTypes: AccountTypeConfigurationPage;
}): Promise<UsAccountOpeningEnvironmentPreflightResult> {
  await runUsAccountOpeningAuthPreflight({
    clientPage: input.clientPage,
    adminPage: input.adminPage,
    clientBaseUrl: input.clientBaseUrl,
    adminBaseUrl: input.adminBaseUrl,
    guard: input.guard
  });

  await input.reviews.goto(input.adminBaseUrl);
  await input.reviews.searchCustomer(input.customerIdentity);
  const existingRecords = await input.reviews.readRecords(input.customerIdentity);
  const baselineReferences = new Set(
    existingRecords.flatMap(record => record.applicationId ? [record.applicationId] : [])
  );
  let existingUsApplicationCount = 0;
  for (const record of existingRecords) {
    const detail = await input.reviews.openDetail(record);
    const data = await detail.readDetail(record.applicationId!);
    if (data.accountType === '美国账户') existingUsApplicationCount += 1;
  }
  if (existingUsApplicationCount !== 0) {
    throw new Error(
      `OPEN-US-003 Resume found ${existingUsApplicationCount} existing Admin US application(s).`
    );
  }

  await input.accountTypes.goto(input.adminBaseUrl);
  const accountConfig = await input.accountTypes.readUsConfiguration();
  if (accountConfig.channel !== 'interlace' || !accountConfig.enabled) {
    throw new Error('OPEN-US-003 Resume requires the enabled Interlace US account channel.');
  }

  return {
    baselineReferences,
    existingUsApplicationCount,
    channel: 'interlace',
    channelEnabled: true
  };
}
