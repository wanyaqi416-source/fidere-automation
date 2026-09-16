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

  let activePage = input.clientPage;
  let activeSystem = 'Client';
  try {
    // Open the read-only Client page immediately instead of leaving a headed window blank during Admin checks.
    await clientHome.gotoDashboard(input.clientBaseUrl);
    await runDualSessionPreflight({
      checkAdmin: async () => {
        activePage = input.adminPage;
        activeSystem = 'Admin';
        await adminShell.goto(input.adminBaseUrl);
        await adminShell.expectSessionActive();
        await adminDepositList.goto(input.adminBaseUrl);
      },
      checkClient: async () => {
        activePage = input.clientPage;
        activeSystem = 'Client';
        await clientHome.expectNoLoginRedirect();
        await clientHome.expectDashboardLoaded();
        await clientHome.expectNoObviousError();
      },
      markReady: (clientReady, adminReady) =>
        input.guard.markAuthenticationReady(clientReady, adminReady)
    });
  } catch (error) {
    if (activePage.isClosed()) {
      throw new Error(
        `${activeSystem} 浏览器窗口在入金认证预检期间已关闭，请保留自动化打开的窗口。` +
        '本次预检没有提交或处理入金，也未自动重建窗口或重跑原申请。',
        { cause: error }
      );
    }
    throw error;
  }
}
