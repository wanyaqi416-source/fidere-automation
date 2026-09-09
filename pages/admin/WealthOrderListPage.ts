import { expect, type Locator, type Page } from '@playwright/test';
import type { WealthOrderCandidate } from '../../src/wealth/wealth-e2e';
import { parseWealthDisplayAmount } from '../../src/wealth/wealth-money';

export type WealthAdminOrderKind = 'subscription' | 'redemption';
export type WealthAdminStatus = '待审核' | '已通过' | '已拒绝';

export type WealthAdminCandidate = {
  orderId: string;
  kind: WealthAdminOrderKind;
  status: WealthAdminStatus;
  row: Locator;
};

export type WealthAdminDetail = {
  orderId: string;
  text: string;
  approveActionVisible: boolean;
  rejectActionVisible: boolean;
  record: WealthOrderCandidate;
  account: string;
  fee: string;
};

export class WealthOrderListPage {
  private mutationClicks = 0;
  private kind: WealthAdminOrderKind = 'subscription';

  constructor(readonly page: Page) {}

  async goto(baseURL: string, kind: WealthAdminOrderKind): Promise<void> {
    this.kind = kind;
    await this.page.goto(new URL('/zh-CN/operation/financialProducts', baseURL).toString(), {
      waitUntil: 'domcontentloaded'
    });
    await expect(this.page).toHaveURL(/\/operation\/financialProducts/);
    const managementTab = this.page.getByRole('tab', {
      name: kind === 'subscription' ? '认购管理' : '赎回管理',
      exact: true
    });
    await expect(managementTab).toBeVisible({ timeout: 20_000 });
    await managementTab.click();
    await expect(this.searchInput).toBeVisible();
    await expect(this.page.getByRole('tab', { name: '待审核', exact: true })).toBeVisible();
    if (kind === 'subscription') {
      await expect(this.page.getByText('客户 / 订单', { exact: true })).toBeVisible({ timeout: 20_000 });
    }
  }

  async tableHeaders(): Promise<string[]> {
    return (await this.page.locator('thead th').allTextContents())
      .map(value => value.trim())
      .filter(Boolean);
  }

  async findExactOrder(
    orderId: string,
    kind: WealthAdminOrderKind
  ): Promise<WealthAdminCandidate[]> {
    if (!/^INV-[A-Z0-9-]+$/i.test(orderId)) {
      throw new Error('Wealth Admin exact search requires an INV-* order ID read from the Client page.');
    }

    const candidates: WealthAdminCandidate[] = [];
    for (const status of ['待审核', '已通过', '已拒绝'] as const) {
      const statusTab = this.page.getByRole('tab', { name: status, exact: true });
      if (await statusTab.getAttribute('aria-selected') !== 'true') {
        const loaded = this.waitForListResponse();
        await statusTab.click();
        await loaded;
      }
      await expect(statusTab).toHaveAttribute('aria-selected', 'true');
      await this.searchExact(orderId);
      await this.waitForLoadingToFinish();

      const matchingRows = this.rows.filter({ hasText: orderId });
      for (let index = 0; index < await matchingRows.count(); index += 1) {
        candidates.push({ orderId, kind, status, row: matchingRows.nth(index) });
      }
    }
    return candidates;
  }

