import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { Browser, BrowserContext, Page } from '@playwright/test';

import { HomePage, clientRouteUrl } from '../../pages/client/HomePage';
import { LoginPage } from '../../pages/client/LoginPage';

export type PersonalJourneyClientSession = {
  context: BrowserContext;
  page: Page;
  authStatePath: string;
};

export function personalJourneyAuthStatePath(runId: string): string {
  if (!/^[A-Z0-9._-]+$/i.test(runId)) {
    throw new Error('Personal Journey runId contains unsupported characters.');
  }
  return resolve('auth', 'journeys', `${runId}.json`);
}

async function dashboardIsReady(page: Page): Promise<boolean> {
  return page.getByText('总资产', { exact: true }).isVisible({ timeout: 5_000 }).catch(() => false);
}

export async function openPersonalJourneyClientSession(input: {
  browser: Browser;
  baseURL: string;
  runId: string;
  email: string;
  password: string;
  otp: string;
  forceFreshLogin?: boolean;
}): Promise<PersonalJourneyClientSession> {
  const authStatePath = personalJourneyAuthStatePath(input.runId);
  if (!input.forceFreshLogin && existsSync(authStatePath)) {
    const context = await input.browser.newContext({
      baseURL: input.baseURL,
      storageState: authStatePath
    });
    const page = await context.newPage();
    await page.goto(clientRouteUrl(input.baseURL, 'dashboard'), { waitUntil: 'domcontentloaded' });
    if (!/\/login(?:$|[?#])/.test(new URL(page.url()).pathname) && await dashboardIsReady(page)) {
      return { context, page, authStatePath };
    }
    await context.close();
  }

  const context = await input.browser.newContext({
    baseURL: input.baseURL,
    storageState: { cookies: [], origins: [] }
  });
  const page = await context.newPage();
  try {
    const login = new LoginPage(page);
    await login.goto(clientRouteUrl(input.baseURL, 'login'));
    await login.fillCredentials({ username: input.email, password: input.password });
    await login.submitCredentials();
    await login.expectOtpStep();
    await login.fillOtp(input.otp);
    await login.confirmLoginToAuthenticatedRoute();

    const home = new HomePage(page);
    await home.gotoDashboard(input.baseURL);
    await home.expectDashboardLoaded();
    mkdirSync(dirname(authStatePath), { recursive: true });
    await context.storageState({ path: authStatePath });
    return { context, page, authStatePath };
  } catch (error) {
    await context.close();
    throw error;
  }
}
