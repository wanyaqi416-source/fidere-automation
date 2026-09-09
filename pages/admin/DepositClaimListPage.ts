import { createHash } from 'node:crypto';

import { expect, type Locator, type Page } from '@playwright/test';

import type { AdminDepositCandidate } from '../../src/deposit/deposit-e2e';
import { decimalFromText } from '../../src/utils/money';

const headerAliases = {
  submittedAt: ['提交时间'],
  accountType: ['账户类型'],
  amount: ['币种/金额'],
  actualAmount: ['实际入账金额'],
  payer: ['付款人'],
  channel: ['渠道'],
  reference: ['参考号'],
  matchedCustomer: ['匹配客户'],
  matchStatus: ['匹配状态'],
  status: ['状态'],
  operation: ['操作']
} as const;

export class DepositClaimListPage {
  readonly table: Locator;

  constructor(readonly page: Page) {
    this.table = page.getByRole('table').first();
  }

  async goto(baseURL: string): Promise<void> {
    const url = new URL(baseURL);
    url.pathname = '/zh-CN/operation/fiatAssets';
    url.search = '';
    await this.page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await expect(this.page).not.toHaveURL(/\/login|\/signin|\/sign-in/i);
    const tab = this.page.getByText('入账认领', { exact: true }).first();
    await expect(tab).toBeVisible();
    await tab.click();
    await expect(this.table).toBeVisible();
    await expect(this.table.getByRole('columnheader', { name: '提交时间' })).toBeVisible();
  }

  async readStatusOptions(): Promise<string[]> {
    return this.readOptions(await this.filterCombobox(/^状态$/));
  }

  async readMatchStatusOptions(): Promise<string[]> {
    return this.readOptions(await this.filterCombobox(/^匹配状态$/));
  }

  async applyFilters(filters: {
    status?: string;
    matchStatus?: string;
    keyword?: string;
  }): Promise<void> {
    if (filters.status) {
      await this.selectOption(await this.filterCombobox(/^状态$/), filters.status);
    }
    if (filters.matchStatus) {
      await this.selectOption(await this.filterCombobox(/^匹配状态$/), filters.matchStatus);
    }
    if (filters.keyword) {
      await this.page.getByPlaceholder('参考号、付款人、备注...').fill(filters.keyword);
    }

    await this.page.getByRole('button', { name: '查询', exact: true }).click();
    await expect(this.table).toBeVisible();
    if (filters.status) {
      await expect.poll(async () => {
        const records = await this.readCurrentPageRecords();
        return records.length === 0 || records.every(record => record.status === filters.status);
      }).toBe(true);
    }
  }

  async readCurrentPageRecords(): Promise<AdminDepositCandidate[]> {
    const headers = (await this.table.getByRole('columnheader').allTextContents())
      .map(value => value.trim());
    const records: AdminDepositCandidate[] = [];
    for (const row of await this.table.getByRole('row').all()) {
      const cellCount = await row.getByRole('cell').count();
      if (cellCount === 0 || cellCount < headers.length) continue;
      records.push(await this.readRow(row, headers));
    }
    return records;
  }

  async readAllFilteredRecords(maxPages = 100): Promise<AdminDepositCandidate[]> {
    await this.goToFirstPage();
    const records: AdminDepositCandidate[] = [];
    const visitedPages = new Set<string>();

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const current = await this.readCurrentPageRecords();
      const signature = current.map(record => record.recordKey).join('|');
      if (visitedPages.has(signature)) break;
      visitedPages.add(signature);
      records.push(...current);

      const nextButton = await this.paginationButton('next');
      if (!nextButton || await nextButton.isDisabled()) break;
      await nextButton.click();
      await expect.poll(async () =>
        (await this.readCurrentPageRecords()).map(record => record.recordKey).join('|')
      ).not.toBe(signature);
    }

