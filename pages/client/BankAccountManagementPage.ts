import { expect, type Locator, type Page, type Response } from '@playwright/test';

import { ClientSettingsPage } from './ClientSettingsPage';
import { SecurityKeyDialog, type SecurityKeyDomStructure } from './SecurityKeyDialog';

export type SandboxBankAccountInput = {
  accountHolderName: string;
  beneficiaryCountry: string;
  city: string;
  address: string;
  bankCountry: string;
  bankName: string;
  bankAddress: string;
  bankAccount: string;
  swiftCode: string;
};

export type BankAccountSubmissionEvidence = {
  requestPath?: string;
  httpStatus?: number;
  observedAt?: string;
  accountSuffix: string;
};

type SafeResponse = {
  path: string;
  status: number;
  observedAt: string;
};

export class BankAccountManagementPage {
  readonly securityKey: SecurityKeyDialog;
  private formSubmitClickCount = 0;
  private businessConfirmationClickCount = 0;

  constructor(readonly page: Page) {
    this.securityKey = new SecurityKeyDialog(page);
  }

  async gotoFromProfileMenu(baseURL: string): Promise<void> {
    await new ClientSettingsPage(this.page).gotoFromProfileMenu(baseURL);

    const bankAccountManagement = this.page.getByRole('button', {
      name: '银行账户管理',
      exact: true
    });
    await expect(bankAccountManagement).toBeVisible();
    await bankAccountManagement.click();
    await expect(this.page.getByRole('heading', {
      name: '银行账户管理',
      exact: true
    })).toBeVisible();
  }

  async openAddForm(): Promise<void> {
    const add = this.page.getByRole('button', { name: '添加银行账户', exact: true });
    await expect(add).toBeVisible();
    await add.click();
    await expect(this.dialog).toBeVisible();
    await expect(this.dialog.getByRole('heading', {
      name: '添加银行账户',
      exact: true
    })).toBeVisible();
  }

  async fill(input: SandboxBankAccountInput): Promise<void> {
    await this.fillText('请输入收款人', input.accountHolderName);
    await this.selectAutocomplete('请选择国家/地区', input.beneficiaryCountry);
    await this.fillText('请输入城市', input.city);
    await this.fillText('请输入地址', input.address);
    await this.selectAutocomplete('请选择银行所在地 - 国家', input.bankCountry);
    await this.fillText('请输入银行名称', input.bankName);
    await this.fillText('请输入银行地址', input.bankAddress);
    await this.fillText('请输入账号', input.bankAccount);
    await this.fillText('请输入SWIFT代码', input.swiftCode);
  }

  async expectFilled(input: SandboxBankAccountInput): Promise<void> {
    await expect(this.dialog.getByPlaceholder('请输入收款人', { exact: true }))
      .toHaveValue(input.accountHolderName);
    await expect(this.dialog.getByPlaceholder('请选择国家/地区', { exact: true }))
      .toHaveValue(input.beneficiaryCountry);
    await expect(this.dialog.getByPlaceholder('请输入城市', { exact: true }))
      .toHaveValue(input.city);
    await expect(this.dialog.getByPlaceholder('请输入地址', { exact: true }))
      .toHaveValue(input.address);
    await expect(this.dialog.getByPlaceholder('请选择银行所在地 - 国家', { exact: true }))
      .toHaveValue(input.bankCountry);
    await expect(this.dialog.getByPlaceholder('请输入银行名称', { exact: true }))
      .toHaveValue(input.bankName);
    await expect(this.dialog.getByPlaceholder('请输入银行地址', { exact: true }))
      .toHaveValue(input.bankAddress);
    await expect(this.dialog.getByPlaceholder('请输入账号', { exact: true }))
      .toHaveValue(input.bankAccount);
    await expect(this.dialog.getByPlaceholder('请输入SWIFT代码', { exact: true }))
      .toHaveValue(input.swiftCode);
  }

  async openSecurityKeyDialogOnce(): Promise<SecurityKeyDomStructure> {
    if (this.formSubmitClickCount !== 0) {
      throw new Error('Client bank account form Submit may be clicked only once per Run.');
    }
    const formDialog = this.dialog;
    this.formSubmitClickCount += 1;
    await formDialog.getByRole('button', { name: '提交', exact: true }).click();
    await this.securityKey.waitForOpen();
    return this.securityKey.readDomStructure();
  }

  async openVerificationAfterSecurityKeySetupOnce(
    input: SandboxBankAccountInput
  ): Promise<SecurityKeyDomStructure> {
    if (this.formSubmitClickCount !== 1 || this.securityKey.setupActionClickCount() === 0) {
      throw new Error('A second bank-account form Submit is allowed only after bounded Security Key setup.');
    }
    if (await this.isAccountVisible(input.bankAccount, input.bankName)) {
      throw new Error('The bank account became visible during Security Key setup; do not submit it again.');
    }

    if (await this.dialog.isVisible().catch(() => false)) {
      await this.expectFilled(input);
    } else {
      await this.openAddForm();
      await this.fill(input);
      await this.expectFilled(input);
    }

    this.formSubmitClickCount += 1;
    await this.dialog.getByRole('button', { name: '提交', exact: true }).click();
    await this.securityKey.waitForOpen();
    if (!await this.securityKey.isVerificationStep()) {
      throw new Error('Security Key setup completed, but the next bank-account Submit did not open verification.');
    }
    return this.securityKey.readDomStructure();
  }

