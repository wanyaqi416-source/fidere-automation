import { expect, type Page, type Request } from '@playwright/test';
import { assertSandboxEnvironment } from '../../src/flow-engine';
import { maskSensitiveText } from '../../src/reporting/sensitive-data-mask';
import { Decimal } from '../../src/utils/money';
import { ManualFiatForm } from './ManualFiatForm';
import { assertManualWithdrawalAmount, decodeManualWithdrawalReceipt } from '../../src/withdrawal/admin-manual-withdrawal';

export type ManualWithdrawalInput = {
  email: string; displayName: string; accountType: string; currency: string;
  bankAccountSuffix: string; channel: string; amount: string; note: string;
};

export class ManualFiatWithdrawalPage {
  private confirmationOpenClicks = 0;
  private submissionClicks = 0;
  private checkedInput?: ManualWithdrawalInput;
  private readonly form: ManualFiatForm;
  private readonly network: { path: string; status: number; time: string }[] = [];

  constructor(readonly page: Page) { this.form = new ManualFiatForm(page); }

  async goto(baseURL: string): Promise<void> {
    assertSandboxEnvironment(baseURL);
    await this.page.goto(new URL('/zh-CN/operation/fiatAssets', baseURL).toString(), { waitUntil: 'domcontentloaded' });
    await expect(this.page.getByRole('button', { name: '手动出金', exact: true })).toBeVisible();
  }

  async openForm(): Promise<void> {
    await this.page.getByRole('button', { name: '手动出金', exact: true }).click();
    await expect(this.page.getByRole('heading', { name: '手动出金', exact: true })).toBeVisible();
  }

  async fillForm(input: ManualWithdrawalInput): Promise<{ fee: string; bankCandidateCount: number }> {
    assertManualWithdrawalAmount(input.amount);
    if (!/^[A-Z]{3}$/.test(input.currency) || !/^\d{4}$/.test(input.bankAccountSuffix) || !input.note.trim()) {
      throw new Error('Currency, existing bank suffix and audit note are required.');
    }
    await this.form.chooseCustomer(input.email, input.displayName);
    await this.form.chooseAccount(input.accountType);
    await this.selectOption('操作类型', '普通出金');
    await this.form.combobox('币种').click();
    const currency = this.page.getByRole('option').filter({ hasText: new RegExp('^' + input.currency + ' - ') });
    await expect(currency).toHaveCount(1);
    await currency.click();
    await this.selectOption('打款渠道', input.channel);
    await this.form.combobox('银行账号').click();
    const bank = this.page.getByRole('option')
      .filter({ hasText: new RegExp(input.bankAccountSuffix + '(?!\\d)') })
      .filter({ hasText: input.displayName });
    await expect(bank).toHaveCount(1);
    const bankCandidateCount = await bank.count();
    await bank.click();
    await this.page.getByRole('spinbutton', { name: '出金金额', exact: true }).fill(input.amount);
    await this.page.getByRole('textbox', { name: '备注说明', exact: true }).fill(input.note);
    await this.verifyForm(input);
    const fee = await this.readFee(input.currency);
    this.checkedInput = { ...input };
    return { fee, bankCandidateCount };
  }

  async readFee(currency: string): Promise<string> {
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Unsupported fee currency.');
    const row = this.page.getByText('出金手续费：', { exact: true }).locator('..');
    await expect(row).toContainText(new RegExp(currency + '\\s+\\d'));
    const match = (await row.innerText()).match(new RegExp(currency + '\\s+([\\d,.]+)'));
    if (!match) throw new Error('Current manual withdrawal fee is not readable.');
    const fee = new Decimal(match[1].replaceAll(',', ''));
    if (!fee.isFinite() || fee.isNegative()) throw new Error('Invalid displayed fee.');
    return fee.toString();
  }

  async openConfirmation(): Promise<void> {
    if (!this.checkedInput || this.confirmationOpenClicks) throw new Error('A validated form and one confirmation opening are required.');
    await this.verifyForm(this.checkedInput);
    this.confirmationOpenClicks++;
    await this.page.getByRole('button', { name: '确认出金', exact: true }).click();
    await this.verifyConfirmation();
  }

