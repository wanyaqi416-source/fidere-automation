import {
  expect,
  test as base,
  type BrowserContext,
  type Page
} from '@playwright/test';

import { authStatePaths, requireExistingAuthState } from '../src/config/auth';
import { env } from '../src/config/env';
import { createBusinessReportContext } from '../src/reporting/business-report.fixture';
import type { BusinessReportApi } from '../src/reporting/business-report.types';

type RegistrationFixtures = {
  registrationContext: BrowserContext;
  adminContext: BrowserContext;
  registrationPage: Page;
  adminPage: Page;
  business: BusinessReportApi;
};

function requireBaseUrl(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for personal registration tests.`);
  return value;
}

export const test = base.extend<RegistrationFixtures>({
  registrationContext: async ({ browser }, use) => {
    const context = await browser.newContext({
      baseURL: requireBaseUrl('CLIENT_BASE_URL', env.client.baseUrl),
      storageState: { cookies: [], origins: [] }
    });
    await use(context);
    await context.close();
  },

  adminContext: async ({ browser }, use) => {
    const context = await browser.newContext({
      baseURL: requireBaseUrl('ADMIN_BASE_URL', env.admin.baseUrl),
      storageState: requireExistingAuthState(authStatePaths.admin, {
        systemName: 'Admin',
        refreshCommand: 'npm run auth:admin'
      })
    });
    await use(context);
    await context.close();
  },

  registrationPage: async ({ registrationContext }, use) => {
    await use(await registrationContext.newPage());
  },

  adminPage: async ({ adminContext }, use) => {
    await use(await adminContext.newPage());
  },

  business: async ({}, use, testInfo) => {
    const business = createBusinessReportContext(testInfo);
    try {
      await use(business);
    } finally {
      await business.finalize();
    }
  }
});

export { expect };
