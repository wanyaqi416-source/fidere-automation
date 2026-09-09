import { expect, type BrowserContext, type Page } from '@playwright/test';

import { LoginPage } from '../../../pages/client/LoginPage';
import { env } from '../../../src/config/env';
import { corporateAuthPath } from '../../../src/registration';

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required to refresh the Corporate Draft session.`);
  return value;
}

export async function ensureCorporateDraftAuthentication(input: {
  page: Page;
  context: BrowserContext;
  email: string;
  returnUrl: string;
}): Promise<boolean> {
  if (!/\/login(?:$|[?#])/.test(input.page.url())) return false;

  const login = new LoginPage(input.page);
  await login.goto(required('CLIENT_BASE_URL', env.client.baseUrl));
  const credentials = {
    username: input.email,
    password: required('CLIENT_PASSWORD', env.client.password),
    otp: required('CLIENT_OTP or CLIENT_REGISTER_OTP', env.client.otp ?? env.personalRegistration.otp)
  };
  await login.fillCredentials(credentials);
  await login.submitCredentials();
  await login.expectOtpStep();
  await login.fillOtp(credentials.otp);
  await login.confirmLoginToAuthenticatedRoute();
  await input.context.storageState({ path: corporateAuthPath });
  await input.page.goto(input.returnUrl, { waitUntil: 'domcontentloaded' });
  return true;
}

export async function refreshCorporateDraftAuthentication(input: {
  page: Page;
  context: BrowserContext;
  email: string;
  returnUrl: string;
}): Promise<void> {
  await input.page.goto(required('CLIENT_BASE_URL', env.client.baseUrl), {
    waitUntil: 'domcontentloaded'
  });
  const login = new LoginPage(input.page);
  await expect
    .poll(
      async () => {
        if (!/\/login(?:$|[?#])/.test(input.page.url())) return 'authenticated';
        if (await login.emailInput.isVisible()) return 'login';
        return 'pending';
      },
      { message: 'Corporate Draft authentication state did not settle.', timeout: 10_000 }
    )
    .not.toBe('pending');
  if (/\/login(?:$|[?#])/.test(input.page.url())) {
    const credentials = {
      username: input.email,
      password: required('CLIENT_PASSWORD', env.client.password),
      otp: required('CLIENT_OTP or CLIENT_REGISTER_OTP', env.client.otp ?? env.personalRegistration.otp)
    };
    await login.fillCredentials(credentials);
    await login.submitCredentials();
    await login.expectOtpStep();
    await login.fillOtp(credentials.otp);
    await login.confirmLoginToAuthenticatedRoute();
  }
  await input.context.storageState({ path: corporateAuthPath });
  await input.page.goto(input.returnUrl, { waitUntil: 'domcontentloaded' });
}
