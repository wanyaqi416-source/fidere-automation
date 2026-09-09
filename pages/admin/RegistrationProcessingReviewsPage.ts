import { expect, type Locator, type Page } from '@playwright/test';

export type ProcessingRegistrationCandidate = {
  row: Locator;
  processUrl: string;
  reviewId: string;
  status: string;
  progress: string;
};

export class RegistrationProcessingReviewsPage {
  constructor(readonly page: Page) {}

  async goto(baseURL: string): Promise<void> {
    await this.page.goto(new URL('/zh-CN/kyc/processingReviews', baseURL).toString(), {
      waitUntil: 'domcontentloaded'
    });
    await expect(this.page).not.toHaveURL(/\/login|\/signin|\/sign-in/i);
    await expect(this.page.locator('main')).toBeVisible();
  }

  async locateCandidate(input: {
    email: string;
    displayName: string;
    reviewId?: string;
  }): Promise<{ candidateCount: number; candidates: ProcessingRegistrationCandidate[] }> {
    const candidates: ProcessingRegistrationCandidate[] = [];
    for (const row of await this.page.locator('tbody tr').all()) {
      if (!await row.isVisible()) continue;
      const text = (await row.innerText()).replace(/\s+/g, ' ').trim();
      if (!text.includes(input.email) || !text.includes(input.displayName)) continue;
      const link = row.getByRole('link', { name: '开始处理', exact: true });
      const href = await link.getAttribute('href');
      if (!href) throw new Error('Processing Registration row has no process URL.');
      const url = new URL(href, this.page.url());
      const reviewId = url.searchParams.get('reviewId') ?? '';
      if (input.reviewId && reviewId !== input.reviewId) continue;
      candidates.push({
        row,
        processUrl: url.toString(),
        reviewId,
        status: text.match(/审核中|待审核|已通过|已拒绝/)?.[0] ?? 'unknown',
        progress: text.match(/\d{1,3}%/)?.[0] ?? 'unknown'
      });
    }
    return { candidateCount: candidates.length, candidates };
  }
}
