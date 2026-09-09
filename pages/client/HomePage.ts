import { expect, type Locator, type Page } from '@playwright/test';

export function clientRouteUrl(baseURL: string, route: string): string {
  const url = new URL(baseURL);
  const [locale = 'zh-CN'] = url.pathname.split('/').filter(Boolean);

  url.pathname = `/${locale}/${route}`;
  url.search = '';
  url.hash = '';

  return url.toString();
}

export class HomePage {
  readonly page: Page;
  readonly main: Locator;
  readonly totalAssets: Locator;
  readonly recentTransactions: Locator;
  readonly portfolioHeading: Locator;
  readonly assetAllocationHeading: Locator;
  readonly authExpiredMessage: Locator;
  readonly systemErrorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.main = page.locator('main');
    this.totalAssets = page.getByText('总资产', { exact: true });
    this.recentTransactions = page.getByText('最近交易');
    this.portfolioHeading = page.getByRole('heading', { name: '我的投资组合' });
    this.assetAllocationHeading = page.getByRole('heading', { name: '资产配置' });
    this.authExpiredMessage = page.getByText(/登录已失效|登录过期|请重新登录/);
    this.systemErrorMessage = page.getByText(
      /Application error|Something went wrong|Internal Server Error|系统错误/
    );
  }

  async gotoDashboard(baseURL: string): Promise<void> {
    await this.page.goto(clientRouteUrl(baseURL, 'dashboard'), {
      waitUntil: 'domcontentloaded'
    });
  }

  async expectDashboardLoaded(): Promise<void> {
    await expect(this.page).toHaveURL(/\/dashboard(?:$|[?#])/);
    await expect(this.page).toHaveTitle(/Fidere Trust \| Dashboard/);
    await expect(this.main).toBeVisible();
    await expect(this.totalAssets).toBeVisible();
  }

  async expectNoLoginRedirect(): Promise<void> {
    await expect(this.page).not.toHaveURL(/\/login(?:$|[?#])/);
  }

  async expectNoObviousError(): Promise<void> {
    await expect(this.authExpiredMessage).not.toBeVisible();
    await expect(this.systemErrorMessage).not.toBeVisible();
  }
}
