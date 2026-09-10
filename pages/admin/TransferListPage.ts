import { expect, type Locator, type Page } from '@playwright/test';

import {
  matchAdminTransferCandidates,
  type AdminTransferCandidate,
  type TransferFingerprint
} from '../../src/transfer/transfer-e2e';
import { decimalFromText } from '../../src/utils/money';

export type AdminTransferListRecord = AdminTransferCandidate & {
  recipientIdentity?: string;
  createdAtText: string;
  displayedAmount: string;
  rowText: string;
};

export type AdminTransferFilters = {
  status?: string;
  direction?: string;
  userKeyword?: string;
};

const headerAliases = {
  id: ['申请编号', '交易编号', '编号'],
  recordType: ['记录类型', '转账类型', '类型'],
  user: ['转出客户', '客户', '用户'],
  source: ['转出账户', '来源账户'],
  target: ['转入账户', '收款账户', '目标账户'],
  currency: ['币种'],
  requestedAmount: ['转账金额', '申请金额', '金额'],
  feeAmount: ['手续费'],
  netAmount: ['实际到账金额', '到账金额'],
  status: ['状态'],
  createdAt: ['提交时间', '创建时间', '申请时间']
} as const;

const currencyCodePattern = /[A-Z][A-Z0-9_]{2,20}/;

export class TransferListPage {
  readonly table: Locator;

  constructor(readonly page: Page) {
    this.table = page
      .getByRole('table')
      .filter({ has: page.getByRole('columnheader', { name: /申请编号|交易编号|编号/ }) });
  }

