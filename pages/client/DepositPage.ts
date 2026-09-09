import { existsSync } from 'node:fs';
import path from 'node:path';

import { expect, type Locator, type Page } from '@playwright/test';

import { env } from '../../src/config/env';
import { clientRouteUrl } from './HomePage';

export type DepositAccountCurrencyMatrix = Record<string, string[]>;

export type DepositFormSnapshot = {
  accountType: string;
  currencyLabel: string;
  amount: string;
  channel: string;
  purpose: string;
  sourceOfFunds: string;
  submitEnabled: boolean;
};

export type DepositSubmissionResult = {
  requestPath: string;
  httpStatus: number;
  submittedAtMs: number;
};

export type DepositSupportingDocumentRequirements = {
  accept: string;
  multiple: boolean;
  required: boolean;
};

export class DepositPage {
  readonly amountInput: Locator;
  readonly noteInput: Locator;
  readonly submitButton: Locator;
  private submitClickCount = 0;

  constructor(readonly page: Page) {
    this.amountInput = page.getByLabel(/^入金金额/);
    this.noteInput = page.getByLabel(/^转账附言/);
    this.submitButton = page.getByRole('button', { name: '提交', exact: true });
  }

  async goto(baseURL: string): Promise<void> {
    const url = new URL(clientRouteUrl(baseURL, 'account/fund-in'));
    url.searchParams.set('fromAccountType', 'trust');
    await this.page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await expect(this.page).toHaveURL(/\/account\/fund-in\?fromAccountType=trust/);
    await expect(this.page.getByText('银行电汇入金', { exact: true })).toBeVisible();
    await expect(this.page.locator('[class*="skeleton"], [class*="Skeleton"]')).toHaveCount(0, {
      timeout: 20_000
    });
    await expect(this.amountInput).toBeVisible();
    await expect(this.submitButton).toBeVisible();
  }

  async readAccountOptions(): Promise<string[]> {
    return this.readOptions(await this.accountCombobox());
  }

  async readCurrencyOptions(): Promise<string[]> {
    return this.readOptions(await this.currencyCombobox());
  }

  async readAccountCurrencyMatrix(): Promise<DepositAccountCurrencyMatrix> {
    const matrix: DepositAccountCurrencyMatrix = {};
    for (const accountType of await this.readAccountOptions()) {
      await this.selectAccount(accountType);
      matrix[accountType] = await this.readCurrencyOptions();
    }
    return matrix;
  }

  async selectAccount(accountType: string): Promise<void> {
    await this.selectOption(await this.accountCombobox(), accountType);
  }

  async selectCurrency(currencyLabel: string): Promise<void> {
    await this.selectOption(await this.currencyCombobox(), currencyLabel);
  }

  async readPayingBankCount(): Promise<number> {
    const options = await this.readOptions(await this.payingBankCombobox());
    return options.length;
  }

  async selectFirstPayingBank(): Promise<void> {
    const combobox = await this.payingBankCombobox();
    const options = await this.readOptions(combobox);
    if (options.length === 0) {
      throw new Error('Client Deposit has no configured paying bank option.');
    }
    await this.selectOption(combobox, options[0]);
  }

  async selectPayingBank(expectedText: string, accountSuffix?: string): Promise<string> {
    const normalizedExpected = expectedText.replace(/\s+/g, '').toLocaleLowerCase();
    try {
      const combobox = await this.payingBankCombobox();
      const options = await this.readOptions(combobox);
      const matches = options.filter(option => {
        const normalized = option.replace(/\s+/g, '').toLocaleLowerCase();
        return normalized.includes(normalizedExpected) ||
          Boolean(accountSuffix && normalized.endsWith(accountSuffix));
      });
      if (matches.length !== 1) {
        throw new Error(
          `Client Deposit expected one paying bank matching the approved account; found ${matches.length}.`
        );
      }
      await this.selectOption(combobox, matches[0]);
      return matches[0];
    } catch (error) {
      const visibleBankLabels: string[] = [];
      const candidates = this.page.getByText(expectedText, { exact: false });
      for (const candidate of await candidates.all()) {
        if (await candidate.isVisible()) {
          const text = (await candidate.innerText()).trim();
          if (text) visibleBankLabels.push(text);
        }
      }
      if (visibleBankLabels.length === 1) {
        return visibleBankLabels[0];
      }
      throw error;
    }
  }

