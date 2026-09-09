import type { Page } from '@playwright/test';

import { AdminShellPage } from '../../pages/admin/AdminShellPage';
import { WithdrawalListPage } from '../../pages/admin/WithdrawalListPage';
import { HomePage } from '../../pages/client/HomePage';
import { runDualSessionPreflight } from '../flow-engine';
import type { WithdrawalExecutionGuard } from './withdrawal-e2e';

export async function runWithdrawalAuthPreflight(input: {
  clientPage: Page;
  adminPage: Page;
  clientBaseUrl: string;
  adminBaseUrl: string;
  guard: WithdrawalExecutionGuard;
}): Promise<void> {
  const adminShell = new AdminShellPage(input.adminPage);
  const adminWithdrawalList = new WithdrawalListPage(input.adminPage);
  const clientHome = new HomePage(input.clientPage);

  await runDualSessionPreflight({
    checkAdmin: async () => {
      await adminShell.goto(input.adminBaseUrl);
      await adminShell.expectSessionActive();
      await adminWithdrawalList.goto(input.adminBaseUrl);
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
