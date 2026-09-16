import { expect, type Locator, type Page } from '@playwright/test';
import { parseWealthDisplayAmount } from '../../src/wealth/wealth-money';
import { SecurityKeyDialog } from './SecurityKeyDialog';

export type FundRedemptionSnapshot = {
  productName: string;
  redemptionAmount: string;
  currency: string;
  settlementAccount: string;
  feeAmount: string;
  expectedSettlementAmount: string;
  submitEnabled: boolean;
};

export class FundRedeemPage {
  private submitClicks = 0;

  constructor(readonly page: Page) {}

  async expectLoaded(): Promise<void> {
    await expect(this.page.locator('main')).toContainText('赎回', { timeout: 20_000 });
    await expect(this.confirmButton).toHaveCount(1);
    await expect(this.confirmButton).toBeVisible();
  }

  async prepareDefaultRedemption(fallbackAmount: string): Promise<void> {
    const amount = this.amountInput;
    const amountCount = await amount.count();
    if (amountCount > 1) throw new Error('Redemption amount field is ambiguous.');
    if (amountCount === 1 && !(await amount.inputValue()).trim()) {
      await amount.fill(fallbackAmount);
      await amount.blur();
    }

    const terms = this.page.getByRole('checkbox', { name: /同意|确认|阅读/ });
    const termsCount = await terms.count();
    if (termsCount > 1) throw new Error('Redemption agreement checkbox is ambiguous.');
    if (termsCount === 1 && !await terms.isChecked()) await terms.check();
  }

  async readSnapshot(): Promise<FundRedemptionSnapshot> {
    const text = (await this.page.locator('main').innerText()).replace(/\u00a0/g, ' ');
    const productName = text.match(/产品名称\s*([^\r\n]+)/)?.[1]?.trim();
    const amount = this.readMoney(text, ['赎回金额', '赎回份额']);
    const fee = this.readMoney(text, ['手续费'], amount.currency, true);
    const settlement = this.readMoney(text, ['实际结算金额', '预计结算金额', '预计到账金额', '预计到账'], amount.currency);
    const settlementAccount = text.match(/结算账户\s*([^\r\n]+)/)?.[1]?.trim();
    if (!productName || !settlementAccount) {
      throw new Error('Fund redemption summary does not expose product and settlement account.');
    }
    return {
      productName,
      redemptionAmount: amount.amount,
      currency: amount.currency,
      settlementAccount,
      feeAmount: fee.amount,
      expectedSettlementAmount: settlement.amount,
      submitEnabled: await this.confirmButton.isEnabled()
    };
  }

  submissionClickCount(): number {
    return this.submitClicks;
  }

  async confirmOnce(): Promise<SecurityKeyDialog> {
    if (this.submitClicks !== 0) throw new Error('Wealth redemption confirmation was already attempted.');
    await expect(this.confirmButton).toBeEnabled();
    this.submitClicks += 1;
    await this.confirmButton.click();
    const security = new SecurityKeyDialog(this.page);
    await security.waitForOpen();
    return security;
  }

  private readMoney(text: string, labels: string[], fallbackCurrency?: string, optional = false) {
    for (const label of labels) {
      const start = text.indexOf(label);
      if (start < 0) continue;
      try {
        return parseWealthDisplayAmount(text.slice(start + label.length));
      } catch {
        // Try the next verified business label.
      }
    }
    if (optional && fallbackCurrency) return { amount: '0', currency: fallbackCurrency, matchedText: '' };
    throw new Error(`Fund redemption summary does not expose ${labels.join('/')} as a readable amount.`);
  }

  private get amountInput(): Locator {
    return this.page.getByLabel(/赎回金额|赎回份额/).or(
      this.page.getByPlaceholder(/赎回金额|赎回份额|请输入.*(?:金额|份额)/)
    ).filter({ visible: true });
  }

  private get confirmButton(): Locator {
    return this.page.getByRole('button', { name: /^(?:确认并提交|确认赎回|提交赎回)$/ });
  }
}
