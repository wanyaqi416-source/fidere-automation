import { existsSync } from 'node:fs';
import path from 'node:path';

import { expect, type Locator, type Page } from '@playwright/test';

import { Decimal, decimalFromText } from '../../src/utils/money';
import { clientRouteUrl } from './HomePage';
import { SecurityKeyDialog, type SecurityKeyDomStructure } from './SecurityKeyDialog';

export type WithdrawalAccountCurrencyMatrix = Record<string, string[]>;

export type WithdrawalBalanceSnapshot = {
  availableBalance: Decimal;
  totalBalance?: Decimal;
  displayedAvailableBalance: string;
};

export type WithdrawalConfirmationSnapshot = {
  accountType: string;
  beneficiary: string;
  requestedAmountText: string;
  feeText: string;
  actualDebitText: string;
};

export class WithdrawalPage {
  readonly amountInput: Locator;
  readonly memoInput: Locator;
  readonly continueButton: Locator;
  readonly confirmButton: Locator;
  readonly modifyButton: Locator;
  readonly allButton: Locator;
  readonly securityKey: SecurityKeyDialog;
  private confirmationClickCount = 0;

  constructor(readonly page: Page) {
    this.amountInput = page.getByPlaceholder('0.00');
    this.memoInput = page.getByPlaceholder('选填');
    this.continueButton = page.getByRole('button', { name: '继续确认', exact: true });
    this.confirmButton = page.getByRole('button', { name: '确认转账', exact: true });
    this.modifyButton = page.getByRole('button', { name: '修改信息', exact: true });
    this.allButton = page.getByRole('button', { name: '全部', exact: true });
    this.securityKey = new SecurityKeyDialog(page);
  }

  async goto(baseURL: string): Promise<void> {
    const url = new URL(clientRouteUrl(baseURL, 'account/transfer'));
    url.searchParams.set('mode', 'beneficiary');
    url.searchParams.set('fromAccountType', 'trust');
    await this.page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await expect(this.page).toHaveURL(/\/account\/transfer\?mode=beneficiary&fromAccountType=trust/);
    await expect(this.page.getByRole('heading', { name: '法币转出', exact: true })).toBeVisible();
    await expect
      .poll(async () => (await this.visibleLocators(this.page.getByRole('combobox'))).length, {
        message: '等待Client法币转出账户、币种和用途下拉加载完成',
        timeout: 20_000
      })
      .toBeGreaterThanOrEqual(3);
    const account = await this.accountCombobox();
    if (account) await expect(account).toBeVisible();
    else expect(await this.readSummaryLabelValue('付款账户')).not.toMatch(/^\s*-?\s*$/);
    await expect(await this.currencyCombobox()).toBeVisible();
    await expect(this.amountInput).toBeVisible();
  }

  async readAccountOptions(): Promise<string[]> {
    const account = await this.accountCombobox();
    return account ? this.readOptions(account) : [await this.readSummaryLabelValue('付款账户')];
  }

  async readCurrencyOptions(): Promise<string[]> {
    return this.readOptions(await this.currencyCombobox());
  }

  async readAccountCurrencyMatrix(): Promise<WithdrawalAccountCurrencyMatrix> {
    const matrix: WithdrawalAccountCurrencyMatrix = {};
    for (const accountType of await this.readAccountOptions()) {
      await this.selectAccount(accountType);
      matrix[accountType] = await this.readCurrencyOptions();
    }
    return matrix;
  }

  async selectAccount(accountType: string): Promise<void> {
    const accountCombobox = await this.accountCombobox();
    if (!accountCombobox) {
      expect(await this.readSummaryLabelValue('付款账户')).toBe(accountType);
      return;
    }
    const currentAccount = (await accountCombobox.innerText()).replace(/\s+/g, ' ').trim();
    const accountChanges = !currentAccount.includes(accountType);
    const previousCurrencies = accountChanges ? await this.readCurrencyOptions() : [];

    await this.selectOption(accountCombobox, accountType);

    if (accountChanges) {
      await expect
        .poll(
          async () => {
            const currentCurrencies = await this.readCurrencyOptions();
            return (
              currentCurrencies.length > 0 &&
              JSON.stringify(currentCurrencies) !== JSON.stringify(previousCurrencies)
            );
          },
          {
            message: `等待Client法币转出账户“${accountType}”的币种选项刷新`,
            timeout: 15_000
          }
        )
        .toBe(true);
    }
  }

