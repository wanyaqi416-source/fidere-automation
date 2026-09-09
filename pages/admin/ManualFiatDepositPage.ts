import { expect, type Page } from '@playwright/test';
import { maskSensitiveText } from '../../src/reporting/sensitive-data-mask';
import { assertSandboxEnvironment } from '../../src/flow-engine';
import { Decimal } from '../../src/utils/money';
import { ManualFiatForm } from './ManualFiatForm';

export class ManualFiatDepositPage {
  private submissionClicks = 0;
  private confirmationOpenClicks = 0;
  private readonly network: { path: string; status: number; time: string }[] = [];
  constructor(readonly page: Page) {}

  async goto(baseURL: string): Promise<void> {
    await this.page.goto(new URL('/zh-CN/operation/fiatAssets', baseURL).toString(), { waitUntil: 'domcontentloaded' });
    await expect(this.page.getByRole('button', { name: '手动入金', exact: true })).toBeVisible();
  }

  async openForm(): Promise<void> {
    await this.page.getByRole('button', { name: '手动入金', exact: true }).click();
  }

  async readSafeForm(): Promise<string> {
    return maskSensitiveText(await this.page.locator('body').ariaSnapshot());
  }

  async readLedgerPreflight(baseURL: string, runId: string): Promise<unknown> {
    await this.goto(baseURL);
    await this.page.getByRole('tab', { name: '流水查询', exact: true }).click();
    await expect(this.page.getByRole('columnheader').first()).toBeVisible();
    const controls = await this.page.locator('main input').evaluateAll(inputs => inputs.map(element => ({
      placeholder: element.getAttribute('placeholder'), type: element.getAttribute('type'),
      label: element.getAttribute('aria-label')
    })));
    return { headers: await this.page.getByRole('columnheader').allTextContents(), controls,
      visibleRunRows: (await this.page.getByRole('row').filter({ hasText: runId }).allInnerTexts()).map(maskSensitiveText) };
  }

  async findRunLedger(baseURL: string, runId: string): Promise<Record<string, string>[]> {
    await this.goto(baseURL);
    await this.page.getByRole('tab', { name: '流水查询', exact: true }).click();
    const keyword = this.page.getByPlaceholder('参考号、备注...', { exact: true });
    await keyword.fill(runId);
    const responsePromise = this.page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === new URL(this.page.url()).origin &&
        ([...url.searchParams.values()].some(value => value.includes(runId)) ||
          Boolean(response.request().postData()?.includes(runId)));
    }, { timeout: 20_000 });
    const [response] = await Promise.all([responsePromise, this.page.getByRole('button', { name: '查询', exact: true }).click()]);
    expect(response.ok()).toBe(true);
    await expect(this.page.getByRole('columnheader', { name: '备注说明', exact: true })).toBeVisible();
    const headers = (await this.page.getByRole('columnheader').allTextContents()).map(value => value.trim());
    const rows: Record<string, string>[] = [];
    for (const row of await this.page.getByRole('row').filter({ hasText: runId }).all()) {
      const cells = (await row.getByRole('cell').allInnerTexts()).map(value => value.trim());
      if (cells.length !== headers.length) throw new Error('Manual deposit ledger headers/row mismatch.');
      rows.push(Object.fromEntries(headers.map((header, index) => [header, cells[index]])));
    }
    return rows;
  }

  async chooseCustomer(email: string): Promise<void> {
    await new ManualFiatForm(this.page).chooseCustomer(email);
  }

  async openAccountOptions(): Promise<void> {
    await new ManualFiatForm(this.page).openAccountOptions();
  }

  async selectAccountAndOpenChannels(account: string): Promise<void> {
    await this.openAccountOptions();
    const option = this.page.getByRole('option').filter({ hasText: account });
    await expect(option).toHaveCount(1);
    await option.click();
    await this.page.locator('label').filter({ hasText: /^打款渠道$/ }).locator('..').getByRole('combobox').click();
  }

  async fillForm(input: { email: string; displayName: string; amount: string; note: string }): Promise<void> {
    await this.chooseCustomer(input.email);
    expect(await this.page.getByRole('combobox', { name: '选择客户', exact: true }).inputValue() === `${input.displayName} (${input.email})`).toBe(true);
    await this.selectAccountAndOpenChannels('香港账户');
    await this.page.getByRole('option', { name: 'Others', exact: true }).click();
    await expect(this.page.locator('label').filter({ hasText: /^币种/ }).locator('..').getByRole('combobox')).toHaveText('USD - 美元');
    await this.page.getByRole('spinbutton', { name: '入金金额', exact: true }).fill(input.amount);
    await this.page.getByRole('textbox', { name: '备注说明', exact: true }).fill(input.note);
    await expect(this.page.getByRole('button', { name: '确认入金', exact: true })).toBeEnabled();
    if (!new Decimal(await this.page.getByRole('spinbutton', { name: '入金金额', exact: true }).inputValue()).equals(input.amount)) {
      throw new Error('Manual deposit form amount mismatch.');
    }
  }

  async openConfirmation(input: { displayName: string; amount: string; note: string }): Promise<void> {
    if (this.confirmationOpenClicks) throw new Error('Confirmation is already opened in this page session.');
    this.confirmationOpenClicks++;
    await this.page.getByRole('button', { name: '确认入金', exact: true }).click();
    const dialog = this.confirmationDialog();
    await expect(dialog).toBeVisible();
    const text = await dialog.innerText();
    expect(text.includes(input.displayName) && text.includes(input.note)).toBe(true);
    const amountText = await dialog.getByRole('heading', { level: 6 }).filter({ hasText: /^USD\s/ }).innerText();
    expect(new Decimal(amountText.replace(/^USD\s*/, '').replaceAll(',', '')).equals(input.amount)).toBe(true);
    await expect(dialog.getByRole('button', { name: '确认入金', exact: true })).toBeEnabled();
  }

  safeNetworkEvidence() { return [...this.network]; }

  private confirmationDialog() {
    return this.page.getByRole('dialog').filter({ has: this.page.getByRole('heading', { name: '确认手动入金', exact: true }) });
  }

  async confirmOnce(): Promise<{ businessReference?: string }> {
    assertSandboxEnvironment(this.page.url());
    if (process.env.ALLOW_MONEY_TESTS !== 'true' || process.env.ALLOW_ADMIN_MUTATION_TESTS !== 'true' || this.submissionClicks !== 0) {
      throw new Error('Manual deposit requires money/Admin authorization and one submission only.');
    }
    const dialog = this.confirmationDialog();
    await expect(dialog).toBeVisible();
    if (this.confirmationOpenClicks !== 1) throw new Error('Validated second confirmation is required before final deposit.');
    const observe = (response: import('@playwright/test').Response) => {
      const url = new URL(response.url());
      if (response.request().method() === 'POST' && url.origin === new URL(this.page.url()).origin && /^\/(admin-api|api)\//.test(url.pathname)) {
        this.network.push({ path: url.pathname, status: response.status(), time: new Date().toISOString() });
      }
    };
    this.page.on('response', observe);
    this.submissionClicks++;
    try {
      await dialog.getByRole('button', { name: '确认入金', exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      await expect(this.page.getByRole('heading', { name: '手动入金', exact: true })).toBeHidden({ timeout: 20_000 });
      return {};
    } finally {
      this.page.off('response', observe);
      console.log('MANUAL_DEPOSIT_NETWORK ' + JSON.stringify(this.network));
    }
  }
}
