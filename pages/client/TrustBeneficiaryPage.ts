import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { clientRouteUrl } from './HomePage';
import { SecurityKeyDialog } from './SecurityKeyDialog';
import type { TrustBeneficiaryTestData } from '../../src/trust/trust-beneficiary-data';

export type SafeTrustMutationEvidence = { path?: string; status?: number; observedAt: string };
export type TrustBeneficiarySubmissionResult = {
  recordVisible: boolean;
  mutationResponseCount: number;
  evidence?: SafeTrustMutationEvidence;
  securityDialogObserved: boolean;
  securityVerificationCount: number;
};

export type TrustBankAccountSubmissionResult = TrustBeneficiarySubmissionResult & {
  bankAccountCount: number;
};

export class TrustBeneficiaryPage {
  private beneficiarySubmitCount = 0;
  private bankSubmitCount = 0;
  readonly securityKey: SecurityKeyDialog;

  constructor(readonly page: Page) {
    this.securityKey = new SecurityKeyDialog(page);
  }

  async goto(baseURL: string): Promise<void> {
    await this.page.goto(clientRouteUrl(baseURL, 'trust'), { waitUntil: 'domcontentloaded' });
    await expect(this.page).not.toHaveURL(/\/login|\/signin|\/sign-in/i);
    await expect(this.page.getByRole('heading', { name: '信托信息', exact: true })).toBeVisible();
    await expect(this.page.getByRole('heading', { name: '受益人管理', exact: true })).toBeVisible();
  }

  async readTrustNumber(): Promise<string> {
    let trustNumbers: string[] = [];
    await expect.poll(async () => {
      const matches = await this.page.getByRole('heading').allTextContents();
      trustNumbers = matches.map(value => value.trim()).filter(value => /^TR\d+$/.test(value));
      if (trustNumbers.length > 1) throw new Error(`Expected one Trust Number; found ${trustNumbers.length}.`);
      return trustNumbers.length;
    }, { timeout: 20_000, intervals: [250, 500, 1_000], message: 'Wait for the current Trust Number' }).toBe(1);
    return trustNumbers[0];
  }

  async openAddBeneficiary(): Promise<void> {
    const button = this.page.getByRole('button', { name: /添加受益人|新增受益人/ });
    await expect(button).toHaveCount(1);
    await button.click();
    await expect(this.beneficiaryDialog()).toBeVisible();
  }

  async fillBeneficiary(input: TrustBeneficiaryTestData): Promise<void> {
    const dialog = this.beneficiaryDialog();
    await dialog.locator('input[name="firstName"]').fill(input.name);
    await this.selectNamedInput(dialog, 'relation', input.relationship);
    await this.selectNamedInput(dialog, 'idType', input.idType);
    await dialog.locator('input[name="idNumber"]').fill(input.idNumber);
    await dialog.locator('input[name="sharePct"]').fill(input.percentage);
    const expectedPrefixDigits = input.phonePrefix.replace(/\D/g, '');
    const currentPrefix = await dialog.locator('input[name="phonePrefix"]').inputValue();
    const visiblePrefix = await dialog.locator('input[name="phonePrefix"]').locator('..').getByRole('combobox').innerText();
    if (!`${currentPrefix} ${visiblePrefix}`.replace(/\D/g, '').includes(expectedPrefixDigits)) {
      await this.selectNamedInput(dialog, 'phonePrefix', `中国香港特别行政区${input.phonePrefix}`);
    }
    await dialog.locator('input[name="phone"]').fill(input.phone);
    await dialog.locator('input[name="email"]').fill(input.email);
    await dialog.getByPlaceholder('请输入详细地址', { exact: true }).fill(input.address);
    await expect(dialog.locator('input[name="firstName"]')).toHaveValue(input.name);
    await expect(dialog.locator('input[name="idNumber"]')).toHaveValue(input.idNumber);
    await expect(dialog.locator('input[name="sharePct"]')).toHaveValue(input.percentage);
  }

