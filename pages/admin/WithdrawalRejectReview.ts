import { expect, type Locator, type Page } from '@playwright/test';

export class WithdrawalRejectReview {
  readonly reasonInput: Locator;
  readonly rejectButton: Locator;
  private confirmationClicks = 0;

  constructor(readonly page: Page, readonly root: Locator) {
    this.reasonInput = root.getByPlaceholder('请输入审批备注');
    this.rejectButton = root.getByRole('button', { name: '拒绝', exact: true });
  }

  async waitForReady(): Promise<void> {
    await expect(this.root).toBeVisible();
    await expect(this.reasonInput).toHaveCount(1);
    await expect(this.reasonInput).toBeVisible();
    await expect(this.rejectButton).toHaveCount(1);
    await expect(this.rejectButton).toBeVisible();
    await expect(this.rejectButton).toBeEnabled();
  }

  async fillReason(reason: string): Promise<void> {
    if (!reason.trim()) throw new Error('Admin Withdrawal rejection reason is required.');
    await this.waitForReady();
    await this.reasonInput.fill(reason);
    await expect(this.reasonInput).toHaveValue(reason);
  }

  async confirmRejectOnce(
    allowMoneyTests: boolean,
    allowAdminMutationTests: boolean
  ): Promise<void> {
    if (!allowMoneyTests || !allowAdminMutationTests) {
      throw new Error(
        'Admin Withdrawal rejection requires both money and Admin mutation safety switches.'
      );
    }
    if (this.confirmationClicks > 0) {
      throw new Error('Admin Withdrawal final rejection was already clicked once for this run.');
    }
    if (!(await this.reasonInput.inputValue()).trim()) {
      throw new Error('Admin Withdrawal rejection reason must be filled before final rejection.');
    }

    this.confirmationClicks += 1;
    await this.rejectButton.click();
  }

  confirmationClickCount(): number {
    return this.confirmationClicks;
  }
}