  async goto(baseURL: string): Promise<void> {
    const url = new URL('/zh-CN/operation/fiatAssets', baseURL);
    const currentUrl = new URL(this.page.url());

    if (currentUrl.origin !== url.origin || /\/login|\/signin|\/sign-in/i.test(currentUrl.pathname)) {
      throw new Error(
        'Admin authenticated shell is unavailable. Run npm run auth:admin before any Transfer mutation.'
      );
    }

    if (!/\/operation\/fiatAssets(?:$|[/?#])/i.test(this.page.url())) {
      const operationMenu = await this.waitForVisibleUnique(
        [
          this.page.getByRole('button', { name: '运营', exact: true }),
          this.page.getByText('运营', { exact: true })
        ],
        '等待Admin已认证页面显示运营菜单'
      );
      await operationMenu.click();

      const fiatAssetsLink = await this.waitForVisibleUnique(
        [
          this.page.getByRole('link', { name: '法币资产管理', exact: true }),
          this.page.getByText('法币资产管理', { exact: true })
        ],
        '等待Admin运营菜单显示法币资产管理入口'
      );
      await fiatAssetsLink.click();
    }

    await expect
      .poll(async () => {
        if (/\/login|\/signin|\/sign-in/i.test(this.page.url())) {
          return 'expired';
        }

        const labels = await this.page.getByText('资金互转', { exact: true }).all();
        for (const label of labels) {
          if (await label.isVisible()) {
            return 'ready';
          }
        }
        return 'loading';
      }, { message: '验证Admin资金互转业务路由和登录状态' })
      .toMatch(/^(ready|expired)$/);

    if (/\/login|\/signin|\/sign-in/i.test(this.page.url())) {
      throw new Error(
        'Admin storageState is expired on the Transfer business route. Run npm run auth:admin before any Client submission.'
      );
    }

    await expect(this.page).toHaveURL(/\/operation\/fiatAssets(?:$|[?#])/);
    await this.openTransferTab();
    await expect(this.table).toBeVisible();
  }

  async applySupportedFilters(filters: AdminTransferFilters): Promise<string[]> {
    const applied: string[] = [];

    if (filters.direction && (await this.selectComboboxOption(/类型|转账类型/, filters.direction))) {
      applied.push(`方向=${filters.direction}`);
    }
    if (filters.status && (await this.selectComboboxOption(/状态/, filters.status))) {
      applied.push(`状态=${filters.status}`);
    }
    if (filters.userKeyword) {
      const keywordInput = await this.visibleUnique([
        this.page.getByPlaceholder(/客户.*收款人|收款人.*客户/),
        this.page.getByRole('textbox', { name: /客户|收款人|关键词/ })
      ]);
      if (keywordInput) {
        await keywordInput.fill(filters.userKeyword);
        await keywordInput.press('Enter');
        applied.push('客户/收款人关键词');
      }
    }

    await expect(this.table).toBeVisible();
    return applied;
  }

  async readCurrentPageRecords(): Promise<AdminTransferListRecord[]> {
    await expect(this.table).toBeVisible();
    await expect(this.table.getByRole('progressbar'), 'Wait for the actual transfer rows, not the loading placeholder').toBeHidden({ timeout: 20_000 });
    const headers = (await this.table.getByRole('columnheader').allTextContents()).map(value =>
      value.trim()
    );
    const rows = await this.table
      .getByRole('row')
      .filter({ has: this.page.getByRole('cell') })
      .filter({ hasText: /TXN-[A-Z0-9-]+/i })
      .all();

    return Promise.all(rows.map(row => this.readRow(row, headers)));
  }

  async readAllFilteredRecords(): Promise<AdminTransferListRecord[]> {
    const records = new Map<string, AdminTransferListRecord>();
    await this.goToFirstPage();

    for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
      const current = await this.readCurrentPageRecords();
      for (const record of current) {
        records.set(record.adminTransactionId, record);
      }

      const nextButton = await this.visibleUnique([
        this.page.getByRole('button', { name: /下一页|next page/i }),
        this.page.getByLabel(/下一页|next page/i)
      ]);
      if (!nextButton || (await nextButton.isDisabled())) {
        return [...records.values()];
      }

      const previousIds = current.map(record => record.adminTransactionId).join('|');
      await nextButton.click();
      await expect
        .poll(async () => (await this.readCurrentPageRecords()).map(record => record.adminTransactionId).join('|'))
        .not.toBe(previousIds);
    }

    throw new Error('Admin Transfer pagination exceeded 100 pages; review is blocked.');
  }

  async collectFingerprintCandidates(
    fingerprint: TransferFingerprint,
    postSubmissionWindowMs: number
  ): Promise<AdminTransferListRecord[]> {
    const records = await this.readAllFilteredRecords();
    const matches = matchAdminTransferCandidates(records, fingerprint, postSubmissionWindowMs);
    const matchIds = new Set(matches.map(record => record.adminTransactionId));
    return records.filter(record => matchIds.has(record.adminTransactionId));
  }

  async rowByAdminTransactionId(adminTransactionId: string): Promise<Locator> {
    await this.goToFirstPage();

    for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
      await expect(this.table.getByRole('progressbar')).toBeHidden({ timeout: 20_000 });
      const row = this.table
        .getByRole('row')
        .filter({ hasText: adminTransactionId });
      const count = await row.count();
      if (count === 1) {
        return row;
      }
      if (count > 1) {
        throw new Error(
          `Admin Transfer list contains ${count} rows for ${adminTransactionId}; details were not opened.`
        );
      }

      const nextButton = await this.paginationButton('next');
      if (!nextButton || (await nextButton.isDisabled())) {
        break;
      }
      await this.clickPaginationAndWait(nextButton);
    }

    throw new Error(
      `Admin Transfer list did not contain ${adminTransactionId} on any filtered page.`
    );
  }

  async readRecordByAdminTransactionId(
    adminTransactionId: string
  ): Promise<AdminTransferListRecord> {
    const row = await this.rowByAdminTransactionId(adminTransactionId);
    const headers = (await this.table.getByRole('columnheader').allTextContents()).map(value =>
      value.trim()
    );
    return this.readRow(row, headers);
  }

  async waitForRecordStatus(
    adminTransactionId: string,
    expectedStatus: RegExp
  ): Promise<AdminTransferListRecord> {
    await expect
      .poll(
        async () => {
          await this.page.reload({ waitUntil: 'domcontentloaded' });
          await this.openTransferTab();
          await expect(this.table).toBeVisible();
          return (await this.readRecordByAdminTransactionId(adminTransactionId)).status;
        },
        {
          message: `等待Admin Transfer ${adminTransactionId}进入审核通过状态`,
          timeout: 30_000
        }
      )
      .toMatch(expectedStatus);

    return this.readRecordByAdminTransactionId(adminTransactionId);
  }

  private async openTransferTab(): Promise<void> {
    await expect
      .poll(async () => {
        const labels = await this.page.getByText('资金互转', { exact: true }).all();
        let visibleCount = 0;
        for (const label of labels) {
          if (await label.isVisible()) {
            visibleCount += 1;
          }
        }
        return visibleCount;
      }, { message: '等待Admin法币资产管理加载资金互转入口' })
      .toBeGreaterThan(0);

    const tab = await this.visibleUnique([
      this.page.getByRole('tab', { name: '资金互转', exact: true }),
      this.page.getByRole('button', { name: '资金互转', exact: true }),
      this.page.getByText('资金互转', { exact: true })
    ]);
    if (!tab) {
      throw new Error('Admin法币资产管理页面没有找到唯一可见的“资金互转”入口。');
    }
    await tab.click();
  }

  private async selectComboboxOption(label: RegExp, optionName: string): Promise<boolean> {
    const combobox = await this.visibleUnique([this.page.getByRole('combobox', { name: label })]);
    if (!combobox) {
      return false;
    }
    await combobox.click();
    const option = this.page.getByRole('option', { name: optionName, exact: true });
    if ((await option.count()) !== 1 || !(await option.isVisible())) {
      await this.page.keyboard.press('Escape');
      return false;
    }
    await option.click();
    return true;
  }

  private async readRow(
    row: Locator,
    headers: readonly string[]
  ): Promise<AdminTransferListRecord> {
    const cells = row.getByRole('cell');
    const read = async (aliases: readonly string[], required = true): Promise<string> => {
      const normalizedHeaders = headers.map(header => header.trim().replace(/\s+/g, ''));
      const normalizedAliases = aliases.map(alias => alias.trim().replace(/\s+/g, ''));
      let index = normalizedHeaders.findIndex(header => normalizedAliases.includes(header));

      if (index < 0) {
        const matchingIndexes = normalizedHeaders
          .map((header, headerIndex) => ({ header, headerIndex }))
          .filter(({ header }) =>
            normalizedAliases.some(alias => alias.length >= 4 && header.includes(alias))
          )
          .map(({ headerIndex }) => headerIndex);
        if (matchingIndexes.length === 1) {
          index = matchingIndexes[0];
        }
      }

      if (index < 0) {
        if (!required) {
          return '';
        }
        throw new Error(`Admin Transfer list is missing column: ${aliases.join(' / ')}`);
      }
      return (await cells.nth(index).innerText()).trim();
    };

    const idText = await read(headerAliases.id);
    const adminTransactionId = idText.match(/\bTXN-[A-Z0-9-]+\b/i)?.[0];
    if (!adminTransactionId) {
      throw new Error('Admin Transfer list row did not contain a real TXN identifier.');
    }

    const displayedAmount = await read(headerAliases.requestedAmount);
    const displayedFee = await read(headerAliases.feeAmount);
    const displayedNetAmount = await read(headerAliases.netAmount);
    const currencyText = await read(headerAliases.currency, false);
    const currency = currencyText.match(currencyCodePattern)?.[0] ??
      displayedAmount.match(currencyCodePattern)?.[0];
    if (!currency) {
      throw new Error(`Admin Transfer ${adminTransactionId} did not display a currency.`);
    }

    const createdAtText = await read(headerAliases.createdAt, false);
    const requestedAmount = decimalFromText(
      displayedAmount,
      'Admin Transfer requested amount'
    ).toString();
    return {
      adminTransactionId,
      recordType: await read(headerAliases.recordType),
      userIdentity: await read(headerAliases.user),
      recipientIdentity: await read(['收款人', '收款客户'], false),
      sourceAccountType: await read(headerAliases.source),
      targetAccountType: await read(headerAliases.target),
      currency,
      amount: requestedAmount,
      requestedAmount,
      feeAmount: decimalFromText(displayedFee, 'Admin Transfer fee amount').toString(),
      netAmount: decimalFromText(displayedNetAmount, 'Admin Transfer net amount').toString(),
      createdAtMs: createdAtText ? this.parseDisplayedDate(createdAtText) : undefined,
      createdAtText,
      status: await read(headerAliases.status),
      displayedAmount,
      rowText: (await row.innerText()).trim()
    };
  }

  private parseDisplayedDate(value: string): number {
    const normalized = value.trim().replace(/\//g, '-').replace(' ', 'T');
    const timestamp = Date.parse(normalized);
    if (!Number.isFinite(timestamp)) {
      throw new Error('Admin Transfer created time could not be normalized for fingerprint matching.');
    }
    return timestamp;
  }

  private async visibleUnique(candidates: Locator[]): Promise<Locator | undefined> {
    for (const candidate of candidates) {
      const visible: Locator[] = [];
      for (const item of await candidate.all()) {
        if (await item.isVisible()) {
          visible.push(item);
        }
      }
      if (visible.length === 1) {
        return visible[0];
      }
    }
    return undefined;
  }

  private async goToFirstPage(): Promise<void> {
    for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
      await expect(this.table.getByRole('progressbar')).toBeHidden({ timeout: 20_000 });
      const previousButton = await this.paginationButton('previous');
      if (!previousButton || (await previousButton.isDisabled())) {
        return;
      }
      await this.clickPaginationAndWait(previousButton);
    }

    throw new Error('Admin Transfer pagination exceeded 100 pages while returning to page one.');
  }

  private async paginationButton(
    direction: 'next' | 'previous'
  ): Promise<Locator | undefined> {
    const name = direction === 'next'
      ? /下一页|next page/i
      : /上一页|previous page/i;
    const exactAriaLabel = direction === 'next'
      ? 'Go to next page'
      : 'Go to previous page';
    const paginationSummary = this.page.getByText(
      /\d+\s*[–-]\s*\d+\s*共\s*\d+\s*条/
    );
    return this.visibleUnique([
      this.page.locator(`button[aria-label="${exactAriaLabel}"]`),
      paginationSummary.locator('..').getByRole('button', { name }),
      this.page.getByRole('button', { name }),
      this.page.getByLabel(name)
    ]);
  }

  private async clickPaginationAndWait(button: Locator): Promise<void> {
    const previousIds = (await this.currentPageTransactionIds()).join('|');
    await button.click();
    await expect
      .poll(async () => {
        const currentIds = await this.currentPageTransactionIds();
        return currentIds.length > 0 ? currentIds.join('|') : previousIds;
      })
      .not.toBe(previousIds);
  }

  private async currentPageTransactionIds(): Promise<string[]> {
    const values = await this.table
      .getByRole('row')
      .filter({ hasText: /TXN-[A-Z0-9-]+/i })
      .allTextContents();
    return values
      .map(value => value.match(/TXN-[A-Z0-9-]+/i)?.[0])
      .filter((value): value is string => Boolean(value));
  }

  private async waitForVisibleUnique(
    candidates: Locator[],
    message: string
  ): Promise<Locator> {
    await expect
      .poll(async () => ((await this.visibleUnique(candidates)) ? 1 : 0), { message })
      .toBe(1);

    const locator = await this.visibleUnique(candidates);
    if (!locator) {
      throw new Error(message);
    }
    return locator;
  }
}
