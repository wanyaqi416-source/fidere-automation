import { mkdir } from 'node:fs/promises';
import { dirname, relative } from 'node:path';

import { chromium, devices, type Locator, type Page } from 'playwright';

import { authStatePaths } from '../src/config/auth';
import { env } from '../src/config/env';

const DEFAULT_AUTH_TIMEOUT_MS = 10 * 60 * 1000;

function requireEnvValue(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is required. Set it in .env before running npm run auth:admin.`);
  }

  return value;
}

function readPositiveTimeout(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number of milliseconds.`);
  }

  return value;
}

function relativePath(path: string): string {
  return relative(process.cwd(), path).replace(/\\/g, '/');
}

async function fillFirstVisible(
  candidates: Locator[],
  value: string,
  fieldName: string
): Promise<void> {
  for (const candidate of candidates) {
    const locator = candidate.first();

    try {
      await locator.waitFor({ state: 'visible', timeout: 3000 });
      await locator.fill(value);
      return;
    } catch {
      // Try the next stable locator candidate.
    }
  }

  throw new Error(`Could not locate a visible Admin ${fieldName} field on the login page.`);
}

type AdminSuccessSignals = {
  emailOtpChallengeVisible: boolean;
  hasCoreMenu: boolean;
  stillOnLoginForm: boolean;
  titleLooksAuthenticated: boolean;
  urlLooksAuthenticated: boolean;
};

type AdminAuthProgress = 'success' | 'emailOtp';

function readAdminSuccessSignalsInPage(): AdminSuccessSignals {
  const bodyText = document.body?.innerText ?? '';
  const title = document.title ?? '';
  const path = window.location.pathname.toLowerCase();
  const href = window.location.href;

  const loginPathVisible = /\/login|\/signin|\/sign-in/.test(path);
  const passwordInputVisible = Boolean(
    document.querySelector('input[type="password"], input[name="password"]')
  );
  const captchaInputVisible = Boolean(
    document.querySelector('input[name="totp"], input[placeholder*="验证码"]')
  );
  const loginButtonVisible = Array.from(document.querySelectorAll('button')).some(button =>
    /登录|login/i.test((button.textContent ?? '').trim())
  );
  const stillOnLoginForm =
    loginPathVisible || (passwordInputVisible && captchaInputVisible && loginButtonVisible);

  const emailOtpTextVisible =
    /邮箱验证码|邮件验证码|邮箱.*验证码|邮件.*验证码|6位.*验证码|重新发送|返回账号登录|email.*(?:code|verification)|verification.*(?:email|code)|resend|back to.*login/i.test(
      bodyText
    );
  const emailOtpInputVisible = Boolean(
    document.querySelector(
      'input[name="otp"], input[name="code"], input[name="emailCode"], input[name="email_code"], input[name="verificationCode"]'
    )
  );
  const emailOtpChallengeVisible =
    emailOtpTextVisible && (emailOtpInputVisible || !passwordInputVisible);

  const hasCoreMenu = /仪表板|工作台|首页|客户管理|用户管理|账户管理|交易管理|订单管理|资金管理|系统管理|Dashboard|Clients|Users|Orders|Transactions/i.test(
    bodyText
  );
  const urlLooksAuthenticated = !loginPathVisible && !/login|signin|sign-in/i.test(href);
  const titleLooksAuthenticated = Boolean(title) && !/login|登录/i.test(title);

  return {
    emailOtpChallengeVisible,
    hasCoreMenu,
    stillOnLoginForm,
    titleLooksAuthenticated,
    urlLooksAuthenticated
  };
}

