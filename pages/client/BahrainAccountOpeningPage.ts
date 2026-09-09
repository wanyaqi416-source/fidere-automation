import { expect, type Locator, type Page } from '@playwright/test';

export class BahrainAccountOpeningPage {
  private submitClicks = 0;

  constructor(readonly page: Page) {}

  async expectLoaded(): Promise<void> {
    await expect(this.page).toHaveURL(/\/account\/jurisdiction-application\?region=BH/);
    await expect(this.page.getByRole('heading', { name: '巴林账户开户申请', exact: true })).toBeVisible({
      timeout: 20_000
    });
    await expect(this.submitButton).toBeVisible();
  }

  async readOpeningFee(): Promise<string> {
    const feeHeading = this.page.getByRole('heading', { name: /^[A-Z]{3}\s+[\d,.]+$/ });
    await expect(feeHeading).toHaveCount(1);
    return (await feeHeading.innerText()).trim();
  }

  async fileInputCount(): Promise<number> {
    return this.page.locator('input[type="file"]').count();
  }

  async submitEnabled(): Promise<boolean> {
    return this.submitButton.isEnabled();
  }

  submissionClickCount(): number {
    return this.submitClicks;
  }

  private get submitButton(): Locator {
    return this.page.getByRole('button', { name: '确认并提交申请', exact: true });
  }
}