  async submitBeneficiaryOnce(input: TrustBeneficiaryTestData, securityKey: string): Promise<TrustBeneficiarySubmissionResult> {
    if (this.beneficiarySubmitCount !== 0) throw new Error('Beneficiary Submit is limited to once per Run.');
    this.beneficiarySubmitCount = 1;
    const observed: SafeTrustMutationEvidence[] = [];
    const listener = (response: Response) => {
      const url = new URL(response.url());
      if (url.origin !== new URL(this.page.url()).origin || !/beneficiar|trust/i.test(url.pathname)) return;
      if (!['POST', 'PUT', 'PATCH'].includes(response.request().method())) return;
      observed.push({ path: url.pathname, status: response.status(), observedAt: new Date().toISOString() });
    };
    this.page.on('response', listener);
    let recordVisible = false;
    try {
      await this.beneficiaryDialog().getByRole('button', { name: '提交', exact: true }).click();
      await this.securityKey.waitForOpen();
      await this.securityKey.fill(securityKey);
      await this.securityKey.verifyOnce();
      recordVisible = await expect.poll(async () => this.visibleExactTextCount(input.name), {
        timeout: 30_000,
        intervals: [500, 1_000, 2_000],
        message: 'Created Beneficiary did not become visible.'
      }).toBe(1).then(() => true, () => false);
    } finally {
      this.page.off('response', listener);
    }
    const evidence = observed.find(item => /beneficiar/i.test(item.path ?? '')) ?? observed.at(-1);
    return {
      recordVisible,
      mutationResponseCount: observed.length,
      evidence,
      securityDialogObserved: true,
      securityVerificationCount: this.securityKey.verificationClickCount()
    };
  }

  async expectBeneficiaryVisible(name: string): Promise<void> {
    await expect.poll(async () => this.visibleExactTextCount(name), {
      timeout: 30_000, intervals: [500, 1_000, 2_000], message: 'Created Beneficiary did not become visible.'
    }).toBe(1);
  }

  async beneficiaryStatus(name: string): Promise<string | undefined> {
    let current = this.page.getByText(name, { exact: true }).filter({ visible: true }).first();
    for (let depth = 0; depth < 8; depth += 1) {
      const text = await current.innerText().catch(() => '');
      const status = text.match(/已批准|审核通过|已通过|待审核|审核中|已拒绝/)?.[0];
      if (status) return status;
      current = current.locator('..');
    }
    return undefined;
  }

  async inspectBeneficiaryAncestors(name: string): Promise<Array<Record<string, unknown>>> {
    let current = this.page.getByText(name, { exact: true }).filter({ visible: true }).first();
    const output: Array<Record<string, unknown>> = [];
    for (let depth = 0; depth < 8; depth += 1) {
      output.push(await current.evaluate((element, currentDepth) => ({
        depth: currentDepth,
        tagName: element.tagName.toLowerCase(),
        role: element.getAttribute('role'),
        className: element.className,
        text: (element.textContent ?? '').replace(/\b\d{6,}\b/g, '[MASKED_NUMBER]').replace(/\s+/g, ' ').trim(),
        buttons: Array.from(element.querySelectorAll('button')).map(button => ({
          text: (button.textContent ?? '').trim(),
          ariaLabel: button.getAttribute('aria-label'),
          title: button.getAttribute('title'),
          testIds: Array.from(button.querySelectorAll('[data-testid]')).map(child => child.getAttribute('data-testid'))
        }))
      }), depth));
      current = current.locator('..');
    }
    return output;
  }

  async beneficiaryExists(name: string): Promise<boolean> {
    return (await this.visibleExactTextCount(name)) === 1;
  }

  async openAddBankAccount(name: string): Promise<Locator> {
    const container = await this.beneficiaryContainer(name);
    const direct = container.getByRole('button', { name: /添加账户|添加.*银行账户|新增.*银行账户|添加银行|银行账户/ });
    if (await direct.count() === 1) await direct.click();
    else {
      const detail = container.getByRole('button', { name: /查看详情|详情|管理/ });
      if (await detail.count() !== 1) throw new Error('Unique Beneficiary bank-account entry was not found.');
      await detail.click();
      const add = this.page.getByRole('button', { name: /添加.*银行账户|新增.*银行账户|添加银行/ });
      await expect(add).toHaveCount(1);
      await add.click();
    }
    const dialog = this.page.getByRole('dialog').filter({ hasText: /银行账户/ }).last();
    await expect(dialog).toBeVisible();
    return dialog;
  }

