import { expect, type Locator, type Page } from '@playwright/test';
import { AccountDetailPage } from './AccountDetailPage';
import { SecurityKeyDialog } from './SecurityKeyDialog';
import { decodeClientKycStatus } from '../../src/registration/registration-kyc-contract';
import { parseTransferCurrencyDisplay, TRANSFER_FEE_CURRENCY_NAMES, type AccountTransferQuote } from '../../src/transfer/account-transfer-fee';
import { Decimal } from '../../src/utils/money';
import type { InternalTransferRecord } from '../../src/transfer/account-transfer-fee-run';

export class AccountInternalTransferPage {
  readonly security: SecurityKeyDialog;
  private confirmationAttempted = false;
  constructor(readonly page: Page) { this.security = new SecurityKeyDialog(page); }

  private field(label: string) { return this.page.getByText(label, { exact: true }).locator('..'); }
  private async selectField(label: string): Promise<Locator> {
    const text = this.page.getByText(label, { exact: true });
    await expect(text).toHaveCount(1);
    let scope = text;
    // The visible label is nested separately from the unlabelled MUI select.
    for (let depth = 0; depth < 6; depth++) {
      scope = scope.locator('..');
      const count = await scope.getByRole('combobox').count();
      if (count === 1) return scope.getByRole('combobox');
      if (count > 1) break;
    }
    throw new Error(`Account transfer ${label} does not identify one local select.`);
  }
  get submitButton() { return this.page.getByRole('button', { name: '提交审核', exact: true }); }

