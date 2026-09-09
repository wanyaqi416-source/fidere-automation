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
    // Read a complete DOM snapshot, not cells from different renders while pagination is loading.
    const snapshot = await this.table.evaluate(table => ({
      headers: Array.from(table.querySelectorAll('th')).map(cell => (cell.textContent ?? '').trim()),
      rows: Array.from(table.querySelectorAll('tbody tr')).map(row =>
        Array.from(row.querySelectorAll('td')).map(cell => (cell as HTMLElement).innerText.trim()))
    }));
    if (!snapshot.headers.includes('提交时间')) return [];
    return snapshot.rows.filter(cells => cells.length === snapshot.headers.length)
      .map(cells => this.parseRow(cells, snapshot.headers));
  }

  async readAllFilteredRecords(maxPages = 100): Promise<AdminDepositCandidate[]> {
    await this.goToFirstPage();
    const records: AdminDepositCandidate[] = [];
    const visitedPages = new Set<string>();
    let expectedTotal: number | undefined;

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      await this.waitForCompletePage();
      const range = await this.readPaginationRange();
      expectedTotal ??= range.total;
      if (range.total !== expectedTotal || range.start !== (range.total === 0 ? 0 : records.length + 1)) {
        throw new Error('Admin Deposit pagination skipped a range or changed totals; candidate collection is incomplete.');
      }
      const current = await this.readCurrentPageRecords();
      const afterRead = await this.readPaginationRange();
      if (range.start !== afterRead.start || range.end !== afterRead.end || range.total !== afterRead.total ||
          current.length !== (range.total === 0 ? 0 : range.end - range.start + 1)) {
        throw new Error('Admin Deposit pagination changed while reading rows; candidate collection is incomplete.');
      }
      const signature = current.map(record => record.recordKey).join('|');
      if (visitedPages.has(signature)) throw new Error('Admin Deposit pagination repeated; candidate collection is incomplete.');
      visitedPages.add(signature);
      records.push(...current);

      const nextButton = await this.paginationButton('next');
      if (!nextButton || await nextButton.isDisabled()) {
        if (records.length !== expectedTotal) throw new Error('Admin Deposit collected rows do not match the displayed total; candidate collection is incomplete.');
        return records;
      }
      await nextButton.click();
      await this.waitForChangedPage(signature);
    }

    throw new Error('Admin Deposit page limit reached; candidate collection is incomplete.');
  }

  async readAvailableActions(record: AdminDepositCandidate): Promise<string[]> {
    const row = await this.rowForRecord(record);
    const actions: string[] = [];
    for (const button of await row.getByRole('button').all()) {
      if (await button.isVisible() && await button.isEnabled()) actions.push((await button.innerText()).trim());
    }
    return actions;
  }

  async rowForRecord(record: AdminDepositCandidate): Promise<Locator> {
    await this.goToFirstPage();
    for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
      await this.waitForCompletePage();
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
      await this.waitForChangedPage(before);
    }
    throw new Error('Admin Deposit candidate row was no longer present in the filtered list.');
  }

  async expectClaimAndRejectActions(record: AdminDepositCandidate): Promise<void> {
    const row = await this.rowForRecord(record);
    await expect(row.getByRole('button', { name: '认领', exact: true })).toHaveCount(1);
    await expect(row.getByRole('button', { name: '拒绝', exact: true })).toHaveCount(1);
  }

  private async readRow(row: Locator, headers: readonly string[]): Promise<AdminDepositCandidate> {
    return this.parseRow(await row.getByRole('cell').allInnerTexts(), headers);
  }

  private parseRow(cells: readonly string[], headers: readonly string[]): AdminDepositCandidate {
    const read = (aliases: readonly string[]): string => {
      const index = headers.findIndex(header => aliases.includes(header));
      if (index < 0) throw new Error(`Admin Deposit list is missing column: ${aliases.join(' / ')}`);
      return cells[index].trim();
    };

    const submittedAtText = read(headerAliases.submittedAt);
    const amountText = read(headerAliases.amount);
    const actualAmountText = read(headerAliases.actualAmount);
    const currency = amountText.match(/\b[A-Z]{3}\b/)?.[0];
    if (!currency) throw new Error('Admin Deposit row did not display a currency code.');
    const submittedAtMs = this.parseAdminTime(submittedAtText);
    const accountType = read(headerAliases.accountType);
    const requestedAmount = decimalFromText(amountText, 'Admin Deposit requested amount').toString();
    const actualAmount = decimalFromText(actualAmountText, 'Admin Deposit actual amount').toString();
    const payerText = read(headerAliases.payer);
    const channel = read(headerAliases.channel);
    const reference = read(headerAliases.reference);
    const matchedCustomerText = read(headerAliases.matchedCustomer);
    const matchStatus = read(headerAliases.matchStatus);
    const status = read(headerAliases.status);
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
      await this.waitForChangedPage(before);
    }
    throw new Error('Admin Deposit pagination exceeded 100 pages.');
  }

  private async waitForCompletePage(): Promise<void> {
    await expect.poll(async () => {
      const range = this.page.getByText(/^\d+\s*[-\u2013]\s*\d+\s+of\s+\d+$/);
      if (await range.count() !== 1) return false;
      const numbers = (await range.innerText()).match(/\d+/g)!.map(Number);
      const expected = numbers[2] === 0 ? 0 : numbers[1] - numbers[0] + 1;
      return (await this.readCurrentPageRecords()).length === expected;
    }, { message: 'Admin Deposit rows did not match the visible pagination range.' }).toBe(true);
  }

  private async readPaginationRange(): Promise<{ start: number; end: number; total: number }> {
    const text = await this.page.getByText(/^\d+\s*[-\u2013]\s*\d+\s+of\s+\d+$/).innerText();
    const [start, end, total] = text.match(/\d+/g)!.map(Number);
    if (![start, end, total].every(Number.isSafeInteger) ||
        (total === 0 ? start !== 0 || end !== 0 : start < 1 || end < start || end > total)) {
      throw new Error('Admin Deposit pagination range is invalid.');
    }
    return { start, end, total };
  }

  private async waitForChangedPage(previous: string): Promise<void> {
    await expect.poll(async () => {
      const rows = await this.readCurrentPageRecords();
      return rows.length > 0 && rows.map(row => row.recordKey).join('|') !== previous;
    }, { message: 'Admin Deposit next page has not loaded; a transient empty table is not a new page.' }).toBe(true);
    await this.waitForCompletePage();
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
