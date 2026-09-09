import { expect, type Locator, type Page } from '@playwright/test';

import type { RegistrationApprovalAccountType } from '../../src/registration';

export type RegistrationReviewCandidate = {
  row: Locator;
  rowText: string;
  accountType: RegistrationApprovalAccountType;
  displayName: string;
  email: string;
  status: string;
  submittedAt?: string;
  reviewId: string;
  userId?: string;
  detailUrl: string;
  processUrl: string;
};

const labels = {
  personal: '个人用户',
  corporate: '企业用户'
} as const;

function normalize(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

export class RegistrationReviewDashboardPage {
  constructor(readonly page: Page) {}

  async goto(baseURL: string, options: { waitForTable?: boolean } = {}): Promise<void> {
    await this.page.goto(new URL('/zh-CN/kyc/dashboard', baseURL).toString(), {
      waitUntil: 'domcontentloaded'
    });
    await expect(
      this.page,
      'Admin storageState is expired. Run npm run auth:admin before a Registration approval.'
    ).not.toHaveURL(/\/login|\/signin|\/sign-in/i);
    await expect(this.page.getByText('案件工作台', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(this.page.getByRole('tab', { name: labels.personal, exact: true })).toBeVisible();
    await expect(this.page.getByRole('tab', { name: labels.corporate, exact: true })).toBeVisible();
    if (options.waitForTable !== false) await this.waitForRowsOrEmpty();
  }

  async selectAccountType(accountType: RegistrationApprovalAccountType): Promise<void> {
    const tab = this.page.getByRole('tab', { name: labels[accountType], exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await this.waitForRowsOrEmpty();
  }

  async locateUniquePendingCandidate(input: {
    accountType: RegistrationApprovalAccountType;
    email: string;
    displayName: string;
    reviewId?: string;
    userId?: string;
  }): Promise<{ candidateCount: number; candidates: RegistrationReviewCandidate[]; searchMode: 'email' | 'scanned-email'; candidateStages: Array<{ field: string; count: number }> }> {
    await this.selectAccountType(input.accountType);

    await this.search(input.email);
    let result = await this.collectPages(input);
    let searchMode: 'email' | 'scanned-email' = 'email';

    if (result.candidates.length === 0) {
      // The workbench search does not consistently search email. Scan the selected
      // tab's pages and match the full email locally, never a space-containing name query.
      await this.search('');
      result = await this.collectPages(input);
      searchMode = 'scanned-email';
    }

    return { candidateCount: result.candidates.length, ...result, searchMode };
  }

  async search(value: string): Promise<void> {
    const input = this.searchInput;
    await expect(input).toBeVisible({ timeout: 20_000 });
    await input.fill(value);
    await input.press('Enter');
    await expect(input).toHaveValue(value);
    await this.waitForRowsOrEmpty();
  }

  async readMatchingPendingCandidates(input: {
    accountType: RegistrationApprovalAccountType;
    email: string;
    displayName: string;
    reviewId?: string;
    userId?: string;
  }): Promise<RegistrationReviewCandidate[]> {
    const email = input.email.trim().toLowerCase();
    const displayName = normalize(input.displayName).toLowerCase();
    const candidates: RegistrationReviewCandidate[] = [];

    for (const row of await this.pendingRows.all()) {
      if (!await row.isVisible()) continue;
      const rowText = normalize(await row.innerText());
      const normalized = rowText.toLowerCase();
      const emails = Array.from(normalized.matchAll(/[^\s<>]+@[^\s<>]+/g), match => match[0]);
      if (!emails.includes(email) || !normalized.includes(displayName)) continue;
      if (!rowText.includes('待审核')) continue;

      const detailHref = await row.getByRole('link', { name: '查看详情', exact: true }).getAttribute('href');
      const processHref = await row.getByRole('link', { name: '开始处理', exact: true }).getAttribute('href');
      if (!detailHref || !processHref) {
        throw new Error('Unique Registration candidate does not expose detail and process links.');
      }
      const processUrl = new URL(processHref, this.page.url());
      const reviewId = processUrl.searchParams.get('reviewId');
      const userId = processUrl.pathname.match(/\/processingReviews\/([^/]+)/)?.[1];
      if (!reviewId) throw new Error('Registration candidate process URL does not contain reviewId.');
      if (input.reviewId && input.reviewId !== reviewId) continue;
      if (input.userId && input.userId !== userId) continue;
      const submittedAt = rowText.match(/20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?/)?.[0];

      candidates.push({
        row,
        rowText,
        accountType: input.accountType,
        displayName: input.displayName,
        email: input.email,
        status: '待审核',
        submittedAt,
        reviewId,
        userId,
        detailUrl: new URL(detailHref, this.page.url()).toString(),
        processUrl: processUrl.toString()
      });
    }
    return candidates;
  }

  private get searchInput(): Locator {
    return this.pendingSection.getByPlaceholder('搜索客户名称、审核类型...');
  }

  private get pendingRows(): Locator {
    return this.pendingTable.locator('tbody tr');
  }

  private get pendingTable(): Locator {
    return this.page.getByRole('table').filter({
      has: this.page.getByRole('columnheader', { name: '提交日期', exact: true })
    });
  }

  private get pendingSection(): Locator {
    const rejectedTable = this.page.getByRole('table').filter({
      has: this.page.getByRole('columnheader', { name: '拒绝原因', exact: true })
    });
    return this.page.locator('div').filter({ has: this.pendingTable })
      .filter({ hasNot: rejectedTable });
  }

  private async collectPages(input: {
    accountType: RegistrationApprovalAccountType; email: string; displayName: string;
    reviewId?: string; userId?: string;
  }) {
    const candidates: RegistrationReviewCandidate[] = [];
    const seen = new Set<string>();
    let total = 0;
    let emailCount = 0;
    let identityCount = 0;
    const previous = this.pendingSection.getByRole('button', { name: 'Go to previous page', exact: true });
    for (let page = 0; await previous.isEnabled(); page += 1) {
      if (page >= 100) throw new Error('KYC_PAGINATION_LIMIT: uniqueness is not established.');
      await this.changePage(previous);
    }
    for (let page = 0; page < 100; page += 1) {
      const rows = await this.pendingRows.allInnerTexts();
      const emailRows = rows.filter(row => Array.from(normalize(row).toLowerCase().matchAll(/[^\s<>]+@[^\s<>]+/g), match => match[0])
        .includes(input.email.trim().toLowerCase()));
      total += rows.filter(row => /待审核/.test(row)).length;
      emailCount += emailRows.length;
      identityCount += emailRows.filter(row => normalize(row).toLowerCase().includes(normalize(input.displayName).toLowerCase())).length;
      for (const candidate of await this.readMatchingPendingCandidates(input)) {
        if (seen.has(candidate.reviewId)) throw new Error('KYC_DUPLICATE_CASE_ROW: pagination did not establish uniqueness.');
        seen.add(candidate.reviewId);
        candidates.push(candidate);
      }
      const next = this.pendingSection.getByRole('button', { name: 'Go to next page', exact: true });
      if (!await next.isEnabled()) {
        return { candidates, candidateStages: [
          { field: `${labels[input.accountType]} / 待审核`, count: total },
          { field: '+精确邮箱', count: emailCount },
          { field: '+姓名二次匹配', count: identityCount },
          { field: '+原userId / reviewId', count: candidates.length }
        ] };
      }
      await this.changePage(next);
    }
    throw new Error('KYC_PAGINATION_LIMIT: uniqueness is not established.');
  }

  private async changePage(button: Locator): Promise<void> {
    const range = this.pendingSection.locator('.MuiTablePagination-displayedRows');
    const before = await range.innerText();
    await button.click();
    await expect(range).not.toHaveText(before, { timeout: 15_000 });
    await this.waitForRowsOrEmpty();
  }

  private async waitForRowsOrEmpty(): Promise<void> {
    await expect(this.pendingTable).toHaveCount(1);
    await expect(this.pendingTable.getByRole('columnheader', { name: '提交日期', exact: true })).toBeVisible();
    await expect.poll(async () => {
      const rows = await this.pendingRows.allInnerTexts();
      if (await this.pendingTable.getByRole('link').count() > 0) return true;
      if (rows.length === 1 && /^(No data available|暂无数据|没有数据|没有待处理.*)$/i.test(normalize(rows[0]))) return true;
      // The real workbench renders an empty tbody (without an empty-state label)
      // when the local search has no matches on a paginated slice.
      if (rows.length === 0 && await this.pendingTable.locator('tbody').count() === 1 &&
          await this.pendingSection.getByRole('progressbar').count() === 0) return true;
      const empty = this.pendingSection.getByText(/暂无数据|没有数据|No data|没有待处理/i).first();
      return (await empty.count()) === 1 && await empty.isVisible();
    }, {
      timeout: 20_000,
      intervals: [300, 500, 1_000],
      message: 'Admin Registration pending table did not settle.'
    }).toBe(true);
  }
}
