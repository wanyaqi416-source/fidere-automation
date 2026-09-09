import { expect, type Page } from '@playwright/test';

export class AdminShellPage {
  constructor(readonly page: Page) {}

  async goto(baseURL: string): Promise<void> {
    const response = await this.page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    expect(response, 'The Admin environment navigation returned no HTTP response.').not.toBeNull();
    expect(
      response!.status(),
      `The Admin environment returned HTTP ${response!.status()}.`
    ).toBeLessThan(400);
  }

  async expectSessionActive(): Promise<void> {
    const expiredMessage =
      'Admin storageState appears missing or expired. Run npm run auth:admin, complete the manual captcha login, and retry.';

    await expect(this.page, expiredMessage).not.toHaveURL(/\/login|\/signin|\/sign-in/i, {
      timeout: 10_000
    });

    await expect(
      this.page.locator(
        'input[type="password"], input[name="password"], input[name="totp"], input[placeholder*="验证码"]'
      ),
      expiredMessage
    ).toHaveCount(0, { timeout: 5_000 });

    await expect(
      this.page
        .getByText(
          /仪表板|工作台|首页|客户管理|用户管理|账户管理|交易管理|订单管理|资金管理|系统管理|Dashboard|Clients|Users|Orders|Transactions/i
        )
        .first(),
      'Admin authenticated page should show a stable dashboard or core menu entry.'
    ).toBeVisible({ timeout: 10_000 });
  }
}
