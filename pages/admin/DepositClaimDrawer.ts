import { expect, type Locator, type Page } from '@playwright/test';

import type { AdminDepositCandidate } from '../../src/deposit/deposit-e2e';
import { env } from '../../src/config/env';
import { decimalFromText } from '../../src/utils/money';
import type { DepositClaimListPage } from './DepositClaimListPage';

export type DepositClaimDetail = {
  originalAmount: string;
  claimAmount: string;
  accountType: string;
  payerText: string;
  channel: string;
  reference: string;
  submittedAtText: string;
  matchedCustomerText: string;
};

export class DepositClaimDrawer {
  private drawer?: Locator;
  private confirmationClicks = 0;

  constructor(readonly page: Page) {}

  async open(list: DepositClaimListPage, record: AdminDepositCandidate): Promise<void> {
    const row = await list.rowForRecord(record);
    await row.getByRole('button', { name: '认领', exact: true }).click();
    this.drawer = await this.resolveDrawer('入账认领');
    await expect(this.drawer).toBeVisible();
    await expect(this.drawer.getByRole('button', { name: '确认认领', exact: true })).toBeVisible();
  }

  async readDetail(): Promise<DepositClaimDetail> {
    const drawer = this.requireDrawer();
    const originalText = await this.readLabeledValue('原始来账金额');
    const claimInput = drawer.getByPlaceholder('请输入实际入账金额');
    await expect(claimInput).toBeVisible();
    return {
      originalAmount: decimalFromText(originalText, 'Admin original incoming amount').toString(),
      claimAmount: decimalFromText(await claimInput.inputValue(), 'Admin claim amount').toString(),
      accountType: await this.readLabeledValue('账户类型'),
      payerText: await this.readLabeledValue('付款人'),
      channel: await this.readLabeledValue('渠道'),
      reference: await this.readLabeledValue('参考号'),
      submittedAtText: await this.readLabeledValue('提交时间'),
      matchedCustomerText: await this.readLabeledValue('匹配客户')
    };
  }

  async expectRequiredRemark(): Promise<void> {
    await expect(this.requireDrawer().getByPlaceholder('必填项，用于审计追踪')).toBeVisible();
  }

  async fillRemark(remark: string): Promise<void> {
    if (!remark.trim()) {
      throw new Error('Admin Deposit claim remark is required.');
    }
    const input = this.requireDrawer().getByPlaceholder('必填项，用于审计追踪');
    await input.fill(remark);
    await expect(input).toHaveValue(remark);
  }

  async confirmClaimOnce(): Promise<void> {
    if (!env.exchange.allowMoneyTests || !env.allowAdminMutationTests) {
      throw new Error('Deposit claim requires both money and Admin mutation safety switches.');
    }
    if (this.confirmationClicks > 0) {
      throw new Error('Deposit claim can only be confirmed once per drawer instance.');
    }
    this.confirmationClicks += 1;
    await this.requireDrawer().getByRole('button', { name: '确认认领', exact: true }).click();
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

  private async readLabeledValue(label: string): Promise<string> {
    const drawer = this.requireDrawer();
    for (const item of await drawer.getByText(label, { exact: true }).all()) {
      if (!(await item.isVisible())) continue;
      const parent = item.locator('..');
      const lines = (await parent.innerText()).split(/\r?\n/)
        .map(value => value.trim()).filter(Boolean).filter(value => value !== label);
      if (lines.length === 1) return lines[0];
    }
    throw new Error(`Admin Deposit claim drawer field was not uniquely readable: ${label}.`);
  }

  private async resolveDrawer(title: string): Promise<Locator> {
    const dialog = this.page.getByRole('dialog').filter({ hasText: title });
    for (const item of await dialog.all()) if (await item.isVisible()) return item;
    for (const heading of await this.page.getByRole('heading', { name: title, exact: true }).all()) {
      if (!(await heading.isVisible())) continue;
      let container = heading;
      for (let level = 0; level < 8; level += 1) {
        container = container.locator('..');
        if ((await container.getByRole('button', { name: '确认认领', exact: true }).count()) === 1) {
          return container;
        }
      }
    }
    throw new Error('Admin Deposit claim drawer was not found.');
  }

  private requireDrawer(): Locator {
    if (!this.drawer) throw new Error('Admin Deposit claim drawer must be opened first.');
    return this.drawer;
  }
}
