import { expect, type Locator, type Page } from '@playwright/test';

import { clientDepositIdPattern } from '../../src/deposit/deposit-e2e';
import { decimalFromText } from '../../src/utils/money';
import { clientWithdrawalIdPattern } from '../../src/withdrawal/withdrawal-e2e';

export type FiatDepositDetail = {
  ledgerTransactionId: string;
  displayedTransactionNumber: string;
  transactionType: string;
  accountType: string;
  currency: string;
  amount: string;
  feeAmount: string;
  status: string;
  createdAt: string;
  reviewedAt: string;
};

export type FiatWithdrawalDetail = {
  clientWithdrawalId: string;
  transactionType: string;
  accountType: string;
  currency: string;
  requestedAmount: string;
  feeAmount: string;
  status: string;
  createdAt: string;
  reviewedAt: string;
};

export class TransactionDetailDrawer {
  readonly title: Locator;
  readonly root: Locator;
  readonly withdrawalTitle: Locator;
  readonly withdrawalRoot: Locator;

  constructor(
    readonly page: Page,
    private readonly selectedLedgerTransactionId: string
  ) {
    this.title = page.getByText('法币转入 详情', { exact: true });
    this.root = page.locator('[role="presentation"]').filter({ has: this.title }).last();
    this.withdrawalTitle = page.getByText('法币转出 详情', { exact: true });
    this.withdrawalRoot = page
      .locator('[role="presentation"]')
      .filter({ has: this.withdrawalTitle })
      .last();
  }

  async waitForOpen(): Promise<void> {
    await expect(this.title).toBeVisible();
    await expect(this.root).toBeVisible();
    await expect(this.root.getByText('详情', { exact: true })).toBeVisible();
  }

  async readUserTransferDetail() {
    const title = this.page.getByText('用户转账详情', { exact: true });
    const root = this.page.locator('[role="presentation"]').filter({ has: title }).last();
    await expect(title).toBeVisible();
    await expect(root).toContainText(/TRF-[A-Z0-9-]+/i);
    const readField = async (label: string) => {
      const field = root.getByText(label, { exact: true });
      await expect(field).toHaveCount(1);
      const parent = await field.locator('..').innerText();
      return parent.slice(parent.indexOf(label) + label.length).trim();
    };
    const text = await root.innerText();
    const orderId = await readField('订单编号');
    const ledgerId = await readField('交易编号');
    if (!/^TRF-[A-Z0-9-]+$/i.test(orderId) || ledgerId !== this.selectedLedgerTransactionId) {
      throw new Error('U2U detail identifiers do not match the selected ledger.');
    }
    const fee = text.match(/手续费\s*[:：]\s*([\d,]+(?:\.\d+)?)\s+([A-Z][A-Z0-9_]*)/);
    const status = text.match(/已完成|已拒绝|审核中|处理中|待审核|待处理|失败/)?.[0];
    if (!fee || !status) throw new Error('U2U detail fee/status unreadable.');
    const regions: string[] = [];
    for (const label of await root.getByText('账户地区', { exact: true }).all()) {
      regions.push((await label.locator('..').innerText()).replace('账户地区', '').trim());
    }
    return { orderId, ledgerTransactionId: ledgerId, status,
      fee: decimalFromText(fee[1], 'U2U detail fee').toFixed(), feeCurrency: fee[2],
      recipient: await readField('收款邮箱'), regions, createdAt: await readField('申请时间') };
  }

