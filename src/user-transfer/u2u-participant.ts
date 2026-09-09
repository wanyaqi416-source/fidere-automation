import { expect, type Browser, type Page } from '@playwright/test';
import { LoginPage } from '../../pages/client/LoginPage';
import { AccountDetailPage } from '../../pages/client/AccountDetailPage';
import { env } from '../config/env';
import { assertSandboxEnvironment } from '../flow-engine/mutation-guard';
import { decodeClientKycStatus } from '../registration/registration-kyc-contract';

export async function verifyU2uIdentity(page: Page, baseURL: string, email: string) {
  assertSandboxEnvironment(baseURL);
  const response = await page.request.get(new URL('/server/auth/session', baseURL).toString());
  expect(response.ok(), 'Participant session readable').toBe(true);
  const data = await response.json();
  expect(data.user?.email?.toLowerCase() === email.toLowerCase(), 'Participant identity matches config').toBe(true);
  expect(['1', '2']).toContain(String(data.entityType));
  const accountType = String(data.entityType) === '2' ? 'BUSINESS' : 'PERSONAL';
  expect(decodeClientKycStatus(data, { accountType, email }).approved, 'Participant KYC/KYB approved').toBe(true);
  return accountType;
}

export async function loginU2uParticipant(browser: Browser, baseURL: string, email: string) {
  assertSandboxEnvironment(baseURL);
  if (!env.client.password || !env.client.otp) throw new Error('Client login credentials must be configured.');
  if (email !== env.client.username && process.env.U2U_RECIPIENT_USE_CLIENT_CREDENTIALS !== 'true') {
    throw new Error('Recipient credential reuse must be explicitly configured.');
  }
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    const login = new LoginPage(page);
    await login.goto(baseURL);
    await login.login({ username: email, password: env.client.password, otp: env.client.otp });
    await login.expectLoggedIn();
    const accountType = await verifyU2uIdentity(page, baseURL, email);
    return { context, page, accountType };
  } catch {
    // Never propagate login call logs containing filled credentials.
    await context.close();
    throw new Error('U2U participant clean login or approved account check failed; no money action attempted here.');
  }
}

export async function readU2uBalance(page: Page, baseURL: string, accountType: string, currency: string) {
  const accounts = new AccountDetailPage(page);
  await accounts.goto(baseURL);
  return (await accounts.readAvailableBalance(accountType, currency)).availableBalance.toFixed();
}
