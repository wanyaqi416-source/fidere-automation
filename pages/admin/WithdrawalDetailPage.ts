import { expect, type Locator, type Page } from '@playwright/test';

import { decimalFromText } from '../../src/utils/money';
import { WithdrawalApprovalPage } from './WithdrawalApprovalPage';
import { WithdrawalRejectReview } from './WithdrawalRejectReview';

export type AdminWithdrawalDetail = {
  requestedAmount: string;
  netAmount: string;
  customerText: string;
  accountType: string;
  beneficiaryText: string;
  purpose: string;
  submittedAt: string;
  feeAmount: string;
  status: string;
  adminTransactionId?: string;
};

export class WithdrawalDetailPage {
  readonly root: Locator;

  constructor(readonly page: Page) {
    const title = page.getByText(/出金审批|审批出金|出金详情/).first();
    this.root = page.locator('[role="presentation"], [role="dialog"]').filter({ has: title }).last();
  }

  async waitForOpen(): Promise<void> {
    await expect(this.root).toBeVisible();
    await expect(this.root.getByText('转账金额', { exact: true }).first()).toBeVisible();
    await expect(this.root.getByText('实际到账金额', { exact: true }).first()).toBeVisible();
  }

  async readDetail(): Promise<AdminWithdrawalDetail> {
    await this.waitForOpen();
    const text = (await this.root.innerText()).replace(/\u00a0/g, ' ');
    const adminTransactionId = text.match(/\bTXN-[A-Z0-9-]+\b/i)?.[0];
    return {
      requestedAmount: decimalFromText(
        await this.readLabeledValue('转账金额'),
        'Admin Withdrawal detail requested amount'
      ).abs().toString(),
      netAmount: decimalFromText(
        await this.readLabeledValue('实际到账金额'),
        'Admin Withdrawal detail net amount'
      ).abs().toString(),
      customerText: await this.readLabeledTextBlock('客户'),
      accountType: await this.readLabeledValue('账户类型'),
      beneficiaryText: await this.readLabeledValue('收款人'),
      purpose: await this.readLabeledValue('用途'),
      submittedAt: await this.readLabeledValue('申请时间'),
      feeAmount: decimalFromText(
        await this.readLabeledValue('出金服务费'),
        'Admin Withdrawal detail fee'
      ).abs().toString(),
      status: await this.readLabeledValue('状态'),
      adminTransactionId
    };
  }

  async readRequiredApprovalFields(): Promise<string[]> {
    const fields = [
      { name: '打款渠道', pattern: /^打款渠道/ },
      { name: '打款银行', pattern: /^打款银行/ },
      { name: '打款凭证', pattern: /上传打款凭证/ },
      { name: '审批备注', pattern: /^审批备注/ }
    ];
    const visible: string[] = [];
    for (const field of fields) {
      if (await this.root.getByText(field.pattern).first().isVisible()) visible.push(field.name);
    }
    return visible;
  }

  async availableFinalActions(): Promise<string[]> {
    const actions: string[] = [];
    for (const name of ['拒绝', '批准']) {
      if (await this.root.getByRole('button', { name, exact: true }).isVisible()) actions.push(name);
    }
    return actions;
  }

  approvalForm(): WithdrawalApprovalPage {
    return new WithdrawalApprovalPage(this.page, this.root);
  }

  rejectionReview(): WithdrawalRejectReview {
    return new WithdrawalRejectReview(this.page, this.root);
  }

  async containsBeneficiaryAccountSuffix(accountSuffix: string): Promise<boolean> {
    if (!accountSuffix.trim()) return false;
    const compactText = (await this.root.innerText()).replace(/\s/g, '');
    return compactText.includes(accountSuffix.replace(/\s/g, ''));
  }

  async readBeneficiaryBankIfPresent(): Promise<string | undefined> {
    for (const label of ['收款银行', '银行名称', '开户银行']) {
      if (await this.root.getByText(label, { exact: true }).count()) {
        return this.readLabeledValue(label);
      }
    }
    return undefined;
  }

  private async readLabeledValue(label: string): Promise<string> {
    const labelLocator = this.root.getByText(label, { exact: true }).first();
    await expect(labelLocator).toBeVisible();
    const parent = labelLocator.locator('..');
    const lines = (await parent.innerText())
      .split(/\r?\n/)
      .map(value => value.trim())
      .filter(value => value && value !== label);
    if (lines.length !== 1) {
      throw new Error(`Admin Withdrawal detail field “${label}” was not uniquely readable.`);
    }
    return lines[0];
  }

  private async readLabeledTextBlock(label: string): Promise<string> {
    const labelLocator = this.root.getByText(label, { exact: true }).first();
    await expect(labelLocator).toBeVisible();
    const labelText = (await labelLocator.innerText()).trim();
    const values = (await labelLocator.locator('..').innerText())
      .split(/\r?\n/)
      .map(value => value.trim())
      .filter(value => value && value !== labelText);
    if (values.length < 1) {
      throw new Error(`Admin Withdrawal detail field “${label}” did not contain readable text.`);
    }
    return values.join(' ');
  }
}