  async verifyConfirmation(): Promise<void> {
    if (!this.checkedInput) throw new Error('No verified manual withdrawal form.');
    const input = this.checkedInput;
    const dialog = this.confirmationDialog();
    await expect(dialog).toBeVisible();
    const text = await dialog.innerText();
    if (![input.email, input.displayName, input.bankAccountSuffix, input.note, '普通出金'].every(value => text.includes(value))) {
      throw new Error('Manual withdrawal confirmation does not match the selected customer, bank or audit note.');
    }
    const amountText = await dialog.getByRole('heading', { level: 6 }).innerText();
    const match = amountText.match(/^([A-Z]{3})\s+([\d,.]+)$/);
    if (!match || match[1] !== input.currency || !new Decimal(match[2].replaceAll(',', '')).equals(input.amount)) {
      throw new Error('Manual withdrawal confirmation currency or amount mismatch.');
    }
    await expect(dialog.getByRole('button', { name: '确认手动出金', exact: true })).toBeEnabled();
  }

  async cancelConfirmation(): Promise<void> {
    await this.confirmationDialog().getByRole('button', { name: '取消', exact: true }).click();
    await expect(this.confirmationDialog()).toBeHidden();
  }

  async confirmOnce(beforeClick: () => void): Promise<ReturnType<typeof decodeManualWithdrawalReceipt>> {
    assertSandboxEnvironment(this.page.url());
    if (process.env.ALLOW_MONEY_TESTS !== 'true' || process.env.ALLOW_ADMIN_MUTATION_TESTS !== 'true' ||
        this.submissionClicks || this.confirmationOpenClicks !== 1) {
      throw new Error('Manual withdrawal requires money/Admin authorization and one final submission only.');
    }
    await this.verifyConfirmation();
    beforeClick(); // Persist the attempt before the irreversible click, never after it.
    this.submissionClicks++;
    const responsePending = this.page.waitForResponse(response => this.isSubmissionRequest(response.request()), { timeout: 30_000 });
    const [response] = await Promise.all([
      responsePending,
      this.confirmationDialog().getByRole('button', { name: '确认手动出金', exact: true }).click()
    ]);
    this.network.push({ path: new URL(response.url()).pathname, status: response.status(), time: new Date().toISOString() });
    if (!response.ok()) throw new Error('Manual withdrawal HTTP result is unsuccessful; do not resubmit.');
    const receipt = decodeManualWithdrawalReceipt(await response.json());
    if (!receipt.accepted) throw new Error('MANUAL_WITHDRAWAL_SUBMISSION_UNCONFIRMED: no recognized business receipt; read-only reconciliation required.');
    await expect(this.page.getByRole('alert').filter({ hasText: '手动出金成功' })).toBeVisible({ timeout: 15_000 });
    await expect(this.confirmationDialog()).toBeHidden();
    await expect(this.page.getByRole('heading', { name: '手动出金', exact: true })).toBeHidden();
    return receipt;
  }

  isSubmissionRequest(request: Request): boolean {
    const url = new URL(request.url());
    return request.method() === 'POST' && url.origin === new URL(this.page.url()).origin &&
      /^\/(?:admin-api|api)\/operation\/fiat\/manual-withdraw$/.test(url.pathname);
  }

  counts() { return { confirmationOpenClicks: this.confirmationOpenClicks, finalConfirmationClicks: this.submissionClicks }; }
  safeNetworkEvidence() { return [...this.network]; }
  async readSafeConfirmation(): Promise<string> { return maskSensitiveText(await this.confirmationDialog().ariaSnapshot()); }

  private confirmationDialog() { return this.page.getByRole('dialog', { name: '确认手动出金', exact: true }); }

  private async verifyForm(input: ManualWithdrawalInput): Promise<void> {
    await expect(this.form.combobox('选择账户')).toHaveText(input.accountType);
    await expect(this.form.combobox('操作类型')).toHaveText('普通出金');
    await expect(this.form.combobox('币种')).toHaveText(new RegExp('^' + input.currency + ' - '));
    await expect(this.form.combobox('打款渠道')).toHaveText(input.channel);
    const customer = await this.page.getByRole('combobox', { name: '选择客户', exact: true }).inputValue();
    const bank = await this.form.combobox('银行账号').innerText();
    const accepted = await this.page.getByRole('spinbutton', { name: '出金金额', exact: true }).inputValue();
    const note = await this.page.getByRole('textbox', { name: '备注说明', exact: true }).inputValue();
    if (!customer.includes(input.email) || !customer.includes(input.displayName) || !bank.includes(input.bankAccountSuffix) ||
        !bank.includes(input.displayName) || !new Decimal(accepted).equals(input.amount) || note !== input.note) {
      throw new Error('Selected manual withdrawal form values changed or were not accepted.');
    }
  }

  private async selectOption(label: string, value: string): Promise<void> {
    await this.form.combobox(label).click();
    const option = this.page.getByRole('option', { name: value, exact: true });
    await expect(option).toHaveCount(1);
    await option.click();
  }
}