  async inspectOpenBankForm(): Promise<{
    labels: string[];
    placeholders: string[];
    inputs: Array<{ name: string | null; placeholder: string | null; type: string }>;
    comboboxValues: string[];
    optionSets: string[][];
    buttonLabels: string[];
  }> {
    const dialog = this.page.getByRole('dialog').filter({ hasText: /银行账户/ }).last();
    const optionSets: string[][] = [];
    for (const combobox of await dialog.getByRole('combobox').all()) {
      await combobox.click();
      optionSets.push((await this.page.getByRole('option').allTextContents()).map(value => value.trim()).filter(Boolean));
      await this.page.keyboard.press('Escape');
    }
    return {
      labels: (await dialog.locator('label').allTextContents()).map(value => value.trim()).filter(Boolean),
      placeholders: (await dialog.locator('input, textarea').evaluateAll(elements => elements.map(element => element.getAttribute('placeholder') ?? '').filter(Boolean))),
      inputs: await dialog.locator('input, textarea').evaluateAll(elements => elements.map(element => ({
        name: element.getAttribute('name'),
        placeholder: element.getAttribute('placeholder'),
        type: element.getAttribute('type') ?? element.tagName.toLowerCase()
      }))),
      comboboxValues: await dialog.getByRole('combobox').evaluateAll(elements => elements.map(element => (element as HTMLInputElement).value)),
      optionSets,
      buttonLabels: (await dialog.getByRole('button').allInnerTexts()).map(value => value.trim()).filter(Boolean)
    };
  }

  async fillOpenBankForm(input: TrustBeneficiaryTestData['bank']): Promise<void> {
    const dialog = this.bankDialog();
    await this.selectNamedInput(dialog, 'accountType', input.accountType);
    await this.selectNamedInput(dialog, 'currency', input.currency);
    await dialog.locator('input[name="bankAccount"]').fill(input.accountNumber);
    await dialog.locator('input[name="swiftCode"]').fill(input.swiftCode);
    await dialog.locator('input[name="bankName"]').fill(input.bankName);
    await dialog.locator('input[name="bankAddress"]').fill(input.bankAddress);
    await dialog.locator('input[name="address"]').fill(input.bankAddress);
    await dialog.locator('input[name="country"]').fill(input.country);
    await dialog.locator('input[name="stateProvince"]').fill(input.stateProvince);
    await dialog.locator('input[name="city"]').fill(input.city);
    await dialog.locator('input[name="postalCode"]').fill(input.postalCode);
    const defaultAccount = dialog.locator('input[name="isDefault"]');
    if (!await defaultAccount.isChecked()) await defaultAccount.check();
    await expect(dialog.locator('input[name="bankAccount"]')).toHaveValue(input.accountNumber);
    await expect(dialog.locator('input[name="bankName"]')).toHaveValue(input.bankName);
  }

  async submitBankAccountOnce(
    beneficiaryName: string,
    securityKey: string
  ): Promise<TrustBankAccountSubmissionResult> {
    if (this.bankSubmitCount !== 0) throw new Error('Bank Account Submit is limited to once per Run.');
    this.bankSubmitCount = 1;
    const observed: SafeTrustMutationEvidence[] = [];
    const listener = (response: Response) => {
      const url = new URL(response.url());
      if (url.origin !== new URL(this.page.url()).origin || !/bank|account|beneficiar|trust/i.test(url.pathname)) return;
      if (!['POST', 'PUT', 'PATCH'].includes(response.request().method())) return;
      observed.push({ path: url.pathname, status: response.status(), observedAt: new Date().toISOString() });
    };
    this.page.on('response', listener);
    let securityDialogObserved = false;
    try {
      await this.bankDialog().getByRole('button', { name: '添加账户', exact: true }).click();
      const next = await expect.poll(async () => {
        if (await this.securityKey.dialog.isVisible().catch(() => false)) return 'security';
        if (!await this.bankDialog().isVisible().catch(() => false)) return 'closed';
        return 'waiting';
      }, { timeout: 15_000, intervals: [250, 500, 1_000], message: 'Wait for Bank Account submit transition' })
        .not.toBe('waiting').then(() => this.securityKey.dialog.isVisible().then(value => value ? 'security' : 'closed'));
      if (next === 'security') {
        securityDialogObserved = true;
        await this.securityKey.fill(securityKey);
        await this.securityKey.verifyOnce();
      }
      await expect.poll(() => this.bankAccountCount(beneficiaryName), {
        timeout: 30_000, intervals: [500, 1_000, 2_000], message: 'Created Beneficiary Bank Account did not become visible.'
      }).toBe(1);
    } finally {
      this.page.off('response', listener);
    }
    const evidence = observed.find(item => /bank|account/i.test(item.path ?? '')) ?? observed.at(-1);
    return {
      recordVisible: true,
      bankAccountCount: await this.bankAccountCount(beneficiaryName),
      mutationResponseCount: observed.length,
      evidence,
      securityDialogObserved,
      securityVerificationCount: this.securityKey.verificationClickCount()
    };
  }

