import {
  expect,
  test as base,
  type BrowserContext,
  type Page
} from '@playwright/test';
import {
  authStatePaths,
  existingAuthState,
  requireExistingAuthState
} from '../src/config/auth';
import { env } from '../src/config/env';
import { createBusinessReportContext } from '../src/reporting/business-report.fixture';
import type { BusinessReportApi } from '../src/reporting/business-report.types';

type WorkflowFixtures = {
  clientContext: BrowserContext;
  adminContext: BrowserContext;
  clientPage: Page;
  adminPage: Page;
  business: BusinessReportApi;
};

function requireBaseUrl(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is required for Client/Admin workflow tests.`);
  }

  return value;
}

export const test = base.extend<WorkflowFixtures>({
  clientContext: async ({ browser }, use, testInfo) => {
    const clientAuthState =
      testInfo.project.name === 'opening-workflows'
        ? authStatePaths.openingClient
        : authStatePaths.client;
    const context = await browser.newContext({
      baseURL: requireBaseUrl('CLIENT_BASE_URL', env.client.baseUrl),
      storageState: existingAuthState(clientAuthState)
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

  clientPage: async ({ clientContext }, use) => {
    await use(await clientContext.newPage());
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
