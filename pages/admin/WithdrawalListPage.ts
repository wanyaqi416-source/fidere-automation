import { expect, type Locator, type Page } from '@playwright/test';

import {
  diagnoseAdminWithdrawalCandidates,
  withdrawalRecordKey,
  type AdminWithdrawalCandidate,
  type WithdrawalCandidateDiagnostics,
  type WithdrawalFingerprint
} from '../../src/withdrawal/withdrawal-e2e';
import { decimalFromText } from '../../src/utils/money';
import { WithdrawalDetailPage } from './WithdrawalDetailPage';

export type AdminWithdrawalListRecord = AdminWithdrawalCandidate & {
  displayedAmount: string;
  displayedFee: string;
  rowText: string;
  row: Locator;
};

export class WithdrawalListPage {
  readonly table: Locator;

  constructor(readonly page: Page) {
    this.table = page.getByRole('table').filter({
      has: page.getByRole('columnheader', { name: '申请时间', exact: true })
    });
  }

  async goto(baseURL: string): Promise<void> {
    const url = new URL('/zh-CN/operation/fiatAssets', baseURL);
    await this.page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    if (/\/login|\/signin|\/sign-in/i.test(this.page.url())) {
      throw new Error(
        'Admin storageState is expired on the Withdrawal business route. Run npm run auth:admin.'
      );
    }
    try {
      await expect(this.page.getByText('资金互转', { exact: true }).first()).toBeVisible();
    } catch (error) {
      // An expired server session can redirect after the initial route load.
      if (/\/login|\/signin|\/sign-in/i.test(this.page.url())) {
        throw new Error('Admin storageState is expired on the Withdrawal business route. Run npm run auth:admin.');
      }
      throw error;
    }
    await this.openWithdrawalTab();
    await expect(this.table).toBeVisible();
    await expect(
      this.table.getByText(/待处理|处理中|处理完成|处理失败|客户取消|已拒绝|暂无数据/).first()
    ).toBeVisible();
  }

  async readStatusOptions(): Promise<string[]> {
    const combobox = await this.statusCombobox();
    await combobox.click();
    const listbox = this.page.getByRole('listbox').last();
    await expect(listbox).toBeVisible();
    const values = (await listbox.getByRole('option').allTextContents())
      .map(value => value.trim())
      .filter(Boolean);
    await this.page.keyboard.press('Escape');
    await expect(listbox).toBeHidden();
    return values;
  }

  async selectStatus(status: string): Promise<void> {
    const combobox = await this.statusCombobox();
    await combobox.click();
    const listbox = this.page.getByRole('listbox').last();
    await expect(listbox).toBeVisible();
    const option = listbox.getByRole('option', { name: status, exact: true });
    await expect(option).toHaveCount(1);
    await option.click();
    await expect(listbox).toBeHidden();
    await expect(combobox).toContainText(status);
    const queryButton = this.page.getByRole('button', { name: '查询', exact: true });
    await expect(queryButton).toBeVisible();
    await queryButton.click();
    await this.waitForTableSettled();
    const records = await this.readCurrentPageRecords();
    expect(records.every(record => record.status === status)).toBe(true);
  }

