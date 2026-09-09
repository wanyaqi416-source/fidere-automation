import { expect, type Page } from '@playwright/test';
import { maskSensitiveText } from '../../src/reporting/sensitive-data-mask';
import { assertSandboxEnvironment } from '../../src/flow-engine';

export class BrokerOpeningReviewPage {
  private approvalFormOpenClicks = 0;
  private approvalClicks = 0;
  constructor(readonly page: Page) {}

  async goto(baseURL: string): Promise<void> {
    await this.page.goto(new URL('/zh-CN/kyc/brokerAccountManagement', baseURL).toString(), { waitUntil: 'domcontentloaded' });
    await expect(this.page.getByPlaceholder(/客户名称.*邮箱/)).toBeVisible();
  }

  async searchEmail(email: string): Promise<void> {
    await this.page.getByPlaceholder(/客户名称.*邮箱/).fill(email);
    await this.page.getByRole('button', { name: '查询', exact: true }).click();
    await expect(this.page.getByRole('columnheader', { name: /客户/ }).first()).toBeVisible();
    await expect(this.page.getByText(/最后同步/)).toBeVisible();
  }

  async readSafeState(): Promise<string> {
    return maskSensitiveText(await this.page.locator('body').ariaSnapshot());
  }

  async readRows(): Promise<BrokerOpeningRow[]> {
    return this.page.getByRole('table').getByRole('row').evaluateAll(rows => {
      return rows.flatMap(row => {
        const cells = [...row.querySelectorAll('td')];
        if (cells.length !== 6) return [];
        const values = cells.map(cell => (cell as HTMLElement).innerText.trim());
        const links = [...row.querySelectorAll('a[href]')].map(link => link.getAttribute('href') ?? '');
        const detailPath = links.find(path => /\/brokerAccountManagement\/[^/?]+(?:\?|$)/.test(path));
        return [{ customerText: values[0], accountType: values[1], broker: values[2],
          submittedAt: values[3], status: values[4], detailPath,
          reference: detailPath?.match(/\/brokerAccountManagement\/([^/?]+)/)?.[1] }];
      });
    });
  }

