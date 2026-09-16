import { expect, type Locator, type Page } from '@playwright/test';

export type AdminClientUserSummary = {
  row: Locator;
  rowText: string;
};

export type AdminRegistrationCandidate = {
  candidateCount: number;
  route: string;
};

export type AdminDepositCustomerIdentity = {
  accountType: 'PERSONAL' | 'BUSINESS';
  userId: string;
  name: string;
};

const registrationViews = [
  '/zh-CN/kyc/dashboard',
  '/zh-CN/kyc/processingReviews',
  '/zh-CN/kyc/userManagement'
] as const;

function isTransientNavigationError(error: unknown): boolean {
  return error instanceof Error && /Execution context was destroyed|most likely because of a navigation/i.test(
    error.message
  );
}

export class AdminClientUsersPage {
  readonly searchInput: Locator;
  readonly rows: Locator;

  constructor(readonly page: Page) {
    this.searchInput = page.locator('input[name="keyword"]').first();
    this.rows = page.locator('tbody tr');
  }

  async expectAuthenticatedShell(baseURL: string): Promise<void> {
    await this.page.goto(new URL('/zh-CN/kyc/userManagement', baseURL).toString(), {
      waitUntil: 'domcontentloaded'
    });
    await expect(
      this.page,
      'Admin storageState is expired. Run npm run auth:admin.'
    ).not.toHaveURL(/\/login|\/signin|\/sign-in/i);
    await expect(this.page.locator('main')).toBeVisible({ timeout: 20_000 });

    const obviousErrors = this.page.getByText(
      /(?:Internal Server Error|Service Unavailable|系统异常|服务不可用|页面加载失败)/i
    );
    for (const error of await obviousErrors.all()) {
      if (await error.isVisible()) {
        throw new Error('Admin authenticated shell displays an obvious system error.');
      }
    }
  }