  async selectCurrency(currencyLabel: string): Promise<void> {
    await this.selectOption(await this.currencyCombobox(), currencyLabel);
  }

  async readPurposeOptions(): Promise<string[]> {
    return this.readOptions(await this.purposeCombobox());
  }

  async selectPurpose(purpose: string): Promise<void> {
    await this.selectOption(await this.purposeCombobox(), purpose);
  }

  async readTransferMethodOptions(): Promise<string[]> {
    return this.readOptions(await this.transferMethodCombobox());
  }

  async selectTransferMethod(method: string): Promise<void> {
    await this.selectOption(await this.transferMethodCombobox(), method);
  }

  async uploadSupportingDocument(asset: string): Promise<string> {
    const assetPath = path.resolve(asset);
    if (!existsSync(assetPath)) {
      throw new Error('Withdrawal supporting document asset does not exist.');
    }
    const input = await this.supportingDocumentInput();
    const accept = await input.getAttribute('accept');
    expect(accept).toBe('.pdf,.png,.jpg,.jpeg');
    const fileName = path.basename(assetPath);
    await input.setInputFiles(assetPath);
    await expect(this.page.getByText(fileName, { exact: true })).toBeVisible({ timeout: 20_000 });
    return fileName;
  }

  async readBeneficiaryCount(): Promise<number> {
    return (await this.beneficiaryPanel()).getByText('接收币种', { exact: true }).count();
  }

  async selectBeneficiary(input: {
    name: string;
    accountSuffix: string;
    currency: string;
  }): Promise<void> {
    const panel = await this.beneficiaryPanel();
    const names = await panel.getByText(input.name, { exact: true }).all();
    const matches: Locator[] = [];

    for (const name of names) {
      if (!(await name.isVisible())) continue;
      let container = name;
      for (let level = 0; level < 5; level += 1) {
        container = container.locator('..');
        const text = (await container.innerText()).replace(/\s+/g, ' ').trim();
        if (text.includes(input.accountSuffix) && text.includes(input.currency)) {
          matches.push(name);
          break;
        }
      }
    }

    if (matches.length !== 1) {
      throw new Error(
        `Client Withdrawal expected one beneficiary matching configured name, account suffix and ${input.currency}; found ${matches.length}.`
      );
    }

    await matches[0].click();
    await expect(await this.readSummaryLabelValue('收款人')).toBe(input.name);
  }

  async fillAmount(amount: string): Promise<void> {
    await this.amountInput.fill(amount);
    await expect(this.amountInput).toHaveValue(amount);
  }

  async clearAmount(): Promise<void> {
    await this.amountInput.fill('');
    await expect(this.amountInput).toHaveValue('');
  }

  async readAmount(): Promise<string> {
    return this.amountInput.inputValue();
  }

  async blurAmount(): Promise<void> {
    await this.memoInput.focus();
  }

  async useAllAvailableBalance(): Promise<string> {
    await this.allButton.click();
    await expect(this.amountInput).not.toHaveValue('');
    return this.amountInput.inputValue();
  }

  async readBalanceSnapshot(): Promise<WithdrawalBalanceSnapshot> {
    const displayedAvailableBalance = (
      await this.page.getByText(/可用余额:/).first().innerText()
    ).trim();
    return {
      availableBalance: decimalFromText(
        displayedAvailableBalance,
        'Client Withdrawal available balance'
      ),
      displayedAvailableBalance
    };
  }

  async readDisplayedLimits(): Promise<string[]> {
    return (await this.page.getByText(/最低|最小|最高|最大|限额/).allTextContents())
      .map(value => value.trim())
      .filter(Boolean);
  }

  async readVisibleValidationMessages(): Promise<string[]> {
    return [...new Set(
      (await this.page.getByText(/请输入有效金额|余额不足|最低|最小|最高|最大|限额|必填/).allTextContents())
        .map(value => value.trim())
        .filter(Boolean)
    )];
  }

