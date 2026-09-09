import { expect, type Page, type Response } from '@playwright/test';

export type AccountOpeningApprovalResult = {
  requestPath?: string;
  httpStatus?: number;
  completionEvidence: 'route-changed' | 'form-hidden';
};

export class AccountOpeningApprovalPage {
  private approveClicks = 0;

  constructor(readonly page: Page) {}

  async goto(url: string, applicationId: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await expect(this.page).toHaveURL(/\/kyc\/accountReviews\/[^/?]+\/process\?reviewId=/);
    if (new URL(this.page.url()).searchParams.get('reviewId') !== applicationId) {
      throw new Error('Admin Account Opening process reviewId changed during navigation.');
    }
    await expect(this.finalButton).toBeVisible({ timeout: 20_000 });
    await expect(this.page.getByLabel('审核备注', { exact: true })).toBeVisible();
    await expect(this.decisionCombobox).toHaveCount(1);
  }

  async fillApprovalForm(note: string): Promise<void> {
    if (!note.trim()) throw new Error('Account Opening approval note is required.');
    await this.decisionCombobox.click();
    const approve = this.page.getByRole('option', { name: '通过审核', exact: true });
    await expect(approve).toHaveCount(1);
    await approve.click();
    const remark = this.page.getByLabel('审核备注', { exact: true });
    await remark.fill(note);
    await expect(remark).toHaveValue(note);
    await expect(this.finalButton).toBeEnabled();
  }

  async confirmApproveOnce(): Promise<AccountOpeningApprovalResult> {
    if (this.approveClicks > 0) {
      throw new Error('Fidere Account Opening approval may be clicked only once per run.');
    }
    await expect(this.finalButton).toBeEnabled();
    const responses: Array<{ requestPath: string; httpStatus: number }> = [];
    const capture = (response: Response) => {
      const url = new URL(response.url());
      if (
        url.origin === new URL(this.page.url()).origin &&
        response.request().method().toUpperCase() !== 'GET'
      ) {
        responses.push({ requestPath: url.pathname, httpStatus: response.status() });
      }
    };
    this.page.on('response', capture);
    this.approveClicks += 1;
    try {
      await this.finalButton.click();
      let completionEvidence: AccountOpeningApprovalResult['completionEvidence'] = 'form-hidden';
      await expect.poll(async () => {
        if (!/\/process(?:$|[?#])/.test(this.page.url())) {
          completionEvidence = 'route-changed';
          return true;
        }
        if (!(await this.finalButton.isVisible())) {
          completionEvidence = 'form-hidden';
          return true;
        }
        return false;
      }, {
        timeout: 30_000,
        message: 'Admin approval was clicked once but the process form did not finish.'
      }).toBe(true);
      const response = responses.at(-1);
      return {
        requestPath: response?.requestPath,
        httpStatus: response?.httpStatus,
        completionEvidence
      };
    } finally {
      this.page.off('response', capture);
    }
  }

  approvalClickCount(): number {
    return this.approveClicks;
  }

  private get decisionCombobox() {
    return this.page.getByRole('combobox');
  }

  private get finalButton() {
    return this.page.getByRole('button', {
      name: '保存修改并提交审核',
      exact: true
    });
  }
}