  async readChannelOptions(): Promise<string[]> {
    return this.readOptions(await this.formCombobox(/^打款渠道/));
  }

  async readPurposeOptions(): Promise<string[]> {
    return this.readOptions(await this.formCombobox(/^打款用途/));
  }

  async readSourceOfFundsOptions(): Promise<string[]> {
    return this.readOptions(await this.formCombobox(/^资金来源/));
  }

  async selectChannel(channel: string): Promise<void> {
    await this.selectOption(await this.formCombobox(/^打款渠道/), channel);
  }

  async selectPurpose(purpose: string): Promise<void> {
    await this.selectOption(await this.formCombobox(/^打款用途/), purpose);
  }

  async selectSourceOfFunds(source: string): Promise<void> {
    await this.selectOption(await this.formCombobox(/^资金来源/), source);
  }

  async readTransferMethodOptions(): Promise<string[]> {
    return this.readOptions(await this.formCombobox(/^转账方式/));
  }

  async selectTransferMethod(method: string): Promise<void> {
    await this.selectOption(await this.formCombobox(/^转账方式/), method);
  }

  async readSupportingDocumentRequirements(): Promise<DepositSupportingDocumentRequirements> {
    const input = await this.supportingDocumentInput();
    return {
      accept: (await input.getAttribute('accept')) ?? '',
      multiple: await input.getAttribute('multiple') !== null,
      required: await input.getAttribute('required') !== null
    };
  }

  async uploadSupportingDocument(asset: string): Promise<string> {
    const assetPath = path.resolve(asset);
    if (!existsSync(assetPath)) {
      throw new Error('Deposit supporting document asset does not exist.');
    }
    const input = await this.supportingDocumentInput();
    const fileName = path.basename(assetPath);
    await input.setInputFiles(assetPath);
    await expect(this.page.getByText(fileName, { exact: true })).toBeVisible({ timeout: 20_000 });
    return fileName;
  }

  async fillAmount(amount: string): Promise<void> {
    await this.amountInput.fill(amount);
    await expect(this.amountInput).toHaveValue(amount);
  }

  async blurAmount(): Promise<void> {
    await this.noteInput.focus();
  }

  async clearAmount(): Promise<void> {
    await this.amountInput.fill('');
    await expect(this.amountInput).toHaveValue('');
  }

  async fillReference(reference: string): Promise<void> {
    await this.noteInput.fill(reference);
    await expect(this.noteInput).toHaveValue(reference);
  }

  async readVisibleValidationMessages(): Promise<string[]> {
    const candidates = this.page.getByText(
      /必填|请输入|不能为0|大于0|金额无效|最低|最高|超出|余额不足/
    );
    const messages: string[] = [];
    for (const item of await candidates.all()) {
      if (await item.isVisible()) {
        const value = (await item.innerText()).trim();
        if (value) messages.push(value);
      }
    }
    return [...new Set(messages)];
  }

  async readFormSnapshot(): Promise<DepositFormSnapshot> {
    return {
      accountType: (await (await this.accountCombobox()).innerText()).trim(),
      currencyLabel: (await (await this.currencyCombobox()).innerText()).trim(),
      amount: await this.amountInput.inputValue(),
      channel: (await (await this.formCombobox(/^打款渠道/)).innerText()).trim(),
      purpose: (await (await this.formCombobox(/^打款用途/)).innerText()).trim(),
      sourceOfFunds: (await (await this.formCombobox(/^资金来源/)).innerText()).trim(),
      submitEnabled: await this.submitButton.isEnabled()
    };
  }