  async openDetails(candidate: WealthAdminCandidate): Promise<WealthAdminDetail> {
    const statusTab = this.page.getByRole('tab', { name: candidate.status, exact: true });
    if (await statusTab.getAttribute('aria-selected') !== 'true') {
      const loaded = this.waitForListResponse();
      await statusTab.click();
      await loaded;
    }
    await expect(statusTab).toHaveAttribute('aria-selected', 'true');
    await this.searchExact(candidate.orderId);
    await this.waitForLoadingToFinish();

    const matchingRows = this.rows.filter({ hasText: candidate.orderId });
    await expect(matchingRows).toHaveCount(1);
    const currentRow = matchingRows.first();
    const action = currentRow.getByRole('button', { name: /查看详情|审核|处理/ });
    const actionCount = await action.count();
    if (actionCount === 1) {
      await action.click();
    } else if (actionCount === 0) {
      await currentRow.click();
    } else {
      throw new Error(`Wealth order ${candidate.orderId} has ${actionCount} ambiguous detail actions.`);
    }

    const detailRoot = await this.resolveDetailRoot(candidate.orderId);
    await expect(detailRoot).toBeVisible({ timeout: 15_000 });
    const text = (await detailRoot.innerText()).replace(/\u00a0/g, ' ');
    const amountLabel = candidate.kind === 'subscription' ? '认购金额' : '赎回金额';
    const amountStart = text.indexOf(amountLabel) + amountLabel.length;
    const amount = parseWealthDisplayAmount(text.slice(amountStart));
    const fee = parseWealthDisplayAmount(text.slice(text.indexOf('手续费') + '手续费'.length));
    const customer = text.match(/客户\s*([^\r\n]+)/)?.[1]?.trim();
    const account = text.match(/(?:付款账户|结算账户)\s*([^\r\n]+)/)?.[1]?.trim();
    const createdAt = text.match(/申请时间\s*(20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)/)?.[1];
    const product = text.slice(amountStart + amount.matchedText.length).trim().split('\n')[0].trim();
    const ids = [...new Set(text.match(/INV-[A-Z0-9-]+/gi) ?? [])];
    if (fee.currency !== amount.currency || !customer || !account || !product || ids.length !== 1 || ids[0] !== candidate.orderId) {
      throw new Error('Wealth detail core fields do not uniquely identify the original order.');
    }
    return {
      orderId: candidate.orderId,
      text,
      approveActionVisible: await detailRoot.getByRole('button', { name: /批准认购|批准赎回|审核通过|批准/ }).isVisible(),
      rejectActionVisible: await detailRoot.getByRole('button', { name: /拒绝/ }).isVisible(),
      record: { orderId: candidate.orderId, kind: candidate.kind, customerText: customer,
        productName: product, amount: amount.amount, currency: amount.currency,
        status: candidate.status, createdAtMs: createdAt ? Date.parse(createdAt) : undefined },
      account, fee: fee.amount
    };
  }

  async approveOnce(orderId: string): Promise<void> {
    if (this.mutationClicks !== 0) throw new Error('Wealth Admin approval was already attempted.');
    const root = await this.resolveDetailRoot(orderId);
    const button = root.getByRole('button', { name: this.kind === 'subscription' ? '批准认购' : '批准赎回', exact: true });
    await expect(button).toHaveCount(1);
    await expect(button).toBeEnabled();
    this.mutationClicks += 1;
    await button.click();
  }

  private async searchExact(orderId: string): Promise<void> {
    if (await this.searchInput.inputValue() === orderId) return;
    const loaded = this.waitForListResponse(orderId);
    await this.searchInput.fill(orderId);
    await this.searchInput.press('Enter');
    await loaded;
  }

  private async waitForListResponse(orderId?: string): Promise<void> {
    const response = await this.page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === `/admin-api/operation/invest/${this.kind}/list` &&
        (!orderId || [...url.searchParams.values()].some(value => value === orderId));
    }, { timeout: 20_000 });
    if (!response.ok()) throw new Error('Admin wealth list request failed.');
    await response.finished();
  }

  private async resolveDetailRoot(orderId: string): Promise<Locator> {
    let root: Locator | undefined;
    await expect.poll(async () => {
      for (const label of await this.page.getByText(orderId, { exact: true }).all()) {
        if (!await label.isVisible()) continue;
        let container = label.locator('..');
        for (let depth = 0; depth < 10; depth += 1) {
          const text = await container.innerText();
          if (/订单号/.test(text) && /手续费/.test(text) && /申请时间/.test(text) &&
            (await container.getByRole('table').count()) === 0) { root = container; return true; }
          container = container.locator('..');
        }
      }
      return false;
    }, { timeout: 20_000, message: 'Wait for the unique wealth order detail, never the list main element' }).toBe(true);
    return root!;
  }

  mutationClickCount(): number {
    return this.mutationClicks;
  }

  private get searchInput(): Locator {
    return this.page.getByPlaceholder('搜索客户、订单号、产品');
  }

  private get rows(): Locator {
    return this.page.locator('tbody tr');
  }

  private async waitForLoadingToFinish(): Promise<void> {
    await this.page.getByRole('progressbar').waitFor({ state: 'detached', timeout: 10_000 });
    let previous = '', stable = 0;
    await expect.poll(async () => {
      const text = await this.page.locator('tbody').innerText();
      stable = text === previous ? stable + 1 : 0;
      previous = text;
      return stable;
    }, { timeout: 15_000, intervals: [300, 500, 1_000] }).toBeGreaterThanOrEqual(3);
  }
}