async function waitForAdminLoginSuccess(page: Page, timeout: number): Promise<string[]> {
  await page.waitForFunction(
    () => {
      const bodyText = document.body?.innerText ?? '';
      const title = document.title ?? '';
      const path = window.location.pathname.toLowerCase();
      const href = window.location.href;

      const loginPathVisible = /\/login|\/signin|\/sign-in/.test(path);
      const passwordInputVisible = Boolean(
        document.querySelector('input[type="password"], input[name="password"]')
      );
      const captchaInputVisible = Boolean(
        document.querySelector('input[name="totp"], input[placeholder*="验证码"]')
      );
      const loginButtonVisible = Array.from(document.querySelectorAll('button')).some(button =>
        /登录|login/i.test((button.textContent ?? '').trim())
      );
      const stillOnLoginForm =
        loginPathVisible || (passwordInputVisible && captchaInputVisible && loginButtonVisible);

      const emailOtpTextVisible =
        /邮箱验证码|邮件验证码|邮箱.*验证码|邮件.*验证码|6位.*验证码|重新发送|返回账号登录|email.*(?:code|verification)|verification.*(?:email|code)|resend|back to.*login/i.test(
          bodyText
        );
      const emailOtpInputVisible = Boolean(
        document.querySelector(
          'input[name="otp"], input[name="code"], input[name="emailCode"], input[name="email_code"], input[name="verificationCode"]'
        )
      );
      const emailOtpChallengeVisible =
        emailOtpTextVisible && (emailOtpInputVisible || !passwordInputVisible);

      const hasCoreMenu = /仪表板|工作台|首页|客户管理|用户管理|账户管理|交易管理|订单管理|资金管理|系统管理|Dashboard|Clients|Users|Orders|Transactions/i.test(
        bodyText
      );
      const urlLooksAuthenticated = !loginPathVisible && !/login|signin|sign-in/i.test(href);
      const titleLooksAuthenticated = Boolean(title) && !/login|登录/i.test(title);

      return (
        !stillOnLoginForm &&
        !emailOtpChallengeVisible &&
        (hasCoreMenu || (urlLooksAuthenticated && titleLooksAuthenticated))
      );
    },
    undefined,
    { timeout, polling: 1000 }
  );

  const signals = await page.evaluate(readAdminSuccessSignalsInPage);
  const matchedSignals: string[] = [];

  if (signals.hasCoreMenu) {
    matchedSignals.push('core menu text');
  }

  if (signals.urlLooksAuthenticated) {
    matchedSignals.push('authenticated URL');
  }

  if (signals.titleLooksAuthenticated) {
    matchedSignals.push('authenticated page title');
  }

  return matchedSignals;
}

async function waitForAdminAuthProgress(page: Page, timeout: number): Promise<AdminAuthProgress> {
  const result = await page.waitForFunction(
    () => {
      const bodyText = document.body?.innerText ?? '';
      const title = document.title ?? '';
      const path = window.location.pathname.toLowerCase();
      const href = window.location.href;

      const loginPathVisible = /\/login|\/signin|\/sign-in/.test(path);
      const passwordInputVisible = Boolean(
        document.querySelector('input[type="password"], input[name="password"]')
      );
      const captchaInputVisible = Boolean(
        document.querySelector('input[name="totp"], input[placeholder*="验证码"]')
      );
      const loginButtonVisible = Array.from(document.querySelectorAll('button')).some(button =>
        /登录|login/i.test((button.textContent ?? '').trim())
      );
      const stillOnLoginForm =
        loginPathVisible || (passwordInputVisible && captchaInputVisible && loginButtonVisible);

      const emailOtpTextVisible =
        /邮箱验证码|邮件验证码|邮箱.*验证码|邮件.*验证码|6位.*验证码|重新发送|返回账号登录|email.*(?:code|verification)|verification.*(?:email|code)|resend|back to.*login/i.test(
          bodyText
        );
      const emailOtpInputVisible = Boolean(
        document.querySelector(
          'input[name="otp"], input[name="code"], input[name="emailCode"], input[name="email_code"], input[name="verificationCode"]'
        )
      );
      const emailOtpChallengeVisible =
        emailOtpTextVisible && (emailOtpInputVisible || !passwordInputVisible);

      const hasCoreMenu = /仪表板|工作台|首页|客户管理|用户管理|账户管理|交易管理|订单管理|资金管理|系统管理|Dashboard|Clients|Users|Orders|Transactions/i.test(
        bodyText
      );
      const urlLooksAuthenticated = !loginPathVisible && !/login|signin|sign-in/i.test(href);
      const titleLooksAuthenticated = Boolean(title) && !/login|登录/i.test(title);
      const authenticated =
        !stillOnLoginForm &&
        !emailOtpChallengeVisible &&
        (hasCoreMenu || (urlLooksAuthenticated && titleLooksAuthenticated));

      if (emailOtpChallengeVisible) {
        return 'emailOtp';
      }

      if (authenticated) {
        return 'success';
      }

      return false;
    },
    undefined,
    { timeout, polling: 1000 }
  );

  const value = await result.jsonValue();

  if (value !== 'success' && value !== 'emailOtp') {
    throw new Error('Unexpected Admin authentication progress state.');
  }

  return value;
}

