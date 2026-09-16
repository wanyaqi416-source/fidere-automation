import type { Page } from '@playwright/test';

import { AdminClientUsersPage } from '../../pages/admin/AdminClientUsersPage';
import { PersonalPostRegistrationJourneyStore } from '../journey';

export type TigerOpeningUser = {
  accountType: 'PERSONAL' | 'BUSINESS';
  runId: string;
  email: string;
  displayName: string;
  userId?: string;
  reviewId?: string;
  clientSubmittedAt?: string;
};

export async function resolveTigerOpeningUser(input: {
  adminPage: Page;
  adminBaseUrl: string;
  sourceRunId: string;
  runtimeEmail?: string;
}): Promise<TigerOpeningUser> {
  if (input.runtimeEmail) {
    const identity = await new AdminClientUsersPage(input.adminPage)
      .readDepositCustomerIdentityByEmail(input.adminBaseUrl, input.runtimeEmail);
    return {
      accountType: identity.accountType, runId: input.sourceRunId, email: input.runtimeEmail,
      displayName: identity.name, userId: identity.userId
    };
  }
  const source = new PersonalPostRegistrationJourneyStore(input.sourceRunId).load();
  if (!source || source.stage !== 'COMPLETED') {
    throw new Error('Existing completed Journey required.');
  }
  return { accountType: 'PERSONAL', runId: input.sourceRunId, email: source.email, displayName: source.displayName,
    userId: 'userId' in source ? source.userId as string | undefined : undefined,
    reviewId: source.reviewId,
    clientSubmittedAt: 'clientSubmittedAt' in source ? source.clientSubmittedAt as string | undefined : undefined };
}
