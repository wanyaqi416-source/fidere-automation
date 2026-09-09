import type { Page } from '@playwright/test';

import { AdminShellPage } from '../../pages/admin/AdminShellPage';
import { TransferListPage } from '../../pages/admin/TransferListPage';
import { HomePage } from '../../pages/client/HomePage';
import { runDualSessionPreflight } from '../flow-engine';
import { TransferExecutionGuard } from './transfer-e2e';

export type TransferAuthPreflightInput = {
  clientPage: Page;
  adminPage: Page;
  clientBaseUrl: string;
  adminBaseUrl: string;
  guard: TransferExecutionGuard;
};

export async function runTransferAuthPreflight(
  input: TransferAuthPreflightInput
): Promise<void> {
  const adminShell = new AdminShellPage(input.adminPage);
  const adminTransferList = new TransferListPage(input.adminPage);
  const clientHome = new HomePage(input.clientPage);

  await runDualSessionPreflight({
    checkAdmin: async () => {
      await adminShell.goto(input.adminBaseUrl);
      await adminShell.expectSessionActive();
      await adminTransferList.goto(input.adminBaseUrl);
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