  async continueToConfirmation(): Promise<WithdrawalConfirmationSnapshot> {
    await this.continueButton.click();
    await expect(this.confirmButton).toBeVisible();
    await expect(this.modifyButton).toBeVisible();
    await expect
      .poll(async () => await this.readFormFeeText())
      .not.toContain('加载中');
    return this.readConfirmationSnapshot();
  }

  async returnToForm(): Promise<void> {
    await this.modifyButton.click();
    await expect(this.continueButton).toBeVisible();
  }

  async readConfirmationSnapshot(): Promise<WithdrawalConfirmationSnapshot> {
    await expect(this.confirmButton).toBeVisible();
    return {
      accountType: await this.readSummaryLabelValue('付款账户'),
      beneficiary: await this.readSummaryLabelValue('收款人'),
      requestedAmountText: await this.readSummaryLabelValue('转账金额'),
      feeText: await this.readSummaryLabelValue('手续费'),
      actualDebitText: await this.readSummaryLabelValue('实际扣款')
    };
  }

  async readFormFeeText(): Promise<string> {
    return this.readAdjacentValue(this.page.getByText('预计手续费', { exact: true }));
  }

  async openSecurityKeyDialogOnce(): Promise<void> {
    if (this.confirmationClickCount > 0) {
      throw new Error('Withdrawal 确认转账已点击过一次；不会再次点击。');
    }
    this.confirmationClickCount += 1;
    await this.confirmButton.click();
    await this.securityKey.waitForOpen();
  }

  async readSecurityKeyDomStructure(): Promise<SecurityKeyDomStructure> {
    return this.securityKey.readDomStructure();
  }

  async verifySecurityKeyOnce(
    securityKey: string,
    allowMoneyTests: boolean,
    allowAdminMutationTests: boolean
  ): Promise<void> {
    if (!allowMoneyTests || !allowAdminMutationTests) {
      throw new Error(
        'Withdrawal安全密钥“验证”要求同时开启ALLOW_MONEY_TESTS和ALLOW_ADMIN_MUTATION_TESTS。'
      );
    }
    await this.securityKey.fill(securityKey);
    await this.securityKey.verifyOnce();
  }

  async closeSecurityKeyWithoutVerifying(): Promise<void> {
    await this.securityKey.closeWithoutVerifying();
  }

  confirmationClicks(): number {
    return this.confirmationClickCount;
  }

  securityVerificationClicks(): number {
    return this.securityKey.wasVerificationClicked() ? 1 : 0;
  }

  private async accountCombobox(): Promise<Locator | undefined> {
    return this.findComboboxNearText('付款账户');
  }

  private async currencyCombobox(): Promise<Locator> {
    return this.comboboxNearText('币种');
  }

  private async purposeCombobox(): Promise<Locator> {
    return this.comboboxByFieldLabel(/^转账用途\s*\*?$/);
  }

  private async transferMethodCombobox(): Promise<Locator> {
    return this.comboboxByFieldLabel(/^转账方式（选填）$/);
  }

  private async supportingDocumentInput(): Promise<Locator> {
    const label = this.page.getByText('上传支持性文件（选填）', { exact: true });
    await expect(label).toHaveCount(1);
    let container = label;
    for (let level = 0; level < 6; level += 1) {
      container = container.locator('..');
      const inputs = container.locator('input[type="file"]');
      if (await inputs.count() === 1) return inputs;
    }
    throw new Error('Client Withdrawal supporting document input was not found near its label.');
  }

  private async comboboxByFieldLabel(label: RegExp): Promise<Locator> {
    const matches: Locator[] = [];
    for (const combobox of await this.page.getByRole('combobox').all()) {
      if (!(await combobox.isVisible())) continue;
      const groupText = (await combobox.locator('..').innerText())
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (label.test(groupText)) matches.push(combobox);
    }
    if (matches.length !== 1) {
      throw new Error(`Client Withdrawal expected one combobox for ${String(label)}; found ${matches.length}.`);
    }
    return matches[0];
  }