async function fillAndSubmitEmailOtp(page: Page, otp: string): Promise<void> {
  await fillFirstVisible(
    [
      page.getByLabel(/邮箱验证码|邮件验证码|验证码/),
      page.getByPlaceholder(/请输入.*验证码|邮箱验证码|邮件验证码|6位/),
      page.locator(
        'input[name="otp"], input[name="code"], input[name="emailCode"], input[name="totp"], input[placeholder*="验证码"]'
      ),
      page.getByRole('textbox')
    ],
    otp,
    'email verification code'
  );
}

async function main(): Promise<void> {
  const adminBaseUrl = requireEnvValue('ADMIN_BASE_URL', env.admin.baseUrl);
  const adminUsername = requireEnvValue('ADMIN_USERNAME', env.admin.username);
  const adminPassword = requireEnvValue('ADMIN_PASSWORD', env.admin.password);
  const adminEmailOtp = requireEnvValue('ADMIN_OTP', env.admin.otp);
  const authTimeoutMs = readPositiveTimeout('ADMIN_AUTH_TIMEOUT_MS', DEFAULT_AUTH_TIMEOUT_MS);

  const browser = await chromium.launch({
    headless: false
  });

  const context = await browser.newContext({
    ...devices['Desktop Chrome'],
    baseURL: adminBaseUrl
  });

  const page = await context.newPage();

  try {
    console.log('Opening Admin login page in headed Chromium...');
    await page.goto(adminBaseUrl, { waitUntil: 'domcontentloaded' });

    await fillFirstVisible(
      [
        page.getByLabel('账号', { exact: true }),
        page.locator('input[name="email"]'),
        page.locator('input[type="email"]')
      ],
      adminUsername,
      'username'
    );

    await fillFirstVisible(
      [
        page.getByLabel('密码', { exact: true }),
        page.locator('#login-password'),
        page.locator('input[name="password"]'),
        page.locator('input[type="password"]')
      ],
      adminPassword,
      'password'
    );

    const captchaInput = page.locator('input[name="totp"], input[placeholder*="验证码"]').first();
    await captchaInput.focus().catch(() => undefined);

    console.log('Username and password have been filled.');
    console.log('Please enter the image captcha manually in the browser and click 登录.');
    console.log('Waiting for a real Admin authenticated page before saving storageState...');

    const firstProgress = await waitForAdminAuthProgress(page, authTimeoutMs);

    if (firstProgress === 'emailOtp') {
      console.log('Admin email verification step detected; filling the configured test code.');
      await fillAndSubmitEmailOtp(page, adminEmailOtp);
    }

    const signals = await waitForAdminLoginSuccess(page, authTimeoutMs);

    await mkdir(dirname(authStatePaths.admin), { recursive: true });
    const storageState = await context.storageState({
      path: authStatePaths.admin
    });

    if (storageState.cookies.length === 0 && storageState.origins.length === 0) {
      throw new Error('Admin login was detected, but no browser storage state was produced.');
    }

    console.log(`Admin login detected by: ${signals.join(', ') || 'authenticated page state'}.`);
    console.log(`Admin storageState saved to ${relativePath(authStatePaths.admin)}.`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