  async goto(baseURL: string): Promise<void> {
    await this.page.goto(new URL('/zh-CN/kyc/userManagement', baseURL).toString(), {
      waitUntil: 'domcontentloaded'
    });
    await expect(
      this.page,
      'Admin storageState is expired on the client user list. Run npm run auth:admin.'
    ).not.toHaveURL(/\/login|\/signin|\/sign-in/i);
    await expect(this.page).toHaveURL(/\/kyc\/userManagement(?:$|[?#])/);
    await expect(this.searchInput).toBeVisible();
  }

  async search(identity: string): Promise<void> {
    await expect(this.searchInput).toBeVisible({ timeout: 20_000 });
    await this.searchInput.fill(identity);
    await this.searchInput.press('Enter');
    let previousSignature = '';
    let stableSnapshots = 0;
    await expect.poll(async () => {
      try {
        const loading = this.page.getByRole('progressbar');
        if ((await loading.count()) > 0 && await loading.first().isVisible()) {
          stableSnapshots = 0;
          return false;
        }
        const rowTexts = (await this.rows.allTextContents())
          .map(value => value.replace(/\s+/g, ' ').trim());
        const signature = JSON.stringify(rowTexts);
        stableSnapshots = signature === previousSignature ? stableSnapshots + 1 : 0;
        previousSignature = signature;
        return stableSnapshots >= 2;
      } catch (error) {
        if (!isTransientNavigationError(error)) throw error;
        stableSnapshots = 0;
        return false;
      }
    }, {
      timeout: 20_000,
      intervals: [300, 500, 750, 1_000],
      message: 'Admin client search did not settle to rows or an empty state.'
    }).toBe(true);
  }

  async matchingRows(identity: string): Promise<AdminClientUserSummary[]> {
    const normalized = identity.trim().toLowerCase();
    const output: AdminClientUserSummary[] = [];
    const rowTexts = (await this.rows.allTextContents())
      .map(value => value.replace(/\s+/g, ' ').trim());
    for (let index = 0; index < rowTexts.length; index += 1) {
      const rowText = rowTexts[index];
      if (/^(?:No data available|暂无数据|没有数据)$/i.test(rowText)) continue;
      const row = this.rows.nth(index);
      if (rowText.toLowerCase().includes(normalized)) output.push({ row, rowText });
    }
    return output;
  }

  async exactCandidateCount(identity: string): Promise<number> {
    await this.search(identity);
    return (await this.matchingRows(identity)).length;
  }

  async readDepositCustomerIdentityByEmail(baseURL: string, email: string): Promise<AdminDepositCustomerIdentity> {
    await this.goto(baseURL);
    await this.search(email);
    const candidates: AdminClientUserSummary[] = [];
    for (const candidate of await this.matchingRows(email)) {
      const rowText = await candidate.row.innerText();
      const emails = rowText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
      if (emails.some(value => value.toLowerCase() === email.trim().toLowerCase())) {
        candidates.push({ row: candidate.row, rowText });
      }
    }
    if (candidates.length !== 1) throw new Error(`Deposit customer email candidateCount=${candidates.length}; expected 1.`);
    const table = this.page.getByRole('table').filter({ has: candidates[0].row });
    await expect(table).toHaveCount(1);
    const headers = (await table.getByRole('columnheader').allInnerTexts()).map(value => value.trim());
    if (headers.filter(value => value === '申请类型').length !== 1) {
      throw new Error('Deposit customer list must expose one application-type column.');
    }
    const applicationType = (await candidates[0].row.getByRole('cell').nth(headers.indexOf('申请类型')).innerText()).trim();
    const accountType = applicationType === '个人' ? 'PERSONAL' : applicationType === '企业' ? 'BUSINESS' : undefined;
    if (!accountType) throw new Error('Deposit customer application type is unknown or ambiguous.');
    const ids = [...candidates[0].rowText.matchAll(/\bID\s*:\s*(\d+)\b/gi)];
    if (ids.length !== 1) throw new Error('Deposit customer ID is not uniquely displayed.');
    const suffix = accountType === 'BUSINESS' ? '/enterprise' : '';
    const url = new URL(`/zh-CN/kyc/userManagement/${ids[0][1]}${suffix}`, baseURL);
    await this.page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await expect(this.page).toHaveURL(url.toString());
    await expect(this.page.getByText(accountType === 'BUSINESS' ? '企业客户' : '个人客户', { exact: true })).toBeVisible();
    if (accountType === 'PERSONAL') await this.expectDetailMatchesEmail(email);
    const readName = async (label: string): Promise<string> => {
      const fieldLabel = accountType === 'BUSINESS'
        ? this.page.getByText(label, { exact: true })
        : this.page.getByRole('heading', { name: label, exact: true });
      const value = fieldLabel.locator('..').locator('..').locator(':scope > p');
      await expect(value).toHaveCount(1);
      const text = (await value.innerText()).trim();
      if (!text || text === '-') throw new Error(`Deposit customer ${label} is empty.`);
      return text;
    };
    const name = accountType === 'BUSINESS' ? await readName('主体名称') : `${await readName('名')} ${await readName('姓')}`;
    return { accountType, userId: ids[0][1], name };
  }

  async openUniqueByEmail(email: string): Promise<Page> {
    const candidates = await this.matchingRows(email);
    if (candidates.length !== 1) {
      throw new Error(`Admin personal user candidateCount must equal 1; received ${candidates.length}.`);
    }
    const detailButton = candidates[0].row.getByRole('button', {
      name: /查看详情|详情|查看/,
      exact: false
    });
    await expect(detailButton).toHaveCount(1);
    await detailButton.click();
    await expect(this.page).toHaveURL(/\/kyc\/userManagement\/[^/?#]+(?:$|[?#])/);
    return this.page;
  }

  async openUniqueRegistrationByEmail(
    baseURL: string,
    email: string
  ): Promise<AdminRegistrationCandidate> {
    for (const route of registrationViews) {
      await this.gotoRegistrationView(baseURL, route);
      const searchInput = await this.visibleKeywordInput();
      if (!searchInput) continue;
      await this.searchWith(searchInput, email);
      const candidates = await this.filteredDataRows(email);
      if (candidates.length === 0) continue;
      if (candidates.length !== 1) {
        throw new Error(
          `Admin registration candidateCount must equal 1 in ${route}; received ${candidates.length}.`
        );
      }

      const row = candidates[0].row;
      const button = row.getByRole('button', { name: /查看详情|详情|查看|审核/ });
      const link = row.getByRole('link', { name: /查看详情|详情|查看|审核/ });
      if (await button.count() === 1) await button.click();
      else {
        await expect(link).toHaveCount(1);
        await link.click();
      }
      await expect(this.page.getByText(email, { exact: false }).first()).toBeVisible({
        timeout: 20_000
      });
      return { candidateCount: 1, route };
    }
    return { candidateCount: 0, route: 'not-found' };
  }

  async expectDetailMatchesEmail(email: string): Promise<void> {
    await expect(this.page.getByText(email, { exact: false }).first()).toBeVisible();
  }

  async expectDetailMatchesPhone(phone: string): Promise<void> {
    await expect(this.page.getByText(phone, { exact: false }).first()).toBeVisible();
  }

  async expectDetailMatchesTestName(displayName: string): Promise<void> {
    if (!/^TEST SANDBOX [A-Z]{2,}$/.test(displayName)) {
      throw new Error('Admin registration test name must use a pure alphabetic suffix.');
    }
    await expect(this.page.getByText(displayName, { exact: false }).first()).toBeVisible();
  }

  async readUserId(): Promise<string | undefined> {
    const pathnameSegments = new URL(this.page.url()).pathname.split('/').filter(Boolean);
    const collectionIndex = Math.max(
      pathnameSegments.indexOf('clients'),
      pathnameSegments.indexOf('userManagement')
    );
    if (collectionIndex >= 0 && pathnameSegments[collectionIndex + 1]) {
      return pathnameSegments[collectionIndex + 1];
    }
    const idText = await this.page.getByText(/^(?:用户ID|客户ID|ID)[：:]?/).first().textContent()
      .catch(() => null);
    return idText?.match(/[A-Z0-9-]{2,}/i)?.[0];
  }

  async readStatus(): Promise<string> {
    const statusLabel = this.page.getByText(/^(?:用户状态|状态)[：:]?$/).first();
    if (await statusLabel.count()) {
      const parentText = await statusLabel.evaluate(element =>
        (element.parentElement?.textContent ?? '').replace(/\s+/g, ' ').trim()
      );
      return parentText.replace(/^(?:用户状态|状态)[：:]?\s*/, '');
    }
    return '已创建';
  }

  private async gotoRegistrationView(baseURL: string, route: string): Promise<void> {
    await this.page.goto(new URL(route, baseURL).toString(), { waitUntil: 'domcontentloaded' });
    await expect(
      this.page,
      'Admin storageState expired while locating the registered user. Run npm run auth:admin.'
    ).not.toHaveURL(/\/login|\/signin|\/sign-in/i);
    await expect(this.page.locator('main')).toBeVisible();
  }

  private async visibleKeywordInput(): Promise<Locator | undefined> {
    const inputs = this.page.locator('input[name="keyword"]');
    for (const input of await inputs.all()) {
      if (await input.isVisible()) return input;
    }
    return undefined;
  }

  private async searchWith(searchInput: Locator, identity: string): Promise<void> {
    await searchInput.fill(identity);
    await searchInput.press('Enter');
    let previousSignature = '';
    let stableSnapshots = 0;
    await expect.poll(async () => {
      try {
        const rowTexts = await this.visibleRowTexts();
        const signature = JSON.stringify(rowTexts);
        stableSnapshots = signature === previousSignature ? stableSnapshots + 1 : 0;
        previousSignature = signature;
        return stableSnapshots >= 2;
      } catch (error) {
        if (!isTransientNavigationError(error)) throw error;
        stableSnapshots = 0;
        return false;
      }
    }, {
      timeout: 20_000,
      intervals: [300, 500, 750, 1_000],
      message: 'Admin registration search did not settle.'
    }).toBe(true);
  }

  private async filteredDataRows(identity: string): Promise<AdminClientUserSummary[]> {
    const normalizedIdentity = identity.trim().toLowerCase();
    const dataRows: AdminClientUserSummary[] = [];
    for (const row of await this.rows.all()) {
      if (!await row.isVisible()) continue;
      const rowText = (await row.textContent() ?? '').replace(/\s+/g, ' ').trim();
      if (!rowText || /^(?:No data available|暂无数据|没有数据)$/i.test(rowText)) continue;
      dataRows.push({ row, rowText });
    }
    const explicitMatches = dataRows.filter(candidate =>
      candidate.rowText.toLowerCase().includes(normalizedIdentity)
    );
    return explicitMatches.length > 0 ? explicitMatches : dataRows.length === 1 ? dataRows : [];
  }

  private async visibleRowTexts(): Promise<string[]> {
    const output: string[] = [];
    for (const row of await this.rows.all()) {
      if (!await row.isVisible()) continue;
      output.push((await row.textContent() ?? '').replace(/\s+/g, ' ').trim());
    }
    return output;
  }
}