  private async beneficiaryPanel(): Promise<Locator> {
    const labels = await this.page.getByText('收款信息', { exact: true }).all();
    for (const label of labels) {
      if (!(await label.isVisible())) continue;
      let container = label;
      for (let level = 0; level < 6; level += 1) {
        container = container.locator('..');
        if ((await container.getByPlaceholder('搜索银行地址').count()) === 1) {
          return container;
        }
      }
    }
    throw new Error('Client Withdrawal beneficiary panel was not found.');
  }

  private async readSummaryLabelValue(label: string): Promise<string> {
    const summaryTitle = this.page.getByText('本次转账摘要', { exact: true });
    let summary = summaryTitle;
    for (let level = 0; level < 5; level += 1) {
      summary = summary.locator('..');
      if ((await summary.getByText('实际扣款', { exact: true }).count()) === 1) break;
    }
    return this.readAdjacentValue(summary.getByText(label, { exact: true }));
  }

  private async readAdjacentValue(label: Locator): Promise<string> {
    await expect(label).toBeVisible();
    const parent = label.locator('..');
    const lines = (await parent.innerText())
      .split(/\r?\n/)
      .map(value => value.trim())
      .filter(Boolean);
    const labelText = (await label.innerText()).trim();
    const values = lines.filter(value => value !== labelText);
    if (values.length !== 1) {
      throw new Error(`Client Withdrawal field “${labelText}” did not have one adjacent value.`);
    }
    return values[0];
  }

  private async comboboxNearText(label: string | RegExp): Promise<Locator> {
    const match = await this.findComboboxNearText(label);
    if (!match) throw new Error(`Client Withdrawal expected one visible combobox near “${String(label)}”; found 0.`);
    return match;
  }

  private async findComboboxNearText(label: string | RegExp): Promise<Locator | undefined> {
    const labels = await this.page.getByText(label, {
      exact: typeof label === 'string'
    }).all();
    const matches: Locator[] = [];
    for (const item of labels) {
      if (!(await item.isVisible())) continue;
      let container = item;
      for (let level = 0; level < 5; level += 1) {
        container = container.locator('..');
        const comboboxes = await this.visibleLocators(container.getByRole('combobox'));
        if (comboboxes.length === 1) {
          matches.push(comboboxes[0]);
          break;
        }
        // Summary labels are display-only; do not climb out and capture another field's selector.
        if (await container.getByText('本次转账摘要', { exact: true }).count()) break;
      }
    }
    const unique = this.uniqueLocators(matches);
    if (unique.length > 1) {
      throw new Error(
        `Client Withdrawal expected one visible combobox near “${String(label)}”; found ${unique.length}.`
      );
    }
    return unique[0];
  }

  private async readOptions(combobox: Locator): Promise<string[]> {
    await combobox.click();
    const listbox = this.page.getByRole('listbox').last();
    await expect(listbox).toBeVisible();
    const values = (await listbox.getByRole('option').allTextContents())
      .map(value => value.trim())
      .filter(Boolean);
    await this.page.keyboard.press('Escape');
    await expect(listbox).toBeHidden();
    return [...new Set(values)];
  }

  private async selectOption(combobox: Locator, optionName: string): Promise<void> {
    await combobox.click();
    const listbox = this.page.getByRole('listbox').last();
    await expect(listbox).toBeVisible();
    const matches: Locator[] = [];
    for (const option of await listbox.getByRole('option').all()) {
      if ((await option.innerText()).trim() === optionName) matches.push(option);
    }
    if (matches.length !== 1) {
      throw new Error(
        `Client Withdrawal expected one option “${optionName}”; found ${matches.length}.`
      );
    }
    await matches[0].click();
    await expect(listbox).toBeHidden();
    await expect(combobox).toContainText(optionName);
  }

  private async visibleLocators(locator: Locator): Promise<Locator[]> {
    const visible: Locator[] = [];
    for (const item of await locator.all()) {
      if (await item.isVisible()) visible.push(item);
    }
    return visible;
  }

  private uniqueLocators(locators: Locator[]): Locator[] {
    const seen = new Set<string>();
    return locators.filter(locator => {
      const key = locator.toString();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
