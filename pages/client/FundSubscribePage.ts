import { expect, type Locator, type Page } from '@playwright/test';
import { SecurityKeyDialog } from './SecurityKeyDialog';

export type FundPaymentAccount = {
  accountType: string;
  currency: string;
  balance: string;
};

export type FundSubscriptionSnapshot = {
  productName: string;
  amount: string;
  currency: string;
  paymentAccount: string;
  feeRate: string;
  feeAmount: string;
  totalAmount: string;
  termsAccepted: boolean;
  submitEnabled: boolean;
};

export class FundSubscribePage {
  private submitClicks = 0;

  constructor(readonly page: Page) {}

  async expectLoaded(): Promise<void> {
    await expect(this.page).toHaveURL(/\/investment\/trading\/funds\/subscribe\?id=/);
    await expect(this.confirmButton).toBeVisible({ timeout: 20_000 });
    await expect(this.page.getByText('选择投资金额', { exact: true })).toBeVisible();
  }

  async readPaymentAccounts(): Promise<FundPaymentAccount[]> {
    const radios = this.page.getByRole('radio');
    const accounts: FundPaymentAccount[] = [];
    for (let index = 0; index < await radios.count(); index += 1) {
      const radio = radios.nth(index);
      const accountText = await radio.getAttribute('aria-label') ??
        await radio.evaluate(element => {
          let current = element.parentElement;
          while (current) {
            const text = (current.innerText ?? '').replace(/\s+/g, ' ').trim();
            const radioCount = current.querySelectorAll('input[type="radio"], [role="radio"]').length;
            if (radioCount === 1 && /余额:\s*[A-Z]{3}\s*[\d,.]+/.test(text)) return text;
            current = current.parentElement;
          }
          return '';
        });
      const match = accountText.match(/(.+账户)\s+余额:\s*([A-Z]{3})\s*([\d,.]+)/);
      if (match) {
        accounts.push({
          accountType: match[1].trim(),
          currency: match[2],
          balance: match[3].replace(/,/g, '')
        });
      }
    }
    return accounts;
  }

  async fillAmount(amount: string): Promise<void> {
    await this.amountInput.fill(amount);
    await this.amountInput.blur();
  }

  async selectPaymentAccount(accountType: string): Promise<void> {
    const radio = this.page.getByRole('radio', { name: new RegExp(accountType) });
    await radio.check();
    await expect(radio).toBeChecked();
  }

  async acceptTerms(): Promise<void> {
    await this.termsCheckbox.check();
    await expect(this.termsCheckbox).toBeChecked();
  }

  async clearTerms(): Promise<void> {
    await this.termsCheckbox.uncheck();
  }

  async submitEnabled(): Promise<boolean> {
    return this.confirmButton.isEnabled();
  }

  async readSnapshot(): Promise<FundSubscriptionSnapshot> {
    const text = (await this.page.locator('main').innerText()).replace(/\u00a0/g, ' ');
    const productName = text.match(/产品名称\s*([^\r\n]+)/)?.[1]?.trim();
    const amount = text.match(/投资金额\s*\$?\s*([\d,.]+)\s*([A-Z]{3})/) ??
      text.match(/共\s*\$?\s*([\d,.]+)\s*([A-Z]{3})/);
    const paymentAccount = text.match(/付款账户\s*([^\r\n]+)/)?.[1]?.trim();
    const fee = text.match(/手续费\(([^)]+)\)\s*\$?\s*([\d,.]+)\s*([A-Z]{3})/);
    const total = text.match(/共\s*\$?\s*([\d,.]+)\s*([A-Z]{3})/);
    if (!productName || !amount || !paymentAccount || !fee || !total) {
      throw new Error('Fund subscription confirmation summary could not be parsed.');
    }
    return {
      productName,
      amount: amount[1].replace(/,/g, ''),
      currency: amount[2],
      paymentAccount,
      feeRate: fee[1],
      feeAmount: fee[2].replace(/,/g, ''),
      totalAmount: total[1].replace(/,/g, ''),
      termsAccepted: await this.termsCheckbox.isChecked(),
      submitEnabled: await this.confirmButton.isEnabled()
    };
  }

  submissionClickCount(): number {
    return this.submitClicks;
  }

  async confirmOnce(): Promise<SecurityKeyDialog> {
    if (this.submitClicks !== 0) throw new Error('Wealth subscription confirmation was already attempted.');
    await expect(this.confirmButton).toBeEnabled();
    this.submitClicks += 1;
    await this.confirmButton.click();
    const security = new SecurityKeyDialog(this.page);
    await security.waitForOpen();
    return security;
  }

  private get amountInput(): Locator {
    return this.page.getByRole('textbox').first();
  }

  private get termsCheckbox(): Locator {
    return this.page.getByRole('checkbox').first();
  }

  private get confirmButton(): Locator {
    return this.page.getByRole('button', { name: '确认并提交', exact: true });
  }
}
