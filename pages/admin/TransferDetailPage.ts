import { expect, type Locator, type Page } from '@playwright/test';

import {
  matchesAdminCustomerIdentity,
  transferAccountsMatch,
  type TransferFingerprint
} from '../../src/transfer/transfer-e2e';
import { Decimal, decimalFromText } from '../../src/utils/money';
import type { TransferListPage } from './TransferListPage';

export type AdminTransferDetail = {
  adminTransactionId: string;
  recordType: string;
  userIdentity: string;
  recipientIdentity?: string;
  sourceAccountType: string;
  targetAccountType: string;
  currency: string;
  amount: string;
  fee?: string;
  receivedAmount?: string;
  status: string;
  createdAtText?: string;
  createdAtMs?: number;
};

const currencyCodePattern = /[A-Z][A-Z0-9_]{2,20}/;

export class TransferDetailPage {
  private detailScope?: Locator;

  constructor(readonly page: Page) {}

  async openFromList(
    listPage: TransferListPage,
    adminTransactionId: string
  ): Promise<void> {
    const row = await listPage.rowByAdminTransactionId(adminTransactionId);
    const detailButton = row.getByRole('button', { name: /查看详情|详情|审核/ });
    await expect(
      detailButton,
      `Admin Transfer ${adminTransactionId} must expose exactly one details/review action.`
    ).toHaveCount(1);
    await detailButton.click();
    this.detailScope = await this.resolveDetailScope(adminTransactionId);
    await expect(this.detailScope).toBeVisible();
  }

  async readDetail(): Promise<AdminTransferDetail> {
    const scope = this.requireScope();
    const fullText = await scope.innerText();
    const adminTransactionId = fullText.match(/\bTXN-[A-Z0-9-]+\b/i)?.[0];
    if (!adminTransactionId) {
      throw new Error('Admin Transfer details did not display a real TXN identifier.');
    }

    const amountText = await this.readLabeledValue(['转账金额', '申请金额', '金额']);
    const currencyText = await this.readLabeledValue(['币种'], false);
    const currency = currencyText.match(currencyCodePattern)?.[0] ??
      amountText.match(currencyCodePattern)?.[0];
    if (!currency) {
      throw new Error(`Admin Transfer ${adminTransactionId} details did not display a currency.`);
    }

    const createdAtText = await this.readLabeledValue(
      ['提交时间', '创建时间', '申请时间'],
      false
    );
    return {
      adminTransactionId,
      recordType: await this.readLabeledValue(['记录类型', '转账类型', '类型']),
      userIdentity: await this.readLabeledTextBlock(['转出客户', '客户', '用户']),
      recipientIdentity: await this.readLabeledTextBlock(['收款人邮箱', '收款邮箱', '收款人', '收款客户'], false),
      sourceAccountType: await this.readLabeledValue(['转出账户', '来源账户']),
      targetAccountType: await this.readLabeledValue(['转入账户', '收款账户', '目标账户']),
      currency,
      amount: decimalFromText(amountText, 'Admin Transfer detail amount').toString(),
      fee: await this.readOptionalDecimal(['手续费']),
      receivedAmount: await this.readOptionalDecimal(['实际到账金额', '到账金额']),
      status: await this.readLabeledValue(['当前状态', '状态']),
      createdAtText: createdAtText || undefined,
      createdAtMs: createdAtText ? this.parseDisplayedDate(createdAtText) : undefined
    };
  }

  async expectMatchesFingerprint(
    fingerprint: TransferFingerprint,
    postSubmissionWindowMs: number
  ): Promise<AdminTransferDetail> {
    const detail = await this.readDetail();
    expect(matchesAdminCustomerIdentity(detail.userIdentity, fingerprint.userIdentity)).toBe(true);
    expect(transferAccountsMatch(detail.sourceAccountType, fingerprint.sourceAccountType)).toBe(true);
    expect(transferAccountsMatch(detail.targetAccountType, fingerprint.targetAccountType)).toBe(true);
    expect(detail.currency.toUpperCase()).toBe(fingerprint.currency.toUpperCase());
    expect(new Decimal(detail.amount).equals(new Decimal(fingerprint.amount))).toBe(true);
    expect(this.normalized(detail.status)).toBe(this.normalized(fingerprint.adminStatus));
    if (detail.createdAtMs !== undefined) {
      expect(detail.createdAtMs).toBeGreaterThanOrEqual(fingerprint.runStartedAtMs);
      expect(detail.createdAtMs).toBeLessThanOrEqual(
        fingerprint.clientSubmittedAtMs + postSubmissionWindowMs
      );
    }
    return detail;
  }

  async expectRejectActionAvailable(): Promise<void> {
    await expect(this.rejectButton()).toBeVisible();
  }

