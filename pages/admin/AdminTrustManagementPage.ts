import { expect, type Locator, type Page } from '@playwright/test';

export type AdminTrustCandidate = {
  row: Locator;
  customerText: string;
  trustName: string;
  trustNumber: string;
  beneficiaryCount: number;
  pendingCount: number;
};

export class AdminTrustManagementPage {
  constructor(readonly page: Page) {}

  async goto(baseURL: string): Promise<void> {
    await this.page.goto(new URL('/zh-CN/kyc/trust', baseURL).toString(), { waitUntil: 'domcontentloaded' });
    await expect(this.page, 'Admin auth expired before Trust mutation. Run npm run auth:admin.').not.toHaveURL(/\/login|\/signin|\/sign-in/i);
    await expect(this.page.getByPlaceholder('搜索信托名称、编号或用户名...', { exact: true })).toBeVisible();
    await expect(this.page.getByRole('columnheader', { name: '信托编号', exact: true })).toBeVisible();
  }

  async locateUnique(input: { email: string; trustNumber?: string }): Promise<AdminTrustCandidate> {
    const search = this.page.getByPlaceholder('搜索信托名称、编号或用户名...', { exact: true });
    await search.fill(input.email);
    await search.press('Enter');
    let candidates: AdminTrustCandidate[] = [];
    await expect.poll(async () => {
      candidates = (await this.readRows()).filter(candidate =>
        candidate.customerText.toLowerCase().includes(input.email.toLowerCase()) &&
        (!input.trustNumber || candidate.trustNumber === input.trustNumber)
      );
      if (candidates.length > 1) throw new Error('Admin Trust candidateCount>1; do not select a row.');
      return candidates.length;
    }, { timeout: 20_000, intervals: [500, 1_000, 2_000], message: 'Admin Trust candidateCount=1' }).toBe(1);
    return candidates[0];
  }

  async open(candidate: AdminTrustCandidate): Promise<void> {
    const action = candidate.row.getByRole('link');
    await expect(action).toHaveCount(1);
    await action.click();
    await expect(this.page.getByRole('heading', { name: candidate.trustName, exact: true })).toBeVisible();
    await expect(this.page.getByRole('tab', { name: '受益人管理', exact: true })).toBeVisible();
  }

  private async readRows(): Promise<AdminTrustCandidate[]> {
    const output: AdminTrustCandidate[] = [];
    for (const row of await this.page.locator('tbody tr').all()) {
      if (!await row.isVisible()) continue;
      const cells = (await row.locator('td').allInnerTexts()).map(value => value.replace(/\s+/g, ' ').trim());
      if (cells.length < 7 || !/^TR\d+$/.test(cells[2] ?? '')) continue;
      output.push({
        row,
        customerText: cells[0],
        trustName: cells[1],
        trustNumber: cells[2],
        beneficiaryCount: Number.parseInt(cells[4], 10) || 0,
        pendingCount: Number.parseInt(cells[6], 10) || 0
      });
    }
    return output;
  }
}
