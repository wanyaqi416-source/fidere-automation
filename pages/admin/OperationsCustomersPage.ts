import { expect, type Locator, type Page, type Request } from '@playwright/test';
import { assertSandboxEnvironment } from '../../src/flow-engine';
import {
  COUNTRY_LABELS, parseOperationsCustomer, type OpeningCountry, type OperationsCustomer,
  type OperationsOpeningForm, type OperationsOpeningIdentity
} from '../../src/account-opening/admin-operations-opening';

const LIST_PATH = '/admin-api/operation/account-domain/list';

export class OperationsCustomersPage {
  private confirmationClicks = 0;
  constructor(readonly page: Page) {}

  isReadonlyList(request: Request): boolean {
    return new URL(request.url()).pathname === LIST_PATH && request.method() === 'POST';
  }

  async goto(baseURL: string): Promise<void> {
    assertSandboxEnvironment(baseURL);
    const loaded = this.page.waitForResponse(response => this.isReadonlyList(response.request()));
    await this.page.goto(new URL('/zh-CN/operation/clients', baseURL).toString(), { waitUntil: 'domcontentloaded' });
    const response = await loaded;
    if (!response.ok()) throw new Error('Admin operations customer list query failed.');
    await expect(this.page).not.toHaveURL(/\/(login|signin|sign-in)/i);
    await expect(this.page.getByRole('columnheader', { name: '客户信息', exact: true })).toBeVisible();
    await expect.poll(async () => this.page.getByRole('table').getByRole('cell').count()).toBeGreaterThan(0);
  }

  async searchEmail(email: string): Promise<void> {
    const search = this.page.getByPlaceholder('搜索用户名、ID或客户编号...');
    await search.fill(email);
    await search.press('Enter');
    await expect.poll(async () => {
      const rows = await this.readRows();
      return rows.length > 0 && rows.every(row => row.email.toLowerCase() === email.toLowerCase());
    }, { timeout: 20_000 }).toBe(true);
    // Never claim uniqueness from a partial page of exact-email search results.
    await expect(this.page.getByRole('button', { name: 'Go to previous page', exact: true })).toBeDisabled();
    await expect(this.page.getByRole('button', { name: 'Go to next page', exact: true })).toBeDisabled();
  }

  async readRows(): Promise<OperationsCustomer[]> {
    // Read the header and body in one DOM snapshot; search temporarily renders skeleton headers.
    const snapshot = await this.page.getByRole('table').evaluate(table => ({
      headers: Array.from(table.querySelectorAll('th')).map(cell => cell.textContent?.trim() || ''),
      cells: Array.from(table.querySelectorAll('tr')).map(row => Array.from(row.querySelectorAll('td'))
        .map(cell => (cell as HTMLElement).innerText)).filter(row => row.length > 1)
    }));
    if (snapshot.headers.every(header => !header)) return [];
    return snapshot.cells.map(row => parseOperationsCustomer(snapshot.headers, row));
  }

  private row(identity: OperationsOpeningIdentity): Locator {
    return this.page.getByRole('table').getByRole('row')
      .filter({ has: this.page.getByText(identity.email, { exact: true }) })
      .filter({ has: this.page.getByText(`ID: ${identity.userId}`, { exact: true }) });
  }

  private countryCard(row: Locator, country: OpeningCountry): Locator {
    // The verified DOM has one card containing this country's label and action, not the sibling country.
    return row.locator('div').filter({ has: this.page.getByText(COUNTRY_LABELS[country], { exact: true }) })
      .filter({ has: this.page.getByRole('button', { name: /^(开通|编辑)$/ }) })
      .filter({ hasNot: this.page.getByText(COUNTRY_LABELS[country === 'BH' ? 'SG' : 'BH'], { exact: true }) });
  }

  async openCountryForm(identity: OperationsOpeningIdentity, country: OpeningCountry): Promise<void> {
    const row = this.row(identity);
    await expect(row).toHaveCount(1);
    const card = this.countryCard(row, country);
    await expect(card).toHaveCount(1);
    await expect(card.getByText('未开通', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: '开通', exact: true }).click();
    await this.expectFormIdentity(identity, country);
  }

  async expectFormIdentity(identity: OperationsOpeningIdentity, country: OpeningCountry): Promise<void> {
    const dialog = this.page.getByRole('dialog');
    await expect(dialog).toHaveCount(1);
    await expect(dialog.getByRole('heading', { name: `开通${COUNTRY_LABELS[country]}`, exact: true })).toBeVisible();
    await expect(dialog.getByText(`${identity.displayName} / UID-${identity.userId}`, { exact: true })).toBeVisible();
    await expect(dialog.getByText('后台手动开通', { exact: true })).toBeVisible();
    await expect(dialog.getByText('未开通', { exact: true })).toBeVisible();
  }

  async fillForm(form: OperationsOpeningForm): Promise<void> {
    const dialog = this.page.getByRole('dialog');
    await expect(dialog.getByRole('textbox', { name: '收款人', exact: true })).toHaveAttribute('required', '');
    await expect(dialog.getByRole('textbox', { name: '账户号码', exact: true })).toHaveAttribute('required', '');
    await dialog.getByRole('textbox', { name: '收款人', exact: true }).fill(form.holder);
    await dialog.getByRole('textbox', { name: '账户号码', exact: true }).fill(form.accountNumber);
    await dialog.getByRole('textbox', { name: 'IBAN（选填）', exact: true }).fill(form.iban);
    await dialog.getByRole('textbox', { name: '备注', exact: true }).fill(form.note);
    // The fee-bearing branch needs separate, verified payer/debit evidence.
    await expect(dialog.getByRole('textbox', { name: '开户费金额', exact: true })).toHaveAttribute('placeholder', '空或 0 表示免费');
    const feeInput = dialog.getByRole('textbox', { name: '开户费金额', exact: true });
    if (form.fee === '') await expect(feeInput).toHaveValue('');
    else await feeInput.fill(form.fee);
    await this.expectFormValues(form);
  }

  async expectFormValues(form: OperationsOpeningForm): Promise<void> {
    const dialog = this.page.getByRole('dialog');
    for (const [name, value] of Object.entries({ 收款人: form.holder, 账户号码: form.accountNumber,
      'IBAN（选填）': form.iban, 备注: form.note, 开户费金额: form.fee })) {
      // Boolean comparisons keep full bank details out of assertion errors.
      expect(await dialog.getByRole('textbox', { name, exact: true }).inputValue() === value,
        `Opening form field ${name} must retain its configured value`).toBe(true);
    }
    await expect(dialog.getByRole('combobox')).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '确认开通', exact: true })).toBeEnabled();
  }

  async cancel(): Promise<void> {
    await this.page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    await expect(this.page.getByRole('dialog')).toBeHidden();
  }

  async confirmOnce(beforeClick: () => void): Promise<void> {
    if (this.confirmationClicks !== 0) throw new Error('Opening confirmation already attempted; read-only Resume only.');
    const button = this.page.getByRole('dialog').getByRole('button', { name: '确认开通', exact: true });
    await expect(button).toBeEnabled();
    beforeClick();
    this.confirmationClicks++;
    await button.click();
  }

  async waitForConfirmationClosed(): Promise<void> {
    await expect(this.page.getByRole('dialog')).toBeHidden({ timeout: 30_000 });
  }

  counts(): { finalSubmissionClicks: number } { return { finalSubmissionClicks: this.confirmationClicks }; }
}
