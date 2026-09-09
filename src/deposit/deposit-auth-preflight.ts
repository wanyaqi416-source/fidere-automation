import type { Page } from '@playwright/test';

import { AdminShellPage } from '../../pages/admin/AdminShellPage';
import { DepositClaimListPage } from '../../pages/admin/DepositClaimListPage';
import { HomePage } from '../../pages/client/HomePage';
import { runDualSessionPreflight } from '../flow-engine';
import type { DepositExecutionGuard } from './deposit-e2e';

export async function runDepositAuthPreflight(input: {
  clientPage: Page;
  adminPage: Page;
  clientBaseUrl: string;
  adminBaseUrl: string;
  guard: DepositExecutionGuard;
}): Promise<void> {
  const adminShell = new AdminShellPage(input.adminPage);
  const adminDepositList = new DepositClaimListPage(input.adminPage);
  const clientHome = new HomePage(input.clientPage);

  await runDualSessionPreflight({
    checkAdmin: async () => {
      await adminShell.goto(input.adminBaseUrl);
      await adminShell.expectSessionActive();
      await adminDepositList.goto(input.adminBaseUrl);
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
