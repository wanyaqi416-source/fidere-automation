import { expect, type Page } from '@playwright/test';

export type UsAccountTypeConfiguration = {
  accountType: '美国账户';
  channel: 'interlace';
  enabled: boolean;
  currency: string;
};

export class AccountTypeConfigurationPage {
  constructor(readonly page: Page) {}

  async goto(baseURL: string): Promise<void> {
    await this.page.goto(
      new URL('/zh-CN/operation/account-type-configuration', baseURL).toString(),
      { waitUntil: 'domcontentloaded' }
    );
    await expect(this.page).toHaveURL(/\/operation\/account-type-configuration/);
  }

  async readUsConfiguration(): Promise<UsAccountTypeConfiguration> {
    const row = this.page.locator('tbody tr').filter({ hasText: '美国账户' });
    await expect(row).toHaveCount(1, { timeout: 20_000 });
    const text = (await row.innerText()).replace(/\s+/g, ' ').trim();
    if (!/interlace/i.test(text)) {
      throw new Error('US Account configuration is not using the Interlace channel.');
    }
    const status = text.match(/启用|停用|正常|禁用/)?.[0];
    return {
      accountType: '美国账户',
      channel: 'interlace',
      enabled: status === '启用' || status === '正常',
      currency: text.match(/USD|美元/)?.[0] ?? '页面未提供'
    };
  }
}
