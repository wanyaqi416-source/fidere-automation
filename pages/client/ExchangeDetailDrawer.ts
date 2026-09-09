import { expect, type Locator, type Page } from '@playwright/test';

export type ExchangeDetail = {
  exchangeOrderId: string;
  status: string;
  actualReceivedAmount: string;
  fee: string;
  createdAt: string;
  completedAt: string;
  sourceAmount: string;
  sourceCurrency: string;
  targetAmount: string;
  targetCurrency: string;
};

function adjacentValue(text: string, label: string): string | undefined {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 1 && lines[0].startsWith(label)) {
    return lines[0].slice(label.length).trim() || undefined;
  }

  const values = lines.filter(line => line !== label && line !== '复制');
  return values.length === 1 ? values[0] : undefined;
}

export class ExchangeDetailDrawer {
  readonly page: Page;
  readonly drawer: Locator;
  readonly title: Locator;

  constructor(page: Page) {
    this.page = page;
    this.title = page.getByText(/^兑换\s*详情$/);
    this.drawer = page
      .locator('div')
      .filter({ has: this.title })
      .filter({ has: page.getByText('兑换信息', { exact: true }) })
      .last();
  }

  async waitForOpen(): Promise<void> {
    await expect(this.drawer).toBeVisible();
    await expect(this.title).toBeVisible();
  }

  async readField(label: string): Promise<string> {
    const fieldLabel = this.drawer.getByText(label, { exact: true });
    await expect(fieldLabel).toBeVisible();

    let container = fieldLabel.locator('..');
    for (let depth = 0; depth < 2; depth += 1) {
      const value = adjacentValue(await container.innerText(), label);

      if (value) {
        return value;
      }

      container = container.locator('..');
    }

    throw new Error(`兑换详情字段“${label}”没有可读取的相邻值。`);
  }

  async read(): Promise<ExchangeDetail> {
    const status = this.drawer.getByText('已完成', { exact: true });
    const actualReceivedAmount = this.drawer.getByRole('heading', { level: 4 });
    await expect(status).toBeVisible();
    await expect(actualReceivedAmount).toBeVisible();

    return {
      exchangeOrderId: await this.readField('交易编号'),
      status: (await status.innerText()).trim(),
      actualReceivedAmount: (await actualReceivedAmount.innerText()).trim(),
      fee: await this.readField('手续费'),
      createdAt: await this.readField('创建日期'),
      completedAt: await this.readField('完成日期'),
      sourceAmount: await this.readField('兑换前金额'),
      sourceCurrency: await this.readField('兑换前币种'),
      targetAmount: await this.readField('兑换后金额'),
      targetCurrency: await this.readField('兑换后币种')
    };
  }
}
