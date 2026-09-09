import { expect, type Locator, type Page, type Response } from '@playwright/test';

export type AdminFiatAccountCandidate = {
  row: Locator;
  accountId: string;
  customerText: string;
  bankName: string;
  accountText: string;
  holderText: string;
  submittedAtText: string;
};

export type AdminFiatApprovalEvidence = {
  requestPath?: string;
  httpStatus?: number;
  observedAt?: string;
  approvalEntryClicks: number;
  approvalConfirmationClicks: number;
};

type SafeResponse = {
  path: string;
  status: number;
  observedAt: string;
};

export class AdminFiatAccountReviewPage {
  private approvalEntryClickCount = 0;
  private approvalConfirmationClickCount = 0;

  constructor(readonly page: Page) {}

  async goto(baseURL: string, status: '待审核' | '已通过' | '已拒绝' = '待审核'): Promise<void> {
    await this.page.goto(new URL('/zh-CN/kyc/fatAccounts', baseURL).toString(), {
      waitUntil: 'domcontentloaded'
    });
    await expect(
      this.page,
      'Admin storageState is expired. Run npm run auth:admin before Fiat Account review.'
    ).not.toHaveURL(/\/login|\/signin|\/sign-in/i);
    await expect(this.page.locator('main')).toBeVisible();
    const tab = this.page.getByRole('tab', { name: status, exact: true });
    await expect(tab).toBeVisible();
    await tab.click();
    await this.waitForRowsToSettle();
  }

  async search(value: string): Promise<void> {
    const search = this.page.getByPlaceholder('搜索账户ID、用户名、账号...', { exact: true });
    await expect(search).toBeVisible();
    await search.fill(value);
    await search.press('Enter');
    await expect(search).toHaveValue(value);
    await this.waitForRowsToSettle();
  }

  async locateCandidate(input: {
    email: string;
    displayName: string;
    bankName: string;
    bankAccount: string;
  }): Promise<{ candidateCount: number; candidates: AdminFiatAccountCandidate[] }> {
    await this.search(input.email);
    const accountSuffix = input.bankAccount.slice(-4);
    const candidates = (await this.readRows()).filter(candidate => {
      const customer = candidate.customerText.toLowerCase();
      const customerMatches = customer.includes(input.email.toLowerCase());
      const accountNumbers = candidate.accountText.match(/\d{6,}/g) ?? [];
      return customerMatches &&
        candidate.bankName.includes(input.bankName) &&
        accountNumbers.some(account => account === input.bankAccount || account.endsWith(accountSuffix)) &&
        candidate.holderText.includes(input.displayName);
    });
    return { candidateCount: candidates.length, candidates };
  }

