import { expect, type Locator, type Page } from '@playwright/test';
import { maskSensitiveText } from '../../src/reporting/sensitive-data-mask';
import { parseWealthDisplayAmount } from '../../src/wealth/wealth-money';

export type FundProduct = {
  name: string;
  productType: string;
  annualYield: string;
  riskLevel: string;
  minimumInvestment: string;
  currency: string;
  lockPeriod: string;
};

export type WealthHistoryRecord = {
  orderId: string;
  productName: string;
  type: string;
  amount: string;
  currency: string;
  status: string;
  createdAt: string;
  purchaseAccount: string;
};

export type WealthPosition = { productId: string; productName: string; principal: string; currency: string; status: string };

export type WealthPositionState = {
  renderedPositionRows: number;
  redeemActionCount: number;
  emptyStateText?: string;
};

export class FundTradingPage {
  constructor(readonly page: Page) {}

  async readSafeVisibleState(): Promise<string> {
    await this.waitForRenderedData();
    return maskSensitiveText(await this.page.locator('main').innerText());
  }

  private async waitForRenderedData(): Promise<void> {
    let previous = '';
    let stable = 0;
    await expect.poll(async () => {
      const pending = await this.page.getByRole('progressbar').filter({ visible: true }).count();
      const text = await this.page.locator('main').innerText();
      stable = !pending && text === previous && text.length > 40 ? stable + 1 : 0;
      previous = text;
      return stable;
    }, { timeout: 20_000, intervals: [300, 500, 1_000], message: 'Wait for fund page data to settle' }).toBeGreaterThanOrEqual(3);
  }

