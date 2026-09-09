import { expect, type Locator, type Page } from '@playwright/test';

import type { TransferDetailPage } from './TransferDetailPage';

export class TransferApprovalReview {
  private reviewScope?: Locator;
  private detailPage?: TransferDetailPage;
  private approvalClicked = false;
  private secondaryConfirmationClicked = false;

  constructor(readonly page: Page) {}

  async open(detailPage: TransferDetailPage): Promise<void> {
    this.detailPage = detailPage;
    this.reviewScope = detailPage.scope();

    await expect(
      this.reviewScope.getByText('资金互转审核', { exact: true })
    ).toBeVisible();
    await expect(this.remarkInput()).toBeVisible();
    await detailPage.expectApproveActionAvailable();
  }

  async fillRemark(remark: string): Promise<void> {
    if (!remark.trim()) {
      throw new Error('Admin Transfer approval remark cannot be empty.');
    }
    await this.remarkInput().fill(remark);
  }

  async readReviewSummary(): Promise<string> {
    return (await this.requireScope().innerText()).trim();
  }

  async readRemarkValue(): Promise<string> {
    return this.remarkInput().inputValue();
  }

  async confirmApproveOnce(
    allowMoneyTests: boolean,
    allowAdminMutationTests: boolean
  ): Promise<void> {
    if (!allowMoneyTests || !allowAdminMutationTests) {
      throw new Error(
        'Admin资金互转最终批准要求同时开启ALLOW_MONEY_TESTS和ALLOW_ADMIN_MUTATION_TESTS。'
      );
    }
    if (this.approvalClicked) {
      throw new Error('Admin Transfer final approval was already clicked once for this run.');
    }
    if (!this.detailPage) {
      throw new Error('Admin Transfer review must be opened before approval.');
    }

    this.approvalClicked = true;
    await this.detailPage.approveButton().click();

    const confirmationDialog = this.page
      .getByRole('dialog')
      .filter({ hasText: /确认批准|确定批准|是否.*批准|确认审核通过/ });
    const visibleConfirmation = confirmationDialog.first();
    await expect
      .poll(async () => {
        if (await visibleConfirmation.isVisible()) {
          return 'confirmation';
        }
        if (!(await this.requireScope().isVisible())) {
          return 'submitted';
        }
        if (await this.page.getByText(/批准成功|审核通过成功/).first().isVisible()) {
          return 'submitted';
        }
        return 'pending';
      }, {
        message: '等待Admin批准操作出现二次确认或提交结果',
        timeout: 5_000
      })
      .toMatch(/^(confirmation|submitted)$/);

    if (await visibleConfirmation.isVisible()) {
      const confirmationButton = visibleConfirmation.getByRole('button', {
        name: /^(确认|确定|确认批准|确定批准|审核通过)$/
      });
      await expect(confirmationButton).toHaveCount(1);
      this.secondaryConfirmationClicked = true;
      await confirmationButton.click();
    }
  }

  async closeWithoutApproving(): Promise<void> {
    if (this.approvalClicked) {
      throw new Error('Cannot close a Transfer approval review as read-only after final approval.');
    }
    if (!this.detailPage) {
      throw new Error('Admin Transfer review must be opened before it can be closed.');
    }

    await this.detailPage.close();
    this.reviewScope = undefined;
    this.detailPage = undefined;
  }

  wasApproved(): boolean {
    return this.approvalClicked;
  }

  approvalClickCount(): number {
    return this.approvalClicked ? 1 : 0;
  }

  secondaryConfirmationClickCount(): number {
    return this.secondaryConfirmationClicked ? 1 : 0;
  }

  private remarkInput(): Locator {
    return this.requireScope().getByRole('textbox', { name: /审核备注|备注/ });
  }

  private requireScope(): Locator {
    if (!this.reviewScope) {
      throw new Error('Admin Transfer review must be opened before approval.');
    }
    return this.reviewScope;
  }
}
