import { expect, type Locator, type Page } from '@playwright/test';
import { AccountDetailPage } from './AccountDetailPage';
import { SecurityKeyDialog } from './SecurityKeyDialog';
import { Decimal } from '../../src/utils/money';
import { formatU2uBalance, verifyU2uSummary } from '../../src/user-transfer/u2u-summary';

export class UserToUserTransferPage {
  get root() {
    return this.page.getByRole('main').filter({ has: this.page.getByRole('heading', { name: '转账给其他用户', exact: true }) });
  }
  get recipientInput() { return this.root.locator('input[type="email"]'); }
  get assetSelect() { return this.root.getByRole('combobox', { name: '转出资产', exact: true }); }
  get amountInput() { return this.root.getByPlaceholder('0.00', { exact: true }); }
  get submitButton() { return this.root.getByRole('button', { name: '确认并提交审核', exact: true }); }
  readonly security: SecurityKeyDialog;
  private confirmationCount = 0;
  constructor(readonly page: Page) { this.security = new SecurityKeyDialog(page); }

  async goto(baseURL: string): Promise<void> {
    await new AccountDetailPage(this.page).goto(baseURL);
    await this.page.getByRole('button', { name: '用户转账', exact: true }).click();
    await expect(this.recipientInput).toBeVisible({ timeout: 30_000 });
    await expect(this.assetSelect).toBeVisible();
    await expect(this.submitButton).toBeVisible();
  }

  async inspectForm() {
    return {
      route: new URL(this.page.url()).pathname,
      feeDeductedFromAmount: await this.root.getByText('手续费（从金额内扣）', { exact: true }).isVisible(),
      eligibilityCheckedAtSubmission: await this.root.getByText('收款用户及账户资格将在提交时由系统校验。', { exact: true }).isVisible(),
      submitEnabled: await this.submitButton.isEnabled()
    };
  }

  async confirmOnce(beforeClick?: () => void): Promise<void> {
    if (this.confirmationCount !== 0) throw new Error('U2U confirmation already attempted; query the original order only.');
    await expect(this.submitButton).toBeEnabled();
    beforeClick?.();
    this.confirmationCount += 1;
    await this.submitButton.click();
    await this.security.waitForOpen();
  }

  confirmationClickCount(): number { return this.confirmationCount; }

  async fillRunNote(runId: string): Promise<void> {
    if (!/^[A-Z0-9._-]+$/i.test(runId)) throw new Error('Invalid transfer Run ID.');
    await this.root.getByPlaceholder('填写本次转账说明', { exact: true }).fill(`AUTO_TRANSFER_FEE_${runId}`);
  }

  async readCreatedOrderId(): Promise<string> {
    const order = this.root.getByText(/^TRF-[A-Z0-9-]+$/i);
    await expect(order).toHaveCount(1);
    await expect(order).toBeVisible();
    return (await order.innerText()).trim();
  }

  async fillRecipient(sender: string, recipient: string): Promise<void> {
    if (!recipient || sender.trim().toLowerCase() === recipient.trim().toLowerCase()) {
      throw new Error('U2U requires a distinct configured recipient.');
    }
    await this.recipientInput.fill(recipient.trim());
    expect((await this.recipientInput.inputValue()) === recipient.trim(), 'Recipient input accepted').toBe(true);
  }

  async readAssetOptions(): Promise<string[]> {
    await this.assetSelect.click();
    await expect(this.page.getByRole('listbox')).toBeVisible();
    const options = await this.page.getByRole('option').allTextContents();
    await this.page.keyboard.press('Escape');
    await expect(this.page.getByRole('listbox')).toBeHidden();
    return options.map(value => value.replace(/\s+/g, ' ').trim());
  }

  async previewUniqueAsset(currency: string, amount: string, sourceAccountType?: string) {
    if (!/^[A-Z0-9_]+$/.test(currency) || !new Decimal(amount).isPositive()) {
      throw new Error('U2U preview requires a positive configured amount and currency.');
    }
    await this.assetSelect.click();
    await expect(this.page.getByRole('listbox')).toBeVisible();
    let group = '';
    const candidates: Locator[] = [];
    for (const option of await this.page.getByRole('option').all()) {
      const text = (await option.innerText()).trim();
      if (/^(?:数字资产|香港|新加坡|巴林|美国)账户$/.test(text)) {
        group = text;
      } else if ((!sourceAccountType || group === sourceAccountType) &&
        await option.getByText(currency, { exact: true }).count() === 1) {
        candidates.push(option);
      }
    }
    expect(candidates.length, 'The selected currency and account must identify one asset').toBe(1);
    const [asset] = candidates;
    const assetText = (await asset.innerText()).replace(/\s+/g, ' ').trim();
    const balance = assetText.match(/([\d,]+(?:\.\d+)?)\s*$/)?.[1];
    if (!balance || !new Decimal(amount).lt(new Decimal(balance.replace(/,/g, '')))) {
      throw new Error('U2U preview amount must leave a positive remaining available balance.');
    }
    await asset.click();
    await expect(this.amountInput).toBeEnabled();
    await this.amountInput.fill(amount);
    await this.root.getByPlaceholder('填写本次转账说明', { exact: true }).fill('AUTOMATION U2U TRANSFER');
    const summary = this.root.getByRole('heading', { name: '转账摘要', exact: true }).locator('..');
    const readField = async (label: string) => {
      const text = await summary.getByText(label, { exact: true }).locator('..').innerText();
      return text.slice(text.indexOf(label) + label.length).trim();
    };
    await expect.poll(async () => await readField('手续费（从金额内扣）'), { timeout: 20_000 })
      .toMatch(/\d|免费/);
    const accountLabel = await readField('转出账户');
    // Verified summary renders the account followed by a currency suffix.
    const accountName = accountLabel.endsWith(` · ${currency}`) ? accountLabel.slice(0, -` · ${currency}`.length) : accountLabel;
    if (sourceAccountType && accountName !== sourceAccountType) throw new Error('Selected U2U account differs from its summary.');
    const preview = {
      sourceAsset: assetText,
      sourceBalanceBefore: formatU2uBalance(balance.replace(/,/g, '')),
      transferAmount: await readField('转账金额'),
      sourceAccountType: accountName,
      fee: await readField('手续费（从金额内扣）'),
      expectedReceivedAmount: await readField('预计到账'),
      submitEnabled: await this.submitButton.isEnabled()
    };
    const quote = verifyU2uSummary({ currency, requestedAmount: amount,
      displayedAmount: preview.transferAmount, displayedFee: preview.fee,
      displayedCredit: preview.expectedReceivedAmount,
      feeDeductedFromAmount: (await this.inspectForm()).feeDeductedFromAmount });
    return { ...preview, quote };
  }
}
