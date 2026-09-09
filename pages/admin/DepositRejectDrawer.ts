import { expect, type Locator, type Page } from '@playwright/test';

import type { AdminDepositCandidate } from '../../src/deposit/deposit-e2e';
import { env } from '../../src/config/env';
import type { DepositClaimListPage } from './DepositClaimListPage';

export class DepositRejectDrawer {
  private drawer?: Locator;
  private confirmationClicks = 0;

  constructor(readonly page: Page) {}

  async open(list: DepositClaimListPage, record: AdminDepositCandidate): Promise<void> {
    const row = await list.rowForRecord(record);
    await row.getByRole('button', { name: '拒绝', exact: true }).click();
    this.drawer = await this.resolveDrawer();
    await expect(this.drawer).toBeVisible();
    await expect(this.drawer.getByPlaceholder('请详细说明拒绝的原因...')).toBeVisible();
    await expect(this.drawer.getByRole('button', { name: '确认拒绝', exact: true })).toBeVisible();
  }

  async confirmRejectOnce(reason: string, beforeClick?: () => void): Promise<void> {
    if (!env.exchange.allowMoneyTests || !env.allowAdminMutationTests) {
      throw new Error('Deposit rejection requires both money and Admin mutation safety switches.');
    }
    if (this.confirmationClicks > 0) {
      throw new Error('Deposit rejection can only be confirmed once per drawer instance.');
    }
    await this.requireDrawer().getByPlaceholder('请详细说明拒绝的原因...').fill(reason);
    await expect(this.requireDrawer().getByPlaceholder('请详细说明拒绝的原因...')).toHaveValue(reason);
    await expect(this.requireDrawer().getByRole('button', { name: '确认拒绝', exact: true })).toBeEnabled();
    beforeClick?.();
    this.confirmationClicks += 1;
    await this.requireDrawer().getByRole('button', { name: '确认拒绝', exact: true }).click();
  }

  confirmationClickCount(): number {
    return this.confirmationClicks;
  }

  async closeWithoutConfirming(): Promise<void> {
    const drawer = this.requireDrawer();
    await drawer.getByRole('button', { name: '取消', exact: true }).click();
    await expect(drawer).toBeHidden();
    this.drawer = undefined;
  }

  private async resolveDrawer(): Promise<Locator> {
    const dialog = this.page.getByRole('dialog').filter({ hasText: '拒绝入账认领' });
    for (const item of await dialog.all()) if (await item.isVisible()) return item;
    for (const heading of await this.page.getByRole('heading', {
      name: '拒绝入账认领',
      exact: true
    }).all()) {
      if (!(await heading.isVisible())) continue;
      let container = heading;
      for (let level = 0; level < 8; level += 1) {
        container = container.locator('..');
        if ((await container.getByRole('button', { name: '确认拒绝', exact: true }).count()) === 1) {
          return container;
        }
      }
    }
    throw new Error('Admin Deposit reject drawer was not found.');
  }

  private requireDrawer(): Locator {
    if (!this.drawer) throw new Error('Admin Deposit reject drawer must be opened first.');
    return this.drawer;
  }
}
