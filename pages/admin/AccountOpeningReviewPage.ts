import { expect, type Locator, type Page } from '@playwright/test';

import { matchesConfiguredCustomerIdentity } from '../../src/flow-engine';
import { AccountOpeningDetailPage } from './AccountOpeningDetailPage';

export type AccountOpeningAdminRecord = {
  customerMatched: boolean;
  customerText: string;
  accountType?: string;
  status: string;
  applicationId?: string;
  createdAt?: string;
  createdAtMs?: number;
  detailUrl?: string;
  processUrl?: string;
};

export class AccountOpeningReviewPage {
  private reviewActionClicks = 0;

  constructor(readonly page: Page) {}

  async goto(baseURL: string): Promise<void> {
    await this.page.goto(new URL('/zh-CN/kyc/accountReviews', baseURL).toString(), {
      waitUntil: 'domcontentloaded'
    });
    await expect(this.page).toHaveURL(/\/kyc\/accountReviews/);
    if (/\/login|\/signin|\/sign-in/i.test(this.page.url())) {
      throw new Error('Admin storageState is expired. Run npm run auth:admin.');
    }
    await expect(this.searchInput).toBeVisible({ timeout: 20_000 });
    await expect(this.page.getByRole('tab', { name: '个人用户', exact: true })).toBeVisible();
    await expect(this.page.getByRole('tab', { name: '企业用户', exact: true })).toBeVisible();
    await this.waitForRowsToSettle();
  }

  async searchCustomer(identity: string): Promise<void> {
    await this.searchInput.fill(identity);
    await this.searchInput.press('Enter');
    await expect(this.searchInput).toHaveValue(identity);
    await this.waitForLoadingToFinish();
    await this.waitForSearchResults(identity);
  }

  async clearSearch(): Promise<void> {
    await this.searchInput.fill('');
    await this.searchInput.press('Enter');
    await this.waitForLoadingToFinish();
    await this.waitForRowsToSettle();
  }

  async readRecords(identity?: string): Promise<AccountOpeningAdminRecord[]> {
    const records: AccountOpeningAdminRecord[] = [];
    const snapshots = await this.rows.evaluateAll(rows => rows.map(row => {
      const anchors = [...row.querySelectorAll<HTMLAnchorElement>('a[href]')];
      const detailHref = anchors
        .map(anchor => anchor.getAttribute('href'))
        .find(href => href?.includes('/kyc/accountReviews/') && !href.includes('/process'));
      const processHref = anchors
        .map(anchor => anchor.getAttribute('href'))
        .find(href =>
          href?.includes('/kyc/accountReviews/') &&
          href.includes('/process') &&
          href.includes('reviewId=')
        );
      return {
        rowText: (row.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(),
        detailHref,
        processHref
      };
    }));

    for (const snapshot of snapshots) {
      const { rowText, detailHref, processHref } = snapshot;
      const status = rowText.match(/待提交|待审核|审核中|审核通过|已通过|已批准|已拒绝|失败|failed/i)?.[0];
      const createdAt = rowText.match(/20\d{2}[-/]\d{2}[-/]\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?/)?.[0];
      const sourceUrl = detailHref ?? processHref;
      if (!sourceUrl || !status || !createdAt) continue;

      const parsed = new URL(sourceUrl, this.page.url());
      const createdAtMs = Date.parse(createdAt.replaceAll('/', '-'));
      records.push({
        customerMatched: identity
          ? matchesConfiguredCustomerIdentity(rowText, identity)
          : false,
        customerText: rowText,
        accountType: rowText.match(/香港账户|美国账户|新加坡账户|巴林账户/)?.[0],
        status,
        applicationId: parsed.searchParams.get('reviewId') ?? undefined,
        createdAt,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : undefined,
        detailUrl: new URL(detailHref ?? sourceUrl, this.page.url()).toString(),
        processUrl: processHref
          ? new URL(processHref, this.page.url()).toString()
          : undefined
      });
    }

    return records;
  }

  async tableRowCount(): Promise<number> {
    return (await this.readRecords()).length;
  }

  async openDetail(record: AccountOpeningAdminRecord): Promise<AccountOpeningDetailPage> {
    if (!record.detailUrl || !record.applicationId) {
      throw new Error('Account Opening candidate is missing its detail URL or reviewId.');
    }
    const detail = new AccountOpeningDetailPage(this.page);
    await detail.goto(record.detailUrl, record.applicationId);
    return detail;
  }

  reviewClickCount(): number {
    return this.reviewActionClicks;
  }

  get searchPlaceholder(): string {
    return '搜索客户ID、客户名称或客户邮箱';
  }

  private get searchInput(): Locator {
    return this.page.getByPlaceholder(this.searchPlaceholder);
  }

  private get rows(): Locator {
    return this.page.locator('tbody tr');
  }

  private async waitForLoadingToFinish(): Promise<void> {
    const progress = this.page.getByRole('progressbar');
    if ((await progress.count()) > 0 && await progress.first().isVisible()) {
      await expect(progress.first()).toBeHidden({ timeout: 20_000 });
    }
  }

  private async waitForRowsToSettle(): Promise<void> {
    await expect.poll(async () => {
      const texts = await this.rows.allInnerTexts();
      if (texts.some(text => text.trim().length > 0)) return true;
      const empty = this.page.getByText(/暂无数据|没有数据|No data/i);
      return (await empty.count()) > 0 && await empty.first().isVisible();
    }, {
      timeout: 20_000,
      message: 'Admin Account Opening table did not settle to records or an empty state.'
    }).toBe(true);
  }

  private async waitForSearchResults(identity: string): Promise<void> {
    await expect.poll(async () => {
      const records = await this.readRecords(identity);
      if (records.length > 0) return records.every(record => record.customerMatched);
      const empty = this.page.getByText(/暂无数据|没有数据|No data/i);
      return (await empty.count()) > 0 && await empty.first().isVisible();
    }, {
      timeout: 20_000,
      message: 'Admin Account Opening search did not settle to the configured customer or empty state.'
    }).toBe(true);
  }
}
