import { type Locator, type Page } from '@playwright/test';

export type ClientPageKey = 'dashboard' | 'account' | 'trading' | 'trust';

export class Navigation {
  readonly page: Page;
  readonly dashboardLink: Locator;
  readonly accountLink: Locator;
  readonly investmentEntry: Locator;
  readonly tradingLink: Locator;
  readonly trustServicesLink: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dashboardLink = page.getByRole('link', { name: '仪表板' });
    this.accountLink = page.getByRole('link', { name: '账户' });
    this.investmentEntry = page.locator('header nav li[aria-haspopup="menu"]').filter({
      hasText: '投资'
    });
    this.tradingLink = page.getByRole('link', { name: '交易' });
    this.trustServicesLink = page.getByRole('link', { name: '信托服务' });
  }

  linkFor(pageKey: ClientPageKey): Locator {
    switch (pageKey) {
      case 'dashboard':
        return this.dashboardLink;
      case 'account':
        return this.accountLink;
      case 'trading':
        return this.tradingLink;
      case 'trust':
        return this.trustServicesLink;
    }
  }

  async open(pageKey: ClientPageKey): Promise<void> {
    await this.linkFor(pageKey).click();
  }
}
