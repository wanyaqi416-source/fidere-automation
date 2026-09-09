import { expect, type Locator, type Page } from '@playwright/test';
import { maskSensitiveText } from '../../src/reporting/sensitive-data-mask';

export type BrokerAccountCard = {
  name: string;
  status: string;
  openingFee: string;
  feeCurrency: string;
  accountType: string;
  markets: string[];
  action: '立即开户' | '查看详情' | '查看审核进度';
};

export class SecuritiesTradingPage {
  private applicationClicks = 0;

  constructor(readonly page: Page) {}

  async goto(baseURL: string): Promise<void> {
    await this.page.goto(
      new URL('/zh-CN/investment/trading/securities', baseURL).toString(),
      { waitUntil: 'domcontentloaded' }
    );
    await expect(this.page).toHaveURL(/\/investment\/trading\/securities/);
    await expect(this.actionButtons.first()).toBeVisible({ timeout: 20_000 });
  }

  async readBrokerCards(): Promise<BrokerAccountCard[]> {
    const cards: BrokerAccountCard[] = [];
    const count = await this.actionButtons.count();

    for (let index = 0; index < count; index += 1) {
      const button = this.actionButtons.nth(index);
      const actionText = (await button.innerText()).trim();
      if (actionText !== '立即开户' && actionText !== '查看详情' && actionText !== '查看审核进度') continue;

      const text = await this.cardText(button);
      const lines = text.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      const fee = text.match(/开户费用\s*([\d,.]+)\s*([A-Z]{3})/);
      const marketsText = text.match(/可投市场\s*([^\r\n]+)/)?.[1] ?? '';
      const accountType = text.match(/账户类型\s*([^\r\n]+)/)?.[1]?.trim();
      const status = text.match(/已开通|已开户|待开户|审核中|开户中|已拒绝|失败|未开通/)?.[0];

      if (!lines[0] || !fee || !status || !accountType) {
        throw new Error('Broker card fields could not be parsed from the rendered Client page.');
      }

      cards.push({
        name: lines[0],
        status,
        openingFee: fee[1].replace(/,/g, ''),
        feeCurrency: fee[2],
        accountType,
        markets: marketsText.split('·').map(value => value.trim()).filter(Boolean),
        action: actionText
      });
    }

    return cards;
  }

  applicationClickCount(): number {
    return this.applicationClicks;
  }

  async readSafeState(): Promise<string> {
    return maskSensitiveText(await this.page.getByRole('main').ariaSnapshot());
  }

  async readBrokerStatus(brokerName: string): Promise<string> {
    const heading = this.page.getByRole('heading', { name: brokerName, exact: true });
    await expect(heading).toHaveCount(1);
    return heading.evaluate(element => {
      let parent = element.parentElement;
      while (parent) {
        if (parent.innerText.includes('开户费用') && parent.innerText.includes('可投市场') && parent.querySelectorAll('h6').length === 1) {
          const status = parent.innerText.match(/已开通|已开户|待开户|审核中|开户中|已拒绝|失败|未开通/)?.[0];
          if (!status) throw new Error('Actual broker card status is unavailable.');
          return status;
        }
        parent = parent.parentElement;
      }
      throw new Error('Unique broker status card could not be resolved.');
    });
  }

  async openApplication(brokerName: string): Promise<void> {
    const candidates: Locator[] = [];
    for (const button of await this.actionButtons.all()) {
      const text = await this.cardText(button);
      if (text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)[0] === brokerName) candidates.push(button);
    }
    expect(candidates).toHaveLength(1);
    await expect(candidates[0]).toHaveText('立即开户');
    const before = this.page.url();
    await candidates[0].click();
    await expect.poll(async () => this.page.url() !== before || await this.page.getByRole('dialog').count() > 0, { timeout: 20_000 }).toBe(true);
    await expect(this.page.getByRole('button', { name: /提交|确认|取消/ }).first()).toBeVisible();
  }

  private get actionButtons(): Locator {
    return this.page.getByRole('button', { name: /^(立即开户|查看详情|查看审核进度)$/ });
  }

  private async cardText(button: Locator): Promise<string> {
    return button.evaluate(element => {
      let current = element.parentElement;
      while (current) {
        const text = (current.innerText ?? '').trim();
        const actionCount = [...current.querySelectorAll('button')]
          .filter(candidate => /^(立即开户|查看详情|查看审核进度)$/.test((candidate.textContent ?? '').trim()))
          .length;
        if (text.includes('开户费用') && text.includes('可投市场') && actionCount === 1) {
          return text;
        }
        current = current.parentElement;
      }
      throw new Error('Unable to resolve the broker card containing the action button.');
    });
  }
}
