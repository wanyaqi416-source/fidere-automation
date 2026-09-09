import { expect, type Locator, type Page } from '@playwright/test';

type ClientLoginCredentials = {
  username: string;
  password: string;
  otp: string;
};

export class LoginPage {
  readonly page: Page;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly loginButton: Locator;
  readonly otpInput: Locator;
  readonly confirmLoginButton: Locator;
  readonly dashboardLink: Locator;
  readonly totalAssetsText: Locator;

  constructor(page: Page) {
    this.page = page;
    this.emailInput = page.getByPlaceholder('账号 / 邮箱');
    this.passwordInput = page.getByPlaceholder('••••••••');
    this.loginButton = page.getByRole('button', { name: '登录' });
    this.otpInput = page.getByPlaceholder('请输入6位邮箱验证码');
    this.confirmLoginButton = page.getByRole('button', { name: '确认登录' });
    this.dashboardLink = page.getByRole('link', { name: '仪表板' });
    this.totalAssetsText = page.getByText('总资产', { exact: true });
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await expect(this.emailInput).toBeVisible();
  }

  async login(credentials: ClientLoginCredentials): Promise<void> {
    await this.fillCredentials(credentials);
    await this.submitCredentials();
    await this.expectOtpStep();
    await this.fillOtp(credentials.otp);
    await this.confirmLogin();
  }

  async fillCredentials(credentials: Pick<ClientLoginCredentials, 'username' | 'password'>): Promise<void> {
    await this.emailInput.fill(credentials.username);
    await this.passwordInput.fill(credentials.password);
  }

  async submitCredentials(): Promise<void> {
    await this.loginButton.click();
  }

  async expectOtpStep(): Promise<void> {
    await expect(this.otpInput).toBeVisible();
  }

  async fillOtp(otp: string): Promise<void> {
    await this.otpInput.fill(otp);
  }

  async confirmLogin(): Promise<void> {
    await Promise.all([
      this.page.waitForURL(/\/dashboard(?:$|[?#])/, { timeout: 30_000 }),
      this.confirmLoginButton.click()
    ]);
  }

  async confirmLoginToAuthenticatedRoute(): Promise<void> {
    await Promise.all([
      this.page.waitForURL(
        url => /\/zh-CN\/(?:dashboard|account-type-selection|registration|sign-success)(?:$|[?#])/.test(
          url.toString()
        ),
        { timeout: 30_000 }
      ),
      this.confirmLoginButton.click()
    ]);
    await expect(this.page).not.toHaveURL(/\/login(?:$|[?#])/);
  }

  async expectLoggedIn(): Promise<void> {
    await expect(this.page).toHaveURL(/\/dashboard(?:$|[?#])/);
    await expect(this.page).toHaveTitle(/Fidere Trust \| Dashboard/);
    await expect(this.dashboardLink).toBeVisible();
    await expect(this.totalAssetsText).toBeVisible();
  }
}
