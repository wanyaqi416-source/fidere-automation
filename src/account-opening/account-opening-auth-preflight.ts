import type { Page } from '@playwright/test';

import { AccountOpeningReviewPage } from '../../pages/admin/AccountOpeningReviewPage';
import { AccountTypeConfigurationPage } from '../../pages/admin/AccountTypeConfigurationPage';
import { AdminShellPage } from '../../pages/admin/AdminShellPage';
import { HomePage } from '../../pages/client/HomePage';
import { runDualSessionPreflight } from '../flow-engine';
import type { UsAccountOpeningExecutionGuard } from './account-opening-e2e';

export async function runUsAccountOpeningAuthPreflight(input: {
  clientPage: Page;
  adminPage: Page;
  clientBaseUrl: string;
  adminBaseUrl: string;
  guard: UsAccountOpeningExecutionGuard;
}): Promise<void> {
  const adminShell = new AdminShellPage(input.adminPage);
  const adminReviews = new AccountOpeningReviewPage(input.adminPage);
  const accountTypes = new AccountTypeConfigurationPage(input.adminPage);
  const clientHome = new HomePage(input.clientPage);

  await runDualSessionPreflight({
    checkAdmin: async () => {
      await adminShell.goto(input.adminBaseUrl);
      await adminShell.expectSessionActive();
      await adminReviews.goto(input.adminBaseUrl);
      await accountTypes.goto(input.adminBaseUrl);
    },
    checkClient: async () => {
      await clientHome.gotoDashboard(input.clientBaseUrl);
      await clientHome.expectNoLoginRedirect();
      await clientHome.expectDashboardLoaded();
      await clientHome.expectNoObviousError();
    },
    markReady: (clientReady, adminReady) =>
      input.guard.markAuthenticationReady(clientReady, adminReady)
  });
}