  async expectApproveActionAvailable(): Promise<void> {
    await expect(this.approveButton()).toBeVisible();
  }

  rejectButton(): Locator {
    return this.requireScope().getByRole('button', { name: '拒绝', exact: true });
  }

  approveButton(): Locator {
    return this.requireScope().getByRole('button', { name: '批准', exact: true });
  }

  scope(): Locator {
    return this.requireScope();
  }

  async close(): Promise<void> {
    const scope = this.requireScope();
    const closeButton = scope.getByRole('button', { name: '关闭', exact: true });
    await expect(closeButton).toHaveCount(1);
    await closeButton.click();
    await expect(scope).toBeHidden();
    this.detailScope = undefined;
  }

  private async resolveDetailScope(adminTransactionId: string): Promise<Locator> {
    const dialogs = this.page
      .getByRole('dialog')
      .filter({ has: this.page.getByText(adminTransactionId, { exact: true }) });
    for (const dialog of await dialogs.all()) {
      if (await dialog.isVisible()) {
        return dialog;
      }
    }

    const detailTitles = await this.page
      .getByText(/^资金互转(?:详情|审核)$/)
      .all();
    for (const title of detailTitles) {
      if (!(await title.isVisible())) {
        continue;
      }
      let container = title;
      for (let level = 0; level < 8; level += 1) {
        container = container.locator('..');
        const text = await container.innerText();
        if (
          text.includes(adminTransactionId) &&
          /转出账户|来源账户/.test(text) &&
          /转入账户|收款账户|目标账户/.test(text)
        ) {
          return container;
        }
      }
    }

    const idLabels = await this.page.getByText(adminTransactionId, { exact: true }).all();
    for (const idLabel of idLabels) {
      if (!(await idLabel.isVisible())) {
        continue;
      }
      if (await idLabel.evaluate(element => Boolean(element.closest('table')))) {
        continue;
      }
      let container = idLabel;
      for (let level = 0; level < 8; level += 1) {
        container = container.locator('..');
        const text = await container.innerText();
        if (/转出账户|来源账户/.test(text) && /转入账户|收款账户|目标账户/.test(text)) {
          return container;
        }
      }
    }

    throw new Error(`Admin Transfer ${adminTransactionId} details container was not found.`);
  }

  private async readLabeledValue(labels: readonly string[], required = true): Promise<string> {
    const scope = this.requireScope();
    for (const label of labels) {
      const locators = await scope.getByText(label, { exact: true }).all();
      for (const locator of locators) {
        if (!(await locator.isVisible())) {
          continue;
        }
        const values = (await locator.locator('..').locator('p, span, div').allTextContents())
          .map(value => value.trim())
          .filter(Boolean)
          .filter(value => value !== label);
        const unique = [...new Set(values)].filter(value => !labels.includes(value));
        if (unique.length === 1) {
          return unique[0];
        }

        const lines = (await locator.locator('..').innerText())
          .split(/\r?\n/)
          .map(value => value.trim())
          .filter(Boolean)
          .filter(value => value !== label);
        if (lines.length === 1) {
          return lines[0];
        }
      }
    }

    if (!required) {
      return '';
    }
    throw new Error(`Admin Transfer details did not provide a unique field: ${labels.join(' / ')}`);
  }

  private async readLabeledTextBlock(labels: readonly string[], required = true): Promise<string> {
    const scope = this.requireScope();
    for (const label of labels) {
      for (const locator of await scope.getByText(label, { exact: true }).all()) {
        if (!(await locator.isVisible())) {
          continue;
        }
        const lines = (await locator.locator('..').innerText())
          .split(/\r?\n/)
          .map(value => value.trim())
          .filter(Boolean)
          .filter(value => value !== label);
        if (lines.length > 0) {
          return lines.join(' ');
        }
      }
    }

    if (!required) return '';
    throw new Error(`Admin Transfer details did not provide a text block: ${labels.join(' / ')}`);
  }

  private async readOptionalDecimal(labels: readonly string[]): Promise<string | undefined> {
    const value = await this.readLabeledValue(labels, false);
    return value && /\d/.test(value)
      ? decimalFromText(value, `Admin Transfer ${labels[0]}`).toString()
      : undefined;
  }

  private requireScope(): Locator {
    if (!this.detailScope) {
      throw new Error('Admin Transfer details must be opened before reading or reviewing.');
    }
    return this.detailScope;
  }

  private parseDisplayedDate(value: string): number {
    const timestamp = Date.parse(value.trim().replace(/\//g, '-').replace(' ', 'T'));
    if (!Number.isFinite(timestamp)) {
      throw new Error('Admin Transfer detail time could not be normalized.');
    }
    return timestamp;
  }

  private normalized(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  }
}