  async collectRows(): Promise<BrokerOpeningRow[]> {
    const rows: BrokerOpeningRow[] = [];
    const seenPages = new Set<string>();
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const current = await this.readRows();
      const fingerprint = JSON.stringify(current);
      if (seenPages.has(fingerprint)) throw new Error('Broker pagination repeated a page; candidate coverage is incomplete.');
      seenPages.add(fingerprint);
      rows.push(...current);
      const next = this.page.getByRole('button', { name: 'Go to next page', exact: true });
      if (await next.isDisabled()) return rows;
      await next.click();
      await expect.poll(async () => JSON.stringify(await this.readRows()) !== fingerprint).toBe(true);
    }
    throw new Error('Broker candidate collection exceeded the bounded page limit.');
  }

  async openDetail(row: BrokerOpeningRow): Promise<void> {
    if (!row.reference || !row.detailPath) throw new Error('A real broker application reference is required.');
    await this.page.goto(new URL(row.detailPath, this.page.url()).toString(), { waitUntil: 'domcontentloaded' });
    await expect(this.page.getByRole('heading', { name: '申请概览', exact: true })).toBeVisible();
  }

  async inspectProcess(reference: string): Promise<unknown> {
    if (!/^\d+$/.test(reference)) throw new Error('Observed numeric broker reference required.');
    await this.page.goto(new URL(`/zh-CN/kyc/brokerAccountManagement/${reference}/process`, this.page.url()).toString(), { waitUntil: 'domcontentloaded' });
    await expect(this.page.getByRole('button', { name: '保存处理结果', exact: true })).toBeVisible();
    const controls = await this.page.getByRole('main').locator('input,textarea,[role="combobox"]').evaluateAll(elements => elements.map(element => ({
      tag: element.tagName, role: element.getAttribute('role'), type: element.getAttribute('type'),
      label: element.getAttribute('aria-label'), placeholder: element.getAttribute('placeholder'),
      labels: [...((element as HTMLInputElement).labels ?? [])].map(label => label.textContent)
    })));
    await this.page.getByRole('combobox').click();
    const options = await this.page.getByRole('option').allTextContents();
    await this.page.keyboard.press('Escape');
    return { controls, options, finalButtonEnabled: await this.page.getByRole('button', { name: '保存处理结果', exact: true }).isEnabled() };
  }

  async verifyDetail(row: BrokerOpeningRow, identity: { email: string; displayName: string }, broker: 'TIGER' | 'WEBULL' = 'TIGER'): Promise<void> {
    await this.openDetail(row);
    const main = this.page.getByRole('main');
    await expect(main).toContainText(identity.email);
    await expect(main).toContainText(identity.displayName);
    await expect(main).toContainText(broker === 'WEBULL' ? /WEBULL|微牛证券/i : /TIGER|老虎证券/i);
    await expect(main).toContainText(row.status);
    await expect(main).toContainText(row.submittedAt);
    const reference = new URL(this.page.url()).pathname.match(/\/brokerAccountManagement\/([^/]+)$/)?.[1];
    expect(reference).toBe(row.reference);
  }

  async fillApprovalForm(row: BrokerOpeningRow, note: string): Promise<void> {
    if (!row.reference || !/^\d+$/.test(row.reference)) throw new Error('Unique broker reference required.');
    await this.page.goto(new URL(`/zh-CN/kyc/brokerAccountManagement/${row.reference}/process`, this.page.url()).toString(), { waitUntil: 'domcontentloaded' });
    await expect(this.page.getByRole('button', { name: '保存处理结果', exact: true })).toBeVisible();
    await this.page.getByRole('combobox').click();
    await this.page.getByRole('option', { name: '审核通过', exact: true }).click();
    await this.page.getByPlaceholder('记录本次处理说明', { exact: true }).fill(note);
    await expect(this.page.getByRole('combobox')).toHaveText('审核通过');
    await expect(this.page.getByPlaceholder('记录本次处理说明', { exact: true })).toHaveValue(note);
    await expect(this.page.getByRole('button', { name: '保存处理结果', exact: true })).toBeEnabled();
  }

  async openApprovalConfirmationOnce(): Promise<void> {
    assertSandboxEnvironment(this.page.url());
    if (this.approvalFormOpenClicks !== 0 || this.approvalClicks !== 0) throw new Error('Broker confirmation may only open once per page session.');
    const button = this.page.getByRole('button', { name: '保存处理结果', exact: true });
    await expect(button).toBeEnabled();
    this.approvalFormOpenClicks++;
    await button.click();
    await expect(this.approvalDialog).toBeVisible();
    await expect(this.approvalDialog.getByRole('button', { name: '确认通过', exact: true })).toBeVisible();
  }

  async readApprovalConfirmationFields(): Promise<unknown> {
    await expect(this.approvalDialog).toBeVisible();
    return this.approvalDialog.locator('input').evaluateAll(elements => elements.map(element => {
      const input = element as HTMLInputElement;
      return {
      type: input.type, placeholder: input.placeholder, required: input.required,
      labels: [...(input.labels ?? [])].map(label => label.textContent),
      valuePresent: Boolean(input.value), readOnly: input.readOnly
      };
    }));
  }

  async fillApprovalConfirmation(input: { accountName: string; accountNumber: string; openingDate: string }): Promise<void> {
    if (!input.accountName.trim() || !input.accountNumber.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(input.openingDate)) throw new Error('Sandbox broker account name, assigned number and opening date are required.');
    await this.approvalDialog.getByRole('textbox', { name: '账户名称', exact: true }).fill(input.accountName);
    await this.approvalDialog.getByRole('textbox', { name: '券商账户号码', exact: true }).fill(input.accountNumber);
    const date = this.approvalDialog.getByLabel('开户时间', { exact: false });
    const type = await date.getAttribute('type');
    if (type !== 'date') throw new Error('Broker opening date control requires verification against its actual input contract.');
    await date.fill(input.openingDate);
    await expect(this.approvalDialog.getByRole('button', { name: '确认通过', exact: true })).toBeEnabled();
  }

  async approveOnce(): Promise<void> {
    assertSandboxEnvironment(this.page.url());
    if (process.env.ALLOW_ADMIN_MUTATION_TESTS !== 'true' || this.approvalClicks !== 0) throw new Error('Broker final approval requires authorization and one click only.');
    const button = this.approvalDialog.getByRole('button', { name: '确认通过', exact: true });
    await expect(button).toBeEnabled();
    const inputs = await this.approvalDialog.locator('input').all();
    for (const input of inputs) {
      if (await input.isVisible() && !await input.inputValue()) throw new Error('A required broker account field is empty.');
    }
    this.approvalClicks++;
    await Promise.all([
      this.page.waitForResponse(response => new URL(response.url()).origin === new URL(this.page.url()).origin
        && ['POST', 'PUT', 'PATCH'].includes(response.request().method()), { timeout: 30_000 }),
      button.click()
    ]);
  }

  approvalClickCount(): number { return this.approvalClicks; }
  approvalFormOpenClickCount(): number { return this.approvalFormOpenClicks; }
  private get approvalDialog() {
    return this.page.getByRole('dialog').filter({ has: this.page.getByRole('heading', { name: '审核通过', exact: true }) });
  }
}

export type BrokerOpeningRow = {
  customerText: string;
  accountType: string;
  broker: string;
  submittedAt: string;
  status: string;
  detailPath?: string;
  reference?: string;
};