  async bankAccountCount(name: string): Promise<number> {
    const openAccountDialog = this.page.getByRole('dialog')
      .filter({ hasText: /银行账户/ })
      .filter({ hasText: name });
    if (await openAccountDialog.isVisible().catch(() => false)) {
      const dialogText = await openAccountDialog.innerText();
      const dialogCount = dialogText.match(/(\d+)\s*个账户/);
      if (dialogCount) return Number.parseInt(dialogCount[1], 10);
    }
    const text = await (await this.beneficiaryContainer(name)).innerText();
    return Number.parseInt(text.match(/(\d+)\s*个账户/)?.[1] ?? '0', 10);
  }

  async openBankAccounts(name: string): Promise<void> {
    const row = await this.beneficiaryContainer(name);
    const action = row.getByRole('button', { name: /\d+\s*个账户/ });
    await expect(action).toHaveCount(1);
    await action.click();
    await expect(this.page.getByRole('dialog').filter({ hasText: name }).filter({ hasText: /银行账户/ })).toBeVisible();
  }

  async matchOpenBankAccount(input: TrustBeneficiaryTestData['bank']): Promise<{
    bankName: boolean;
    accountNumber: boolean;
    currency: boolean;
  }> {
    const dialog = this.page.getByRole('dialog').filter({ hasText: input.accountHolder }).filter({ hasText: /银行账户/ });
    await expect(dialog).toBeVisible();
    const text = (await dialog.innerText()).replace(/\s+/g, ' ').trim();
    return {
      bankName: text.includes(input.bankName),
      accountNumber: text.includes(input.accountNumber) || text.includes(input.accountNumber.slice(-4)),
      currency: text.includes(input.currency)
    };
  }

  beneficiarySubmissionClicks(): number { return this.beneficiarySubmitCount; }
  bankSubmissionClicks(): number { return this.bankSubmitCount; }

  private beneficiaryDialog(): Locator {
    return this.page.getByRole('dialog').filter({ hasText: /添加受益人|新增受益人/ }).last();
  }

  private bankDialog(): Locator {
    return this.page.getByRole('dialog').filter({ hasText: /银行账户/ }).last();
  }

  private async selectNamedInput(scope: Locator, name: string, option: string): Promise<void> {
    const input = scope.locator(`input[name="${name}"]`);
    await expect(input).toHaveCount(1);
    const combobox = input.locator('..').getByRole('combobox');
    await expect(combobox).toHaveCount(1);
    await combobox.click();
    const semanticOption = this.page.getByRole('option', { name: option, exact: true });
    if (await semanticOption.count()) {
      await expect(semanticOption).toHaveCount(1);
      await semanticOption.click();
    } else {
      const visibleText = this.page.getByText(option, { exact: true }).filter({ visible: true });
      await expect(visibleText).toHaveCount(1);
      await visibleText.click();
    }
    await expect(combobox).toContainText(option);
  }

  private async visibleExactTextCount(value: string): Promise<number> {
    let count = 0;
    for (const match of await this.page.getByText(value, { exact: true }).all()) {
      if (await match.isVisible()) count += 1;
    }
    return count;
  }

  private async beneficiaryContainer(name: string): Promise<Locator> {
    const matches = this.page.getByText(name, { exact: true });
    await expect.poll(() => this.visibleExactTextCount(name)).toBe(1);
    let current = matches.filter({ visible: true }).first();
    for (let depth = 0; depth < 7; depth += 1) {
      if (await current.getByRole('button', { name: /添加账户|银行账户|查看详情|详情|管理/ }).count()) return current;
      current = current.locator('..');
    }
    throw new Error('Could not scope the unique Beneficiary record to its actions.');
  }
}