  async goto(baseURL: string): Promise<void> {
    const url = new URL('/zh-CN/investment/trading/funds', baseURL).toString();
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      const isConnectionTimeout =
        error instanceof Error && error.message.includes('net::ERR_CONNECTION_TIMED_OUT');
      if (!isConnectionTimeout) throw error;

      // This route is read-only; one transport-only reconnect is safe and the second error remains fatal.
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    }
    await expect(this.page).toHaveURL(/\/investment\/trading\/funds/);
    await expect(this.page.getByRole('tab', { name: '产品目录', exact: true })).toBeVisible({
      timeout: 20_000
    });
  }

  async openCatalog(): Promise<void> {
    const tab = this.page.getByRole('tab', { name: '产品目录', exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(this.subscribeButtons.first()).toBeVisible({ timeout: 20_000 });
  }

  async readProducts(): Promise<FundProduct[]> {
    const products: FundProduct[] = [];
    const count = await this.subscribeButtons.count();

    for (let index = 0; index < count; index += 1) {
      products.push(await this.productForButton(this.subscribeButtons.nth(index)));
    }

    return products;
  }

  async openSubscription(productName: string): Promise<void> {
    const count = await this.subscribeButtons.count();
    for (let index = 0; index < count; index += 1) {
      const button = this.subscribeButtons.nth(index);
      const product = await this.productForButton(button);
      if (product.name === productName) {
        await button.click();
        await expect(this.page).toHaveURL(/\/investment\/trading\/funds\/subscribe\?id=/, {
          timeout: 20_000
        });
        return;
      }
    }
    throw new Error(`Fund product was not found in the rendered catalog: ${productName}.`);
  }

  async openPositions(): Promise<WealthPositionState> {
    const tab = this.page.getByRole('tab', { name: '我的投资', exact: true });
    const loaded = this.page.waitForResponse(response => new URL(response.url()).pathname === '/api/invest/positions-list');
    await tab.click();
    await (await loaded).finished();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await this.waitForRenderedData();

    const emptyMessages = await this.page
      .getByText(/暂无.*(?:投资|持仓)|没有.*(?:投资|持仓)/)
      .allTextContents();
    return {
      renderedPositionRows: await this.page.locator('tbody tr').count(),
      redeemActionCount: await this.page.getByRole('button', { name: /赎回/ }).count(),
      emptyStateText: emptyMessages.map(value => value.trim()).find(Boolean)
    };
  }

  async readPositionResponseShape(): Promise<string> {
    const responsePromise = this.page.waitForResponse(response => new URL(response.url()).pathname === '/api/invest/positions-list');
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    const tab = this.page.getByRole('tab', { name: '我的投资', exact: true });
    await tab.click();
    const response = await responsePromise;
    const payload: unknown = await response.json();
    const shape = (value: unknown, depth = 0): unknown => {
      if (depth > 5) return typeof value;
      if (Array.isArray(value)) return { count: value.length, itemShape: value.length ? shape(value[0], depth + 1) : null };
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !/token|cookie|secret|authorization/i.test(key))
        .map(([key, item]) => [key, /^(code|status|success)$/.test(key) ? item : shape(item, depth + 1)]));
      return typeof value;
    };
    await this.waitForRenderedData();
    return JSON.stringify({ status: response.status(), shape: shape(payload) });
  }

  async readPositions(): Promise<WealthPosition[]> {
    const result: WealthPosition[] = [];
    for (const button of await this.page.getByRole('button', { name: '持仓详情', exact: true }).all()) {
      const card = await this.positionCard(button);
      const text = await card.innerText();
      const id = text.match(/\bID\s+(\d+)/)?.[1];
      const principal = text.match(/总投资金额\s*([\d,.]+)\s*([A-Z]+)/);
      if (!id || !principal) throw new Error('Position card identity/amount unreadable.');
      result.push({ productId: id, productName: text.split('\n')[0].trim(),
        principal: principal[1].replace(/,/g, ''), currency: principal[2],
        status: text.match(/持有中|已赎回|已到期/)?.[0] ?? '' });
    }
    return result;
  }

  async openPositionDetails(productId: string): Promise<void> {
    const matches: Locator[] = [];
    for (const button of await this.page.getByRole('button', { name: '持仓详情', exact: true }).all()) {
      const card = await this.positionCard(button);
      if ((await card.innerText()).match(/\bID\s+(\d+)/)?.[1] === productId) matches.push(button);
    }
    if (matches.length !== 1) throw new Error(`Position candidateCount=${matches.length}; no action.`);
    await matches[0].click();
    await this.waitForRenderedData();
  }

  async openHeldProduct(productId: string): Promise<void> {
    const matches: Locator[] = [];
    for (const button of await this.page.getByRole('button', { name: '持仓详情', exact: true }).all()) {
      const card = await this.positionCard(button);
      if ((await card.innerText()).match(/\bID\s+(\d+)/)?.[1] === productId) {
        matches.push(card.getByRole('button', { name: '详情', exact: true }));
      }
    }
    if (matches.length !== 1) throw new Error(`Held product candidateCount=${matches.length}.`);
    await matches[0].click();
    await this.waitForRenderedData();
  }

  private async positionCard(button: Locator): Promise<Locator> {
    let container = button.locator('..');
    for (let depth = 0; depth < 8; depth += 1) {
      if ((await container.getByRole('button', { name: '持仓详情', exact: true }).count()) === 1 &&
        /总投资金额/.test(await container.innerText())) return container;
      container = container.locator('..');
    }
    throw new Error('Unable to resolve the position card.');
  }

  async readHistory(
    kind: '申购' | '赎回',
    minimumRecords = 0,
    allPages = false
  ): Promise<WealthHistoryRecord[]> {
    const historyTab = this.page.getByRole('tab', { name: '交易历史', exact: true });
    await historyTab.click();
    await expect(historyTab).toHaveAttribute('aria-selected', 'true');

    const kindTab = this.page.getByRole('tab', { name: kind, exact: true });
    await expect(kindTab).toBeVisible();
    await kindTab.click();
    await expect(this.page.getByText('日期 & 编号', { exact: true })).toBeVisible();

    const historyTable = this.page.getByRole('table').filter({
      has: this.page.getByRole('columnheader', { name: '日期 & 编号', exact: true })
    });
    await expect(historyTable).toBeVisible();
    await this.waitForRenderedData();
    const rows = historyTable.locator('tbody tr');
    const populatedRows = rows.filter({ hasText: /INV-[A-Z0-9-]+/i });
    if (minimumRecords > 0) {
      await expect.poll(() => populatedRows.count(), {
        message: `${kind}历史未在页面加载出预期记录`
      }).toBeGreaterThanOrEqual(minimumRecords);
    }

    const records = await this.readRenderedHistory(populatedRows, kind);
    if (allPages) {
      for (let pageNumber = 2; pageNumber <= 50; pageNumber += 1) {
        const next = this.page.getByRole('button', { name: String(pageNumber), exact: true });
        if (await next.count() !== 1 || !await next.isEnabled()) break;
        const loaded = this.page.waitForResponse(response => new URL(response.url()).pathname === '/api/invest/orders-list');
        await next.click();
        await (await loaded).finished();
        await this.waitForRenderedData();
        records.push(...await this.readRenderedHistory(populatedRows, kind));
        if (pageNumber === 50) throw new Error('History pagination exceeded the bounded scan; no submission allowed.');
      }
    }
    return [...new Map(records.map(row => [row.orderId, row])).values()];
  }

  private async readRenderedHistory(populatedRows: Locator, kind: '申购' | '赎回'): Promise<WealthHistoryRecord[]> {
    const records: WealthHistoryRecord[] = [];
    const count = await populatedRows.count();
    for (let index = 0; index < count; index += 1) {
      const cells = await populatedRows.nth(index).locator('th, td').allTextContents();
      const text = cells.join('\n').replace(/\u00a0/g, ' ');
      const orderId = text.match(/INV-[A-Z0-9-]+/i)?.[0];
      if (!orderId || !cells[4]) continue;
      const amount = parseWealthDisplayAmount(cells[4].trim());

      records.push({
        orderId,
        productName: (cells[1] ?? '').trim(),
        type: (cells[2] ?? kind).trim(),
        amount: amount.amount,
        currency: amount.currency,
        status: (cells[5] ?? text.match(/待审核|处理中|已通过|已拒绝|已完成|已赎回|已到期|持有中|成功|失败/)?.[0] ?? '').trim(),
        createdAt: text.match(/20\d{2}[-/]\d{2}[-/]\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?/)?.[0] ?? '',
        purchaseAccount: (cells[3] ?? '').trim()
      });
    }

    return records;
  }

  private get subscribeButtons(): Locator {
    return this.page.getByRole('button', { name: '申购', exact: true });
  }

  private async productForButton(button: Locator): Promise<FundProduct> {
    const text = await button.evaluate(element => {
      let current = element.parentElement;
      while (current) {
        const innerText = (current.innerText ?? '').trim();
        const subscribeCount = [...current.querySelectorAll('button')]
          .filter(candidate => (candidate.textContent ?? '').trim() === '申购')
          .length;
        if (innerText.includes('最低投资') && innerText.includes('当前年化收益率') && subscribeCount === 1) {
          return innerText;
        }
        current = current.parentElement;
      }
      throw new Error('Unable to resolve the fund card containing the subscribe button.');
    });
    const lines = text.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const minimum = text.match(/最低投资\s*([A-Z]{3})\s*([\d,.]+)/);
    const annualYield = text.match(/当前年化收益率\s*([\d.]+%)/)?.[1];
    const riskLevel = text.match(/(?:低|中|高)风险/)?.[0];
    const productType = text.match(/活期|定期/)?.[0];
    const lockPeriod = text.match(/锁定期\s*([^\r\n]+)/)?.[1];
    if (!lines[0] || !minimum || !annualYield || !riskLevel || !productType || !lockPeriod) {
      throw new Error('Fund product fields could not be parsed from the rendered Client page.');
    }
    return {
      name: lines[0],
      productType,
      annualYield,
      riskLevel,
      minimumInvestment: minimum[2].replace(/,/g, ''),
      currency: minimum[1],
      lockPeriod
    };
  }
}