    return records;
  }

  async rowForRecord(record: AdminDepositCandidate): Promise<Locator> {
    await this.goToFirstPage();
    for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
      const headers = (await this.table.getByRole('columnheader').allTextContents())
        .map(value => value.trim());
      for (const row of await this.table.getByRole('row').all()) {
        if ((await row.getByRole('cell').count()) === 0) continue;
        const parsed = await this.readRow(row, headers);
        if (parsed.recordKey === record.recordKey) return row;
      }

      const nextButton = await this.paginationButton('next');
      if (!nextButton || await nextButton.isDisabled()) break;
      const before = (await this.readCurrentPageRecords()).map(item => item.recordKey).join('|');
      await nextButton.click();
      await expect.poll(async () =>
        (await this.readCurrentPageRecords()).map(item => item.recordKey).join('|')
      ).not.toBe(before);
    }
    throw new Error('Admin Deposit candidate row was no longer present in the filtered list.');
  }

  async expectClaimAndRejectActions(record: AdminDepositCandidate): Promise<void> {
    const row = await this.rowForRecord(record);
    await expect(row.getByRole('button', { name: '认领', exact: true })).toHaveCount(1);
    await expect(row.getByRole('button', { name: '拒绝', exact: true })).toHaveCount(1);
  }

  private async readRow(row: Locator, headers: readonly string[]): Promise<AdminDepositCandidate> {
    const cells = row.getByRole('cell');
    const read = async (aliases: readonly string[]): Promise<string> => {
      const index = headers.findIndex(header => aliases.includes(header));
      if (index < 0) throw new Error(`Admin Deposit list is missing column: ${aliases.join(' / ')}`);
      return (await cells.nth(index).innerText()).trim();
    };

    const submittedAtText = await read(headerAliases.submittedAt);
    const amountText = await read(headerAliases.amount);
    const actualAmountText = await read(headerAliases.actualAmount);
    const currency = amountText.match(/\b[A-Z]{3}\b/)?.[0];
    if (!currency) throw new Error('Admin Deposit row did not display a currency code.');
    const submittedAtMs = this.parseAdminTime(submittedAtText);
    const accountType = await read(headerAliases.accountType);
    const requestedAmount = decimalFromText(amountText, 'Admin Deposit requested amount').toString();
    const actualAmount = decimalFromText(actualAmountText, 'Admin Deposit actual amount').toString();
    const payerText = await read(headerAliases.payer);
    const channel = await read(headerAliases.channel);
    const reference = await read(headerAliases.reference);
    const matchedCustomerText = await read(headerAliases.matchedCustomer);
    const matchStatus = await read(headerAliases.matchStatus);
    const status = await read(headerAliases.status);
    const recordKey = createHash('sha256')
      .update([
        submittedAtText,
        accountType,
        currency,
        requestedAmount,
        payerText,
        matchedCustomerText,
        status
      ].join('|'))
      .digest('hex');

    return {
      recordKey,
      submittedAtText,
      submittedAtMs,
      accountType,
      currency,
      requestedAmount,
      actualAmount,
      payerText,
      channel,
      reference,
      matchedCustomerText,
      matchStatus,
      status
    };
  }

  private async filterCombobox(label: RegExp): Promise<Locator> {
    const byRole = this.page.getByRole('combobox', { name: label });
    const visible = await this.visibleLocators(byRole);
    if (visible.length === 1) return visible[0];

    for (const item of await this.page.locator('label').filter({ hasText: label }).all()) {
      if (!(await item.isVisible())) continue;
      const candidate = item.locator('..').getByRole('combobox');
      const nested = await this.visibleLocators(candidate);
      if (nested.length === 1) return nested[0];
    }
    throw new Error(`Admin Deposit filter was not found for ${label.source}.`);
  }

  private async readOptions(combobox: Locator): Promise<string[]> {
    await combobox.click();
    const listbox = this.page.getByRole('listbox').last();
    await expect(listbox).toBeVisible();
    const options = (await listbox.getByRole('option').allTextContents())
      .map(value => value.trim())
      .filter(Boolean);
    await this.page.keyboard.press('Escape');
    await expect(listbox).toBeHidden();
    return [...new Set(options)];
  }

  private async selectOption(combobox: Locator, name: string): Promise<void> {
    await combobox.click();
    const listbox = this.page.getByRole('listbox').last();
    await expect(listbox).toBeVisible();
    await listbox.getByRole('option', { name, exact: true }).click();
    await expect(listbox).toBeHidden();
  }

  private async goToFirstPage(): Promise<void> {
    for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
      const previous = await this.paginationButton('previous');
      if (!previous || await previous.isDisabled()) return;
      const before = (await this.readCurrentPageRecords()).map(item => item.recordKey).join('|');
      await previous.click();
      await expect.poll(async () =>
        (await this.readCurrentPageRecords()).map(item => item.recordKey).join('|')
      ).not.toBe(before);
    }
    throw new Error('Admin Deposit pagination exceeded 100 pages.');
  }

  private async paginationButton(direction: 'next' | 'previous'): Promise<Locator | undefined> {
    const patterns = direction === 'next'
      ? [/Go to next page/i, /下一页/i]
      : [/Go to previous page/i, /上一页/i];
    for (const pattern of patterns) {
      const visible = await this.visibleLocators(this.page.getByRole('button', { name: pattern }));
      if (visible.length === 1) return visible[0];
    }
    return undefined;
  }

  private async visibleLocators(locator: Locator): Promise<Locator[]> {
    const visible: Locator[] = [];
    for (const item of await locator.all()) {
      if (await item.isVisible()) visible.push(item);
    }
    return visible;
  }

  private parseAdminTime(value: string): number {
    const timestamp = Date.parse(value.trim().replace(' ', 'T') + '+08:00');
    if (!Number.isFinite(timestamp)) {
      throw new Error('Admin Deposit submission time could not be parsed.');
    }
    return timestamp;
  }
}
