import { expect, type Locator, type Page } from '@playwright/test';

export class AccountTypeSelectionPage {
  readonly personalAccount: Locator;
  readonly corporateAccount: Locator;

  constructor(readonly page: Page) {
    this.personalAccount = page.getByText('个人账户', { exact: true });
    this.corporateAccount = page.getByText('企业账户', { exact: true });
  }

  async expectOpen(): Promise<void> {
    await expect(this.page).toHaveURL(/\/zh-CN\/account-type-selection(?:$|[?#])/);
    await expect(this.personalAccount).toBeVisible();
    await expect(this.corporateAccount).toBeVisible();
  }

  async selectPersonal(): Promise<void> {
    await this.personalAccount.click();
    await this.page.waitForURL(/\/zh-CN\/registration\?type=individual(?:&|$)/);
  }

  async selectCorporate(): Promise<void> {
    await this.corporateAccount.click();
    await this.page.waitForURL(/\/zh-CN\/registration\?type=(?:corporate|company)(?:&|$)/);
  }
}