  async openUnique(candidate: AdminFiatAccountCandidate): Promise<void> {
    await this.scrollActionsIntoView();
    const detail = candidate.row.getByRole('link');
    await expect(detail).toHaveCount(1);
    await detail.scrollIntoViewIfNeeded();
    await detail.click();
    await expect(this.page).toHaveURL(/\/zh-CN\/kyc\/fatAccounts\/[^/?#]+(?:$|[?#])/);
    await expect(this.page.getByRole('heading', { name: '账户信息', exact: true })).toBeVisible();
  }

  async verifyDetail(input: {
    email: string;
    displayName: string;
    bankName: string;
    bankAccount: string;
    swiftCode: string;
    expectApprovalAction?: boolean;
  }): Promise<void> {
    const text = (await this.page.locator('main').innerText()).replace(/\s+/g, ' ');
    expect(text).toContain(input.displayName);
    expect(text).toContain(input.bankName);
    expect(text).toContain(input.bankAccount.slice(-4));
    expect(text).toContain(input.swiftCode);
    const identityMatches = text.toLowerCase().includes(input.email.toLowerCase()) ||
      text.includes(input.displayName);
    expect(identityMatches).toBe(true);
    if (input.expectApprovalAction !== false) {
      await expect(this.page.getByRole('button', { name: '通过', exact: true })).toBeVisible();
    }
  }

  async approveOnce(): Promise<AdminFiatApprovalEvidence> {
    if (this.approvalEntryClickCount !== 0 || this.approvalConfirmationClickCount !== 0) {
      throw new Error('Admin Fiat Account approval is limited to once per Run.');
    }
    const observed: SafeResponse[] = [];
    const origin = new URL(this.page.url()).origin;
    const listener = (response: Response): void => {
      const url = new URL(response.url());
      if (url.origin !== origin || !url.pathname.startsWith('/admin-api/')) return;
      if (!['POST', 'PUT', 'PATCH'].includes(response.request().method())) return;
      observed.push({ path: url.pathname, status: response.status(), observedAt: new Date().toISOString() });
    };

    this.page.on('response', listener);
    try {
      this.approvalEntryClickCount += 1;
      await this.page.getByRole('button', { name: '通过', exact: true }).click();
      await expect.poll(async () => {
        const dialog = this.page.getByRole('dialog').last();
        const dialogVisible = await dialog.isVisible().catch(() => false);
        const successVisible = await this.page.getByText(/审核通过|操作成功|提交成功/).first()
          .isVisible().catch(() => false);
        return dialogVisible || observed.length > 0 || successVisible;
      }, {
        timeout: 20_000,
        intervals: [250, 500, 1_000],
        message: 'Admin Fiat Account approval produced neither confirmation nor response.'
      }).toBe(true);

      const dialog = this.page.getByRole('dialog').last();
      if (await dialog.isVisible().catch(() => false)) {
        await expect(dialog.getByRole('heading', { name: '确认通过审核', exact: true })).toBeVisible();
        const confirm = dialog.getByRole('button', { name: '确认通过', exact: true });
        await expect(confirm).toHaveCount(1);
        this.approvalConfirmationClickCount += 1;
        await confirm.click();
      }

      await expect.poll(() => observed.length, {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
        message: 'Admin Fiat Account approval request was not observed.'
      }).toBeGreaterThan(0);
    } finally {
      this.page.off('response', listener);
    }

    const relevant = observed.find(item => /fiat|fat-account|account.*review|review.*account/i.test(item.path))
      ?? observed.at(-1);
    return {
      requestPath: relevant?.path,
      httpStatus: relevant?.status,
      observedAt: relevant?.observedAt,
      approvalEntryClicks: this.approvalEntryClickCount,
      approvalConfirmationClicks: this.approvalConfirmationClickCount
    };
  }

  approvalClicks(): number {
    return this.approvalEntryClickCount;
  }

  private async readRows(): Promise<AdminFiatAccountCandidate[]> {
    const output: AdminFiatAccountCandidate[] = [];
    for (const row of await this.page.locator('tbody tr').all()) {
      if (!await row.isVisible()) continue;
      const cells = await row.locator('td').allInnerTexts();
      if (cells.length < 7) continue;
      output.push({
        row,
        accountId: cells[0].trim(),
        customerText: cells[1].replace(/\s+/g, ' ').trim(),
        bankName: cells[2].replace(/\s+/g, ' ').trim(),
        accountText: cells[3].replace(/\s+/g, ' ').trim(),
        holderText: cells[4].replace(/\s+/g, ' ').trim(),
        submittedAtText: cells[5].replace(/\s+/g, ' ').trim()
      });
    }
    return output;
  }

  private async waitForRowsToSettle(): Promise<void> {
    let previous = '';
    let stable = 0;
    await expect.poll(async () => {
      const rows = (await this.page.locator('tbody tr').allInnerTexts())
        .map(value => value.replace(/\s+/g, ' ').trim());
      const signature = JSON.stringify(rows);
      stable = signature === previous ? stable + 1 : 0;
      previous = signature;
      return stable >= 2;
    }, {
      timeout: 20_000,
      intervals: [300, 500, 750, 1_000],
      message: 'Admin Fiat Account rows did not settle.'
    }).toBe(true);
  }

  private async scrollActionsIntoView(): Promise<void> {
    const table = this.page.getByRole('table');
    await expect(table).toBeVisible();
    await table.evaluate(element => {
      let current: HTMLElement | null = element.parentElement;
      while (current) {
        if (current.scrollWidth > current.clientWidth) {
          current.scrollLeft = current.scrollWidth;
          return;
        }
        current = current.parentElement;
      }
    });
  }
}
