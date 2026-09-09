import { expect, test as base, type Page } from '@playwright/test';
import { AdminShellPage } from '../pages/admin/AdminShellPage';
import { authStatePaths, requireExistingAuthState } from '../src/config/auth';
import { env } from '../src/config/env';

type AdminAccount = {
  username: string;
  password: string;
};

type AdminFixtures = {
  adminAccount: AdminAccount;
  adminAuthState: void;
};

export const test = base.extend<AdminFixtures>({
  adminAuthState: [
    async ({}, use) => {
      requireExistingAuthState(authStatePaths.admin, {
        systemName: 'Admin',
        refreshCommand: 'npm run auth:admin'
      });

      await use(undefined);
    },
    { auto: true }
  ],

  adminAccount: async ({}, use) => {
    const { username, password } = env.admin;

    if (!username || !password) {
      throw new Error(
        'ADMIN_USERNAME and ADMIN_PASSWORD are required for authenticated Admin tests.'
      );
    }

    await use({ username, password });
  }
});

export async function expectAdminSessionActive(page: Page): Promise<void> {
  await new AdminShellPage(page).expectSessionActive();
}

export { expect };