  async goto(baseURL: string): Promise<void> {
    await new AccountDetailPage(this.page).goto(baseURL);
    await this.page.getByRole('button', { name: '资金互转', exact: true }).click();
    await expect(this.page).toHaveURL(/\/account\/internal-transfer(?:$|[?#])/);
    await expect(this.page.getByPlaceholder('请输入转账金额', { exact: true })).toBeVisible();
    await expect(await this.selectField('转出账户')).toBeVisible();
  }

  async verifyIdentity(baseURL: string, email: string): Promise<void> {
    const response = await this.page.request.get(new URL('/server/auth/session', baseURL).toString());
    expect(response.ok(), 'Client session is readable').toBe(true);
    const data = await response.json();
    expect(String(data.user?.email ?? '').toLowerCase() === email.toLowerCase(), 'Client must use the configured default identity').toBe(true);
    expect(['1', '2']).toContain(String(data.entityType));
    const accountType = String(data.entityType) === '2' ? 'BUSINESS' : 'PERSONAL';
    expect(decodeClientKycStatus(data, { email, accountType }).approved, 'Configured user KYC/KYB must be approved').toBe(true);
  }

  async selectAccounts(source: string, target: string, currency = 'USD'): Promise<void> {
    if (source === target) throw new Error('Account internal transfer requires two distinct accounts.');
    if (!Object.hasOwn(TRANSFER_FEE_CURRENCY_NAMES, currency)) throw new Error('Unsupported internal transfer currency.');
    for (const [label, value] of [['转出账户', source], ['转入账户', target], ['币种', currency]]) {
      const select = await this.selectField(label);
      await expect(select).toHaveCount(1);
      if ((await select.innerText()).trim() !== value) {
        await select.click();
        const option = this.page.getByRole('option', { name: value, exact: true });
        await expect(option).toHaveCount(1); await expect(option).toBeEnabled(); await option.click();
      }
      await expect(select).toHaveText(value);
    }
  }

  async preview(amount: string): Promise<AccountTransferQuote> {
    const currency = (await (await this.selectField('币种')).innerText()).trim();
    const input = this.page.getByPlaceholder('请输入转账金额', { exact: true });
    await input.fill(amount); await input.press('Tab');
    await expect(input).toHaveValue(amount);
    await expect.poll(async () => this.summary('手续费'), { timeout: 20_000 }).toMatch(new RegExp(`^${currency}\\s+[\\d,.]+$`));
    await expect.poll(async () => parseTransferCurrencyDisplay(await this.summary('转账金额'), currency)).toBe(new Decimal(amount).toFixed(2));
    return this.readQuote();
  }

  private async summary(label: string): Promise<string> {
    const row = this.field(label);
    // Amount/fee use p; the emphasized net amount is an h6 in the same labelled row.
    const texts = (await row.locator('p, h6').allTextContents()).map(text => text.trim()).filter(text => text !== label);
    if (texts.length !== 1) throw new Error(`Account transfer summary ${label} is not unique.`);
    return texts[0];
  }

  async readQuote(): Promise<AccountTransferQuote> {
    const currency = (await (await this.selectField('币种')).innerText()).trim();
    return { sourceAccount: (await (await this.selectField('转出账户')).innerText()).trim(),
      targetAccount: (await (await this.selectField('转入账户')).innerText()).trim(),
      currency, amount: parseTransferCurrencyDisplay(await this.summary('转账金额'), currency),
      fee: parseTransferCurrencyDisplay(await this.summary('手续费'), currency),
      received: parseTransferCurrencyDisplay(await this.summary('预估到账金额'), currency) };
  }

  async fillRunNote(runId: string): Promise<void> {
    if (!/^[A-Z0-9._-]+$/i.test(runId)) throw new Error('Invalid transfer Run ID.');
    await this.page.getByPlaceholder('请输入备注信息', { exact: true }).fill(`AUTO_TRANSFER_FEE_${runId}`);
  }

  async confirmOnce(beforeClick: () => void): Promise<void> {
    if (this.confirmationAttempted) throw new Error('Account internal transfer confirmation already attempted.');
    await expect(this.submitButton).toBeEnabled();
    beforeClick(); this.confirmationAttempted = true;
    await this.submitButton.click(); await this.security.waitForOpen();
  }

  async expectNoSubmission(): Promise<void> {
    expect(this.confirmationAttempted || this.security.wasVerificationClicked()).toBe(false);
    await expect(this.security.dialog).toBeHidden();
  }

  async readRecords(baseURL: string): Promise<InternalTransferRecord[]> {
    // Submission may still redirect its page. Isolate read-only history navigation
    // so it cannot consume a response whose document is being replaced.
    const queryPage = await this.page.context().newPage();
    try { return await new AccountInternalTransferPage(queryPage).readHistoryPage(baseURL); }
    finally { await queryPage.close(); }
  }

  private async readHistoryPage(baseURL: string): Promise<InternalTransferRecord[]> {
    const loaded = this.page.waitForResponse(response => new URL(response.url()).origin === new URL(baseURL).origin &&
      new URL(response.url()).pathname === '/api/transfer/records' && response.request().method() === 'POST');
    await this.page.goto(new URL('/zh-CN/account/internal-transfer/history', baseURL).toString(), { waitUntil: 'domcontentloaded' });
    const response = await loaded;
    if (!response.ok()) throw new Error('Transfer history request failed.');
    // Reuse only this same-origin query's authentication, in memory; never persist or report it.
    const authorization = await response.request().headerValue('authorization');
    let payload = await response.json();
    const firstQuery = response.request().postDataJSON();
    if (firstQuery?.currentPage !== 1) throw new Error('Transfer history must begin with page one.');
    const pageSize = firstQuery?.pageSize;
    if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error('Transfer history page size is unavailable.');
    const total = payload.data?.total;
    if (!Number.isInteger(total) || total < 0 || total > pageSize * 50) throw new Error('Transfer history coverage limit or invalid total.');
    const records: InternalTransferRecord[] = [];
    const ids = new Set<string>();
    for (let currentPage = 1; currentPage <= Math.max(1, Math.ceil(total / pageSize)); currentPage++) {
      if (currentPage > 1) {
        // Keep this read-only POST in the authenticated browser, just like the visible history.
        const next = await this.page.evaluate(async ({ query, authorization }) => {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (authorization) headers.Authorization = authorization;
          const response = await fetch('/api/transfer/records', { method: 'POST', credentials: 'same-origin',
            headers, body: JSON.stringify(query) });
          return { status: response.status, payload: response.ok ? await response.json() : null };
        }, { query: { currentPage, pageSize }, authorization });
        if (!next.payload) throw new Error(`Transfer history pagination failed (HTTP ${next.status}).`);
        payload = next.payload;
      }
      if (payload.code !== 0 || payload.data?.total !== total || !Array.isArray(payload.data?.list)) {
        throw new Error('Transfer history business result or total changed during collection.');
      }
      for (const row of payload.data.list) {
        if (typeof row.orderNo !== 'string' || !/^TRF-[A-Z0-9-]+$/i.test(row.orderNo) || ids.has(row.orderNo)) {
          throw new Error('Transfer history is incomplete/duplicated or missing a real TRF.');
        }
        const applied = Number(row.appliedAt);
        if (!Number.isFinite(applied) || applied <= 0) throw new Error('Transfer creation time is unavailable.');
        ids.add(row.orderNo);
        records.push({ orderNo: row.orderNo, txNo: String(row.txNo ?? ''), transferType: String(row.transferType),
          fromRegion: String(row.fromRegion), toRegion: String(row.toRegion), currency: String(row.currency),
          amount: String(row.amount), fee: String(row.fee), actualAmount: String(row.actualAmount),
          status: String(row.status), remark: String(row.remark ?? ''), appliedAt: applied < 1e12 ? applied * 1000 : applied });
      }
    }
    if (records.length !== total) throw new Error('Cannot assert uniqueness from a partial transfer history.');
    return records;
  }
}
