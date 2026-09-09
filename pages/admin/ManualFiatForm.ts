import { expect, type Page } from '@playwright/test';

/** Shared customer/account controls verified in both manual fiat forms. */
export class ManualFiatForm {
  constructor(readonly page: Page) {}

  combobox(label: string) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return this.page.locator('label').filter({ hasText: new RegExp(`^${escaped}(?:\\s*\\*)?$`) }).locator('..').getByRole('combobox');
  }

  async chooseCustomer(email: string, displayName?: string): Promise<void> {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Manual fiat customer search requires an email.');
    const input = this.page.getByRole('combobox', { name: '选择客户', exact: true });
    await input.fill(email);
    const option = this.page.getByRole('option').filter({ hasText: email });
    await expect(option).toHaveCount(1);
    const text = await option.innerText();
    const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
    if (!emails.some(value => value.toLowerCase() === email.toLowerCase()) || (displayName && !text.includes(displayName))) {
      throw new Error('The unique manual fiat customer option does not match the original Journey.');
    }
    await option.click();
  }

  async openAccountOptions(): Promise<void> {
    const control = this.combobox('选择账户');
    await expect(control).toBeEnabled({ timeout: 20_000 });
    await control.click();
  }

  async chooseAccount(account: string): Promise<void> {
    await this.openAccountOptions();
    const option = this.page.getByRole('option').filter({ hasText: account });
    await expect(option).toHaveCount(1);
    await option.click();
  }
}
