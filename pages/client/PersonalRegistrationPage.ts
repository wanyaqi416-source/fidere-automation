import { expect, type Locator, type Page } from '@playwright/test';

export class PersonalRegistrationPage {
  readonly emailInput: Locator;
  readonly verificationCodeInput: Locator;
  readonly requestCodeButton: Locator;
  readonly nextButton: Locator;
  readonly passwordInput: Locator;
  readonly confirmPasswordInput: Locator;
  readonly registerButton: Locator;

  constructor(readonly page: Page) {
    this.emailInput = page.getByPlaceholder('输入您的电子邮件地址');
    this.verificationCodeInput = page.getByPlaceholder('请输入验证码');
    this.requestCodeButton = page.getByRole('button', { name: '获取验证码', exact: true });
    this.nextButton = page.getByRole('button', { name: '下一步', exact: true });
    this.passwordInput = page.locator('input[name="password"]');
    this.confirmPasswordInput = page.locator('input[name="confirmPassword"]');
    this.registerButton = page.getByRole('button', { name: /^注册$|^Register$/ });
  }

  async goto(baseURL: string): Promise<void> {
    await this.page.goto(new URL('/zh-CN/register', baseURL).toString(), {
      waitUntil: 'domcontentloaded'
    });
    await expect(this.page).toHaveURL(/\/zh-CN\/register(?:$|[?#])/);
    await expect(this.emailInput).toBeVisible();
    await expect(this.verificationCodeInput).toBeVisible();
  }

  async fillEmail(email: string): Promise<void> {
    await this.emailInput.fill(email);
    await expect(this.emailInput).toHaveValue(email);
  }

  async requestVerificationCode(): Promise<void> {
    await expect(this.requestCodeButton).toBeEnabled();
    await this.requestCodeButton.click();
    await expect(
      this.page.getByText(/验证码已发送|verification code.*sent/i).first()
    ).toBeVisible({ timeout: 15_000 });
  }

  async verifyEmail(otp: string): Promise<void> {
    await this.verificationCodeInput.fill(otp);
    await expect(this.verificationCodeInput).toHaveValue(otp);
    await this.nextButton.click();
    await expect.poll(async () => ({
      passwordVisible: await this.passwordInput.isVisible(),
      invalidOtpVisible: await this.page
        .getByText(/验证码无效或已过期|invalid.*verification code|verification code.*expired/i)
        .isVisible()
    }), {
      timeout: 15_000,
      intervals: [200, 400, 750, 1_000],
      message: 'Registration OTP did not advance to the password form.'
    }).toEqual({ passwordVisible: true, invalidOtpVisible: false });
    await expect(this.confirmPasswordInput).toBeVisible();
  }

  async fillPassword(password: string): Promise<void> {
    await this.passwordInput.fill(password);
    await this.confirmPasswordInput.fill(password);
  }

  async acceptVisibleAgreements(): Promise<number> {
    const checkboxes = this.page.getByRole('checkbox');
    const count = await checkboxes.count();
    for (let index = 0; index < count; index += 1) {
      const checkbox = checkboxes.nth(index);
      if (await checkbox.isVisible() && !(await checkbox.isChecked())) {
        await checkbox.check();
      }
    }
    return count;
  }

  async submitRegistration(): Promise<void> {
    await expect(this.registerButton).toBeEnabled();
    await this.registerButton.click();
  }

  async expectAuthenticatedOnboarding(): Promise<void> {
    await this.page.waitForURL(
      url => /\/zh-CN\/(?:account-type-selection|registration|dashboard|sign-success)(?:$|[?#])/.test(url.toString()),
      { timeout: 30_000 }
    );
    await expect(this.page).not.toHaveURL(/\/login(?:$|[?#])/);
  }
}
