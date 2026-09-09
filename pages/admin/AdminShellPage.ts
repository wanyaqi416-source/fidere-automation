import { expect, type Page, type Response } from '@playwright/test';

export type AdminSessionStatus = 'valid' | 'expired' | 'unavailable';

export class AdminShellPage {
  constructor(readonly page: Page) {}

  async inspectAuthentication(baseURL: string, timeout = 15_000): Promise<AdminSessionStatus> {
    const origin = new URL(baseURL).origin;
    let listStatus: number | undefined;
    let status: AdminSessionStatus | 'loading' = 'loading';
    const observe = (response: Response) => {
      const url = new URL(response.url());
      if (url.origin === origin && url.pathname.endsWith('/member/walletWhitelist/list')) {
        listStatus = response.status();
      }
    };
    const readStatus = async (): Promise<AdminSessionStatus | 'loading'> => {
      if (/\/(login|signin|sign-in)/i.test(new URL(this.page.url()).pathname) || listStatus === 401) return 'expired';
      if (await this.page.locator('input[type="password"]').isVisible()) return 'expired';
      if (listStatus !== undefined && listStatus >= 400) return 'unavailable';
      if (listStatus !== undefined && listStatus >= 200 && listStatus < 300 &&
          await this.page.getByRole('columnheader', { name: '白名单ID', exact: true }).isVisible()) return 'valid';
      return 'loading';
    };
    this.page.on('response', observe);
    try {
      // A protected business page catches stale sessions that still render a cached shell/menu.
      const response = await this.page.goto(new URL('/zh-CN/kyc/whitelists', baseURL).toString(), { waitUntil: 'domcontentloaded', timeout });
      if (response && response.status() >= 400) return response.status() === 401 ? 'expired' : 'unavailable';
      await expect.poll(async () => { status = await readStatus(); return status; }, { timeout }).not.toBe('loading');
      return status as AdminSessionStatus;
    } catch {
      return /\/(login|signin|sign-in)/i.test(new URL(this.page.url()).pathname) ? 'expired' : 'unavailable';
    } finally {
      this.page.off('response', observe);
    }
  }

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