  async searchCustomerEmail(email: string): Promise<void> {
    const normalizedEmail = email.trim().toLocaleLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new Error('Admin Withdrawal search requires a configured customer email.');
    }
    const input = this.page.getByPlaceholder('客户、收款人...');
    await expect(input).toBeVisible();
    await input.fill(normalizedEmail);
    const queryButton = this.page.getByRole('button', { name: '查询', exact: true });
    await queryButton.click();
    await expect.poll(async () => {
      if (await this.table.getByText(/加载出金审批数据中/).isVisible()) return false;
      const records = await this.readCurrentPageRecords();
      if (records.length === 0) {
        return this.table.getByText('暂无数据', { exact: true }).isVisible();
      }
      return records.every(record =>
        record.userText.toLocaleLowerCase().includes(normalizedEmail)
      );
    }).toBe(true);
  }

  async readCurrentPageRecords(): Promise<AdminWithdrawalListRecord[]> {
    await expect(this.table).toBeVisible();
    await this.waitForTableSettled();
    const headers = (await this.table.getByRole('columnheader').allTextContents())
      .map(value => value.trim());
    const records: AdminWithdrawalListRecord[] = [];
    for (const row of await this.table.getByRole('row').all()) {
      if ((await row.getByRole('cell').count()) !== headers.length) continue;
      records.push(await this.readRow(row, headers));
    }
    return records;
  }

  async readAllFilteredRecords(maxPages = 20): Promise<AdminWithdrawalListRecord[]> {
    const records = new Map<string, AdminWithdrawalListRecord>();
    await this.goToFirstPage();
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const current = await this.readCurrentPageRecords();
      for (const record of current) records.set(record.recordKey, record);
      const next = await this.paginationButton('next');
      if (!next || (await next.isDisabled())) return [...records.values()];
      const previousKeys = current.map(record => record.recordKey).join('|');
      await next.click();
      await expect
        .poll(async () => (await this.readCurrentPageRecords()).map(record => record.recordKey).join('|'))
        .not.toBe(previousKeys);
    }
    throw new Error(`Admin Withdrawal pagination exceeded ${maxPages} pages.`);
  }

  async diagnoseCandidates(
    fingerprint: WithdrawalFingerprint,
    matchWindowMs: number,
    options: { applyTimeWindow?: boolean; maxPages?: number } = {}
  ): Promise<WithdrawalCandidateDiagnostics> {
    const records = await this.readAllFilteredRecords(options.maxPages ?? 20);
    return diagnoseAdminWithdrawalCandidates(
      records,
      fingerprint,
      matchWindowMs,
      { applyTimeWindow: options.applyTimeWindow }
    );
  }

  async locateFingerprintCandidate(
    fingerprint: WithdrawalFingerprint,
    matchWindowMs: number,
    maxPages = 20
  ): Promise<AdminWithdrawalListRecord> {
    await this.goToFirstPage();
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const current = await this.readCurrentPageRecords();
      const diagnostics = diagnoseAdminWithdrawalCandidates(
        current,
        fingerprint,
        matchWindowMs
      );
      if (diagnostics.candidates.length > 1) {
        throw new Error('Admin Withdrawal fingerprint resolved to multiple rows on one page.');
      }
      if (diagnostics.candidates.length === 1) {
        const key = diagnostics.candidates[0].recordKey;
        const liveRecord = current.find(record => record.recordKey === key);
        if (!liveRecord) {
          throw new Error('Admin Withdrawal matched candidate lost its live row locator.');
        }
        return liveRecord;
      }
      const next = await this.paginationButton('next');
      if (!next || (await next.isDisabled())) break;
      const previousKeys = current.map(record => record.recordKey).join('|');
      await next.click();
      await expect
        .poll(async () => (await this.readCurrentPageRecords()).map(record => record.recordKey).join('|'))
        .not.toBe(previousKeys);
    }
    throw new Error('Admin Withdrawal unique candidate could not be re-located by fingerprint.');
  }

  async actionableRowCount(): Promise<number> {
    return (await this.readActionablePendingRecords()).length;
  }

  async readActionablePendingRecords(): Promise<AdminWithdrawalListRecord[]> {
    const records = await this.readCurrentPageRecords();
    const actionable: AdminWithdrawalListRecord[] = [];
    for (const record of records) {
      if (record.status !== '待处理') continue;
      if ((await record.row.getByRole('button', { name: '审批', exact: true }).count()) === 1) {
        actionable.push(record);
      }
    }
    return actionable;
  }

  async openDetail(record: AdminWithdrawalListRecord): Promise<WithdrawalDetailPage> {
    const actionName = record.status === '待处理' ? '审批' : '查看';
    const action = record.row.getByRole('button', { name: actionName, exact: true });
    await expect(action, 'Admin Withdrawal candidate must have one approval/detail action.').toHaveCount(1);
    await action.click();
    const detail = new WithdrawalDetailPage(this.page);
    await detail.waitForOpen();
    return detail;
  }

  private async openWithdrawalTab(): Promise<void> {
    const candidates = [
      this.page.getByRole('tab', { name: '出金审批', exact: true }),
      this.page.getByRole('button', { name: '出金审批', exact: true }),
      this.page.getByText('出金审批', { exact: true })
    ];
    let selected: Locator | undefined;
    for (const candidate of candidates) {
      const visible: Locator[] = [];
      for (const item of await candidate.all()) {
        if (await item.isVisible()) visible.push(item);
      }
      if (visible.length === 1) {
        selected = visible[0];
        break;
      }
    }
    if (!selected) throw new Error('Admin Fiat Assets did not expose one 出金审批 tab.');
    await selected.click();
  }

  private async statusCombobox(): Promise<Locator> {
    const visible: Locator[] = [];
    for (const item of await this.page.getByRole('combobox').all()) {
      if (await item.isVisible()) visible.push(item);
    }
    if (visible.length < 1) throw new Error('Admin Withdrawal status filter was not found.');
    return visible[0];
  }

  private async readRow(
    row: Locator,
    headers: readonly string[]
  ): Promise<AdminWithdrawalListRecord> {
    const cells = row.getByRole('cell');
    const read = async (header: string): Promise<string> => {
      const index = headers.indexOf(header);
      if (index < 0) throw new Error(`Admin Withdrawal list is missing column: ${header}`);
      return (await cells.nth(index).innerText()).trim();
    };
    const rowText = (await row.innerText()).trim();
    const submittedAtText = await read('申请时间');
    const displayedAmount = await read('币种/金额');
    const displayedFee = await read('出金手续费');
    const currency = displayedAmount.match(/\b[A-Z]{3}\b/)?.[0];
    const submittedAtMs = Date.parse(
      submittedAtText.trim().replace(/\//g, '-').replace(/\s+/, 'T')
    );
    if (!currency || !Number.isFinite(submittedAtMs)) {
      throw new Error('Admin Withdrawal currency or application time could not be parsed.');
    }
    return {
      recordKey: withdrawalRecordKey(rowText),
      submittedAtText,
      submittedAtMs,
      userText: await read('客户'),
      accountType: await read('账户类型'),
      currency,
      requestedAmount: decimalFromText(
        displayedAmount,
        'Admin Withdrawal requested amount'
      ).abs().toString(),
      feeAmount: decimalFromText(displayedFee, 'Admin Withdrawal fee').abs().toString(),
      beneficiaryText: await read('收款人'),
      purpose: await read('用途'),
      status: await read('状态'),
      displayedAmount,
      displayedFee,
      rowText,
      row
    };
  }

  private async goToFirstPage(): Promise<void> {
    for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
      const previous = await this.paginationButton('previous');
      if (!previous || (await previous.isDisabled())) return;
      const previousKeys = (await this.readCurrentPageRecords()).map(record => record.recordKey).join('|');
      await previous.click();
      await expect
        .poll(async () => (await this.readCurrentPageRecords()).map(record => record.recordKey).join('|'))
        .not.toBe(previousKeys);
    }
    throw new Error('Admin Withdrawal pagination exceeded 100 pages while returning to page one.');
  }

  private async paginationButton(
    direction: 'next' | 'previous'
  ): Promise<Locator | undefined> {
    const exactAriaLabel = direction === 'next' ? 'Go to next page' : 'Go to previous page';
    const button = this.page.locator(`button[aria-label="${exactAriaLabel}"]`);
    for (const item of await button.all()) {
      if (await item.isVisible()) return item;
    }
    return undefined;
  }

  private async waitForTableSettled(): Promise<void> {
    await expect.poll(async () => {
      if (await this.table.getByText(/加载出金审批数据中/).isVisible()) return false;
      const headerCount = await this.table.getByRole('columnheader').count();
      for (const row of await this.table.getByRole('row').all()) {
        if (headerCount > 0 && await row.getByRole('cell').count() === headerCount) return true;
      }
      return this.table.getByText('暂无数据', { exact: true }).isVisible();
    }).toBe(true);
  }
}
