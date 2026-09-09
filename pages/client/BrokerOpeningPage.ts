import { expect, type Page } from '@playwright/test';
import { SecurityKeyDialog } from './SecurityKeyDialog';
import { assertSandboxEnvironment } from '../../src/flow-engine';
import { maskSensitiveText } from '../../src/reporting/sensitive-data-mask';

export class BrokerOpeningPage {
  readonly securityKey: SecurityKeyDialog;
  private confirmationClicks = 0;

  constructor(readonly page: Page) { this.securityKey = new SecurityKeyDialog(page); }

  async readFee(): Promise<{ amount: string; currency: string }> {
    const heading = this.page.getByRole('heading', { level: 3 });
    await expect(heading).toHaveCount(1);
    const match = (await heading.innerText()).match(/^([\d,.]+)\s+([A-Z]{3})$/);
    if (!match) throw new Error('Actual broker opening fee is unavailable.');
    return { amount: match[1].replaceAll(',', ''), currency: match[2] };
  }

  async continueWebullToDocuments(): Promise<void> {
    await this.page.getByRole('checkbox', { name: /我已阅读并确认开户费用/ }).check();
    await this.page.getByRole('button', { name: '确认并继续上传资料', exact: true }).click();
    await expect(this.page.getByRole('checkbox', { name: /我已阅读并确认开户费用/ })).toBeHidden();
    await expect(this.page.getByRole('heading', { name: '上传开户资料', exact: true })).toBeVisible();
    await expect(this.page.getByText('W-8BEN 表格', { exact: true })).toBeVisible();
    await expect(this.page.getByText('CRS 控制人表格', { exact: true })).toBeVisible();
  }

  async readSafeState(): Promise<string> {
    return new URL(this.page.url()).pathname + '\n' + maskSensitiveText(await this.page.locator('body').ariaSnapshot());
  }

  async confirmFeeOnce(): Promise<void> {
    assertSandboxEnvironment(this.page.url());
    if (process.env.ALLOW_MONEY_TESTS !== 'true' || this.confirmationClicks) throw new Error('Broker opening requires money authorization and a single fee confirmation.');
    const button = this.page.getByRole('button', { name: '确认缴费并开户', exact: true });
    await expect(button).toBeEnabled();
    this.confirmationClicks++;
    await button.click();
    await this.securityKey.waitForOpen();
  }
}