  async closeSecurityKeyWithoutVerifying(): Promise<void> {
    await this.securityKey.closeWithoutVerifying();
  }

  async fillSecurityKey(securityKey: string): Promise<void> {
    if (!await this.securityKey.isVerificationStep()) {
      throw new Error('The current Security Key dialog is not at the verification step.');
    }
    if (this.businessConfirmationClickCount !== 0) {
      throw new Error('Client bank-account business confirmation is limited to once per Run.');
    }
    this.businessConfirmationClickCount = 1;
    await this.securityKey.fill(securityKey);
  }

  async verifySecurityKeyOnce(
    input: SandboxBankAccountInput
  ): Promise<BankAccountSubmissionEvidence> {
    if (this.formSubmitClickCount !== 1) {
      throw new Error('Client bank account Security Key verification requires one form Submit.');
    }
    if (this.securityKey.verificationClickCount() !== 0) {
      throw new Error('Client bank account Security Key verification is limited to once per Run.');
    }

    const observed: SafeResponse[] = [];
    const origin = new URL(this.page.url()).origin;
    const listener = (response: Response): void => {
      const url = new URL(response.url());
      if (url.origin !== origin || !url.pathname.startsWith('/api/')) return;
      if (!['POST', 'PUT', 'PATCH'].includes(response.request().method())) return;
      observed.push({
        path: url.pathname,
        status: response.status(),
        observedAt: new Date().toISOString()
      });
    };

    this.page.on('response', listener);
    try {
      await this.securityKey.verifyOnce();
      await this.expectAccountVisible(input.bankAccount, input.bankName);
    } finally {
      this.page.off('response', listener);
    }

    const relevant = observed.find(item => /bank|fiat|account|beneficiar|address/i.test(item.path))
      ?? observed.at(-1);
    return {
      requestPath: relevant?.path,
      httpStatus: relevant?.status,
      observedAt: relevant?.observedAt,
      accountSuffix: input.bankAccount.slice(-4)
    };
  }

  async expectAccountVisible(bankAccount: string, bankName: string): Promise<void> {
    const suffix = bankAccount.slice(-4);
    const main = this.page.locator('main');
    await expect.poll(async () => {
      const text = (await main.innerText()).replace(/\s+/g, ' ');
      return text.includes(bankName) && text.includes(suffix);
    }, {
      timeout: 30_000,
      intervals: [500, 1_000, 2_000],
      message: 'Submitted bank account did not appear in Client bank account management.'
    }).toBe(true);
  }

  async isAccountVisible(bankAccount: string, bankName: string): Promise<boolean> {
    const suffix = bankAccount.slice(-4);
    const mainText = (await this.page.locator('main').innerText()).replace(/\s+/g, ' ');
    return mainText.includes(bankName) && mainText.includes(suffix);
  }

  async readAccountStatus(bankAccount: string, bankName: string): Promise<string | undefined> {
    if (!await this.isAccountVisible(bankAccount, bankName)) return undefined;
    const statuses: Array<{ canonical: string; labels: string[] }> = [
      { canonical: '已批准', labels: ['已批准', '审核通过', '已通过'] },
      { canonical: '待审核', labels: ['待审核', '审核中'] },
      { canonical: '已拒绝', labels: ['已拒绝'] }
    ];
    for (const status of statuses) {
      for (const label of status.labels) {
        for (const match of await this.page.getByText(label, { exact: false }).all()) {
          if (await match.isVisible()) return status.canonical;
        }
      }
    }
    return undefined;
  }

  submissionClicks(): number {
    return this.businessConfirmationClickCount;
  }

  formSubmitClicks(): number {
    return this.formSubmitClickCount;
  }

  securityVerificationClicks(): number {
    return this.securityKey.verificationClickCount();
  }

  private get dialog(): Locator {
    return this.page.getByRole('dialog').last();
  }

  private async fillText(placeholder: string, value: string): Promise<void> {
    const input = this.dialog.getByPlaceholder(placeholder, { exact: true });
    await expect(input).toBeVisible();
    await input.fill(value);
    await expect(input).toHaveValue(value);
  }

  private async selectAutocomplete(placeholder: string, option: string): Promise<void> {
    const input = this.dialog.getByPlaceholder(placeholder, { exact: true });
    await expect(input).toBeVisible();
    await input.click();
    const listbox = this.page.getByRole('listbox').last();
    await expect(listbox).toBeVisible();
    const match = listbox.getByRole('option', { name: option, exact: true });
    await expect(match).toHaveCount(1);
    await match.click();
    await expect(listbox).toBeHidden();
    await expect(input).toHaveValue(option);
  }
}
