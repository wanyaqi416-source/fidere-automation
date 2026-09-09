import { expect, type Locator, type Page } from '@playwright/test';

import type { TransferDetailPage } from './TransferDetailPage';

export class TransferRejectDialog {
  private reviewScope?: Locator;
  private detailPage?: TransferDetailPage;
  private confirmationClicked = false;

  constructor(readonly page: Page) {}

  async open(detailPage: TransferDetailPage): Promise<void> {
    this.detailPage = detailPage;
    this.reviewScope = detailPage.scope();

    await expect(
      this.reviewScope.getByText('资金互转审核', { exact: true })
    ).toBeVisible();
    await detailPage.expectRejectActionAvailable();
    await expect(this.reasonInput()).toBeVisible();
  }

  async fillReason(reason: string): Promise<void> {
    if (!reason.trim()) {
      throw new Error('Admin Transfer rejection reason cannot be empty.');
    }
    await this.reasonInput().fill(reason);
  }

  async readConfirmationSummary(): Promise<string> {
    return (await this.requireScope().innerText()).trim();
  }

  async confirmRejectOnce(
    allowMoneyTests: boolean,
    allowAdminMutationTests: boolean
  ): Promise<void> {
    if (!allowMoneyTests || !allowAdminMutationTests) {
      throw new Error(
        'Admin资金互转最终拒绝要求同时开启ALLOW_MONEY_TESTS和ALLOW_ADMIN_MUTATION_TESTS。'
      );
    }
    if (this.confirmationClicked) {
      throw new Error('Admin Transfer final rejection was already clicked once for this run.');
    }
    this.confirmationClicked = true;
    await this.confirmButton().click();
  }

  async closeWithoutConfirming(): Promise<void> {
    if (this.confirmationClicked) {
      throw new Error('Cannot close a Transfer rejection dialog as read-only after final rejection.');
    }
    if (!this.detailPage) {
      throw new Error('Admin Transfer review must be opened before it can be closed.');
    }
    await this.detailPage.close();
    this.reviewScope = undefined;
    this.detailPage = undefined;
  }

  wasConfirmed(): boolean {
    return this.confirmationClicked;
  }

  private reasonInput(): Locator {
    return this.requireScope().getByRole('textbox', { name: /拒绝原因|审核备注|备注/ });
  }

  private confirmButton(): Locator {
    if (!this.detailPage) {
      throw new Error('Admin Transfer review must be opened before rejection.');
    }
    return this.detailPage.rejectButton();
  }

  private requireScope(): Locator {
    if (!this.reviewScope) {
      throw new Error('Admin Transfer review must be opened before rejection.');
    }
    return this.reviewScope;
  }
}