  async readFiatDepositDetail(): Promise<FiatDepositDetail> {
    await this.waitForOpen();
    if (!clientWithdrawalIdPattern.test(this.selectedLedgerTransactionId)) {
      throw new Error('Selected Client Deposit record did not contain a valid TXN identifier.');
    }

    const text = (await this.root.innerText()).replace(/\u00a0/g, ' ');
    const amountMatch = text.match(/([+-]?)\s*([\d,]+(?:\.\d+)?)\s*\n+\s*([A-Z]{3})\b/);
    const feeMatch = text.match(/手续费\s*:\s*([\d,]+(?:\.\d+)?)\s*([A-Z]{3})\b/);
    const status = text.match(/待处理|处理中|已完成|完成|成功|已拒绝|拒绝/)?.[0];
    if (!amountMatch || !feeMatch || !status) {
      throw new Error('Client Deposit detail summary fields could not be parsed.');
    }

    const detailsSection = this.root.getByText('详情', { exact: true }).locator('..');
    const displayedTransactionNumber = await this.readLabeledValue(
      detailsSection,
      '交易编号'
    );

    return {
      ledgerTransactionId: this.selectedLedgerTransactionId,
      displayedTransactionNumber,
      transactionType: '法币转入',
      accountType: await this.readLabeledValue(detailsSection, '账户类型'),
      currency: amountMatch[3],
      amount: decimalFromText(amountMatch[2], 'Client Deposit detail amount').toString(),
      feeAmount: decimalFromText(feeMatch[1], 'Client Deposit detail fee').toString(),
      status,
      createdAt: await this.readLabeledValue(detailsSection, '创建日期'),
      reviewedAt: await this.readLabeledValue(detailsSection, '审核时间')
    };
  }

  async waitForWithdrawalOpen(): Promise<void> {
    await expect(this.withdrawalTitle).toBeVisible();
    await expect(this.withdrawalRoot).toBeVisible();
    await expect(this.withdrawalRoot.getByText('指示详情', { exact: true })).toBeVisible();
  }

  async readFiatWithdrawalDetail(): Promise<FiatWithdrawalDetail> {
    await this.waitForWithdrawalOpen();
    if (!clientDepositIdPattern.test(this.selectedLedgerTransactionId)) {
      throw new Error('Selected Client Withdrawal record did not contain a valid TXN identifier.');
    }

    const text = (await this.withdrawalRoot.innerText()).replace(/\u00a0/g, ' ');
    const amountMatch = text.match(/-\s*([\d,]+(?:\.\d+)?)\s+([A-Z]{3})\b/);
    const feeMatch = text.match(/手续费\s*:\s*([\d,]+(?:\.\d+)?)\s*([A-Z]{3})\b/);
    const status = text.match(/待处理|处理中|已完成|完成|成功|已拒绝|拒绝/)?.[0];
    if (!amountMatch || !feeMatch || !status) {
      throw new Error('Client Withdrawal detail summary fields could not be parsed.');
    }

    const detailsSection = this.withdrawalRoot.getByText('指示详情', { exact: true }).locator('..');
    const displayedTransactionId = await this.readLabeledValue(detailsSection, '交易编号');
    if (displayedTransactionId !== this.selectedLedgerTransactionId) {
      throw new Error('Client Withdrawal list TXN and detail TXN do not match.');
    }

    return {
      clientWithdrawalId: displayedTransactionId,
      transactionType: '法币转出',
      accountType: await this.readLabeledValue(detailsSection, '账户类型'),
      currency: amountMatch[2],
      requestedAmount: decimalFromText(
        amountMatch[1],
        'Client Withdrawal detail amount'
      ).toString(),
      feeAmount: decimalFromText(
        feeMatch[1],
        'Client Withdrawal detail fee'
      ).toString(),
      status,
      createdAt: await this.readLabeledValue(detailsSection, '创建日期'),
      reviewedAt: await this.readLabeledValue(detailsSection, '审核时间')
    };
  }

  async readFiatWithdrawalVisibleText(): Promise<string> {
    await this.waitForWithdrawalOpen();
    return (await this.withdrawalRoot.innerText()).replace(/\u00a0/g, ' ').trim();
  }

  private async readLabeledValue(scope: Locator, label: string): Promise<string> {
    const labelLocator = scope.getByText(label, { exact: true }).first();
    await expect(labelLocator).toBeVisible();
    const values = (await labelLocator.locator('..').locator('p').allInnerTexts())
      .map(value => value.trim())
      .filter(value => value && value !== label);
    if (values.length !== 1) {
      throw new Error(`Client transaction detail field ${label} was not uniquely readable.`);
    }
    return values[0];
  }
}