  async submitOnce(): Promise<DepositSubmissionResult> {
    if (!env.exchange.allowMoneyTests || !env.allowAdminMutationTests) {
      throw new Error(
        'Deposit submission requires ALLOW_MONEY_TESTS=true and ALLOW_ADMIN_MUTATION_TESTS=true.'
      );
    }
    if (this.submitClickCount > 0) {
      throw new Error('Deposit submit button can only be clicked once per Page Object instance.');
    }
    this.submitClickCount += 1;
    const responsePromise = this.page.waitForResponse(response => {
      const request = response.request();
      return request.method() === 'POST' && new URL(response.url()).pathname.endsWith('/confirm-deposit');
    });
    const submittedAtMs = Date.now();
    await this.submitButton.click();
    const response = await responsePromise;
    if (!response.ok()) {
      throw new Error(`Client Deposit submission returned HTTP ${response.status()}.`);
    }
    await expect(
      this.page.getByRole('heading', { name: '入金申请已提交', exact: true })
    ).toBeVisible();
    return {
      requestPath: new URL(response.url()).pathname,
      httpStatus: response.status(),
      submittedAtMs
    };
  }

  submissionClicks(): number {
    return this.submitClickCount;
  }

  private async accountCombobox(): Promise<Locator> {
    return this.comboboxNearText('收款账户');
  }

  private async currencyCombobox(): Promise<Locator> {
    return this.comboboxNearText('币种');
  }

  private async payingBankCombobox(): Promise<Locator> {
    return this.comboboxNearText('选择打款银行');
  }

  private async formCombobox(label: RegExp): Promise<Locator> {
    const byLabel = this.page.getByRole('combobox', { name: label });
    const visibleByLabel = await this.visibleLocators(byLabel);
    if (visibleByLabel.length === 1) return visibleByLabel[0];

    const labelLocator = this.page.locator('label').filter({ hasText: label });
    for (const item of await labelLocator.all()) {
      if (!(await item.isVisible())) continue;
      let container = item;
      for (let level = 0; level < 4; level += 1) {
        container = container.locator('..');
        const comboboxes = await this.visibleLocators(container.getByRole('combobox'));
        if (comboboxes.length === 1) return comboboxes[0];
      }
    }
    throw new Error(`Client Deposit form combobox was not found for ${label.source}.`);
  }

  private async supportingDocumentInput(): Promise<Locator> {
    const labels = this.page.getByText(/上传支持性文件/);
    for (const label of await labels.all()) {
      if (!(await label.isVisible())) continue;
      let container = label;
      for (let level = 0; level < 6; level += 1) {
        container = container.locator('..');
        const inputs = container.locator('input[type="file"]');
        if (await inputs.count() === 1) return inputs;
      }
    }
    throw new Error('Client Deposit supporting document input was not found near its label.');
  }

  private async comboboxNearText(label: string): Promise<Locator> {
    const labels = await this.page.getByText(label, { exact: true }).all();
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
      }
    }
    const unique = this.uniqueLocators(matches);
    if (unique.length !== 1) {
      throw new Error(`Client Deposit expected one visible combobox near “${label}”, found ${unique.length}.`);
    }
    return unique[0];
  }

  private async readOptions(combobox: Locator): Promise<string[]> {
    await combobox.click();
    const listbox = this.page.getByRole('listbox').last();
    await expect(listbox).toBeVisible();
    const values: string[] = [];
    for (const option of await listbox.getByRole('option').all()) {
      if (await option.isVisible()) {
        const value = (await option.innerText()).trim();
        if (value && !/^请选择/.test(value)) values.push(value);
      }
    }
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
        `Client Deposit expected one option with visible text “${optionName}”, found ${matches.length}.`
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
