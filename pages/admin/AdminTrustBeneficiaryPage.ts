import { expect, type Locator, type Page, type Response } from '@playwright/test';

export type AdminTrustBeneficiaryRecon = {
  tabs: string[];
  headings: string[];
  tableHeaders: string[];
  buttonLabels: string[];
  beneficiaryVisible: boolean;
  statusText?: string;
  bankAccountCount?: number;
  detailDialogVisible?: boolean;
  detailLabels?: string[];
  detailButtons?: string[];
  detailHasBankAccount?: boolean;
  detailHasIndependentBankApproval?: boolean;
};

export type AdminTrustBeneficiaryDetailMatch = {
  name: boolean;
  relationship: boolean;
  idType: boolean;
  idNumber: boolean;
  percentage: boolean;
  phone: boolean;
  email: boolean;
  address: boolean;
};

export type AdminTrustBeneficiaryApprovalResult = {
  approvalClicks: number;
  confirmationClicks: number;
  requestPath?: string;
  httpStatus?: number;
  observedAt?: string;
};

export class AdminTrustBeneficiaryPage {
  private approvalClicks = 0;
  private confirmationClicks = 0;

  constructor(readonly page: Page) {}

  async openTab(): Promise<void> {
    const tab = this.page.getByRole('tab', { name: '受益人管理', exact: true });
    await expect(tab).toBeVisible();
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  }

  async inspect(beneficiaryName: string): Promise<AdminTrustBeneficiaryRecon> {
    const beneficiaryVisible = await this.page.getByText(beneficiaryName, { exact: true })
      .filter({ visible: true }).count() === 1;
    let statusText: string | undefined;
    let bankAccountCount: number | undefined;
    if (beneficiaryVisible) {
      const row = await this.beneficiaryContainer(beneficiaryName);
      const rowText = (await row.innerText()).replace(/\s+/g, ' ').trim();
      statusText = rowText.match(/待审核|已批准|审核通过|已拒绝/)?.[0];
      const count = rowText.match(/(\d+)\s*个账户/);
      if (count) bankAccountCount = Number.parseInt(count[1], 10);
    }
    return {
      tabs: await this.visibleTexts(this.page.getByRole('tab')),
      headings: await this.visibleTexts(this.page.getByRole('heading')),
      tableHeaders: await this.visibleTexts(this.page.getByRole('columnheader')),
      buttonLabels: await this.page.getByRole('button').evaluateAll(buttons => buttons
        .filter(button => {
          const style = window.getComputedStyle(button);
          const rect = button.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        })
        .map(button => (
          button.getAttribute('aria-label') ||
          button.getAttribute('title') ||
          (button.textContent ?? '').replace(/\s+/g, ' ').trim()
        ))
        .filter(Boolean)),
      beneficiaryVisible,
      statusText,
      bankAccountCount
    };
  }

  async openDetails(beneficiaryName: string): Promise<AdminTrustBeneficiaryRecon> {
    const row = await this.beneficiaryContainer(beneficiaryName);
    const action = row.getByRole('button', { name: '查看详情', exact: true });
    await expect(action).toHaveCount(1);
    await action.click();
    const dialog = this.page.getByRole('dialog').filter({ hasText: beneficiaryName });
    await expect(dialog).toBeVisible();
    const detailText = (await dialog.innerText()).replace(/\s+/g, ' ').trim();
    const detailButtons = await this.visibleTexts(dialog.getByRole('button'));
    const detailLabels = await this.visibleTexts(dialog.locator('label'));
    return {
      ...(await this.inspect(beneficiaryName)),
      detailDialogVisible: true,
      detailLabels,
      detailButtons,
      detailHasBankAccount: /银行|账户|USD/.test(detailText),
      detailHasIndependentBankApproval: detailButtons.some(value => /银行.*通过|账户.*通过|审核银行/.test(value))
    };
  }

  async matchOpenDetails(input: {
    name: string;
    relationship: string;
    idType: string;
    idNumber: string;
    percentage: string;
    phone: string;
    email: string;
    address: string;
  }): Promise<AdminTrustBeneficiaryDetailMatch> {
    const dialog = this.detailDialog(input.name);
    await expect(dialog).toBeVisible();
    const text = (await dialog.innerText()).replace(/\s+/g, ' ').trim();
    const percentage = Number.parseFloat(input.percentage).toFixed(2);
    return {
      name: text.includes(input.name),
      relationship: text.includes(input.relationship),
      idType: text.includes(input.idType),
      idNumber: text.includes(input.idNumber) || text.includes(input.idNumber.slice(-4)),
      percentage: text.includes(input.percentage) || text.includes(percentage),
      phone: text.includes(input.phone) || text.includes(input.phone.slice(-4)),
      email: text.toLowerCase().includes(input.email.toLowerCase()),
      address: text.includes(input.address)
    };
  }

  async approveOpenDetailsOnce(beneficiaryName: string): Promise<AdminTrustBeneficiaryApprovalResult> {
    if (this.approvalClicks !== 0 || this.confirmationClicks !== 0) {
      throw new Error('Admin Beneficiary approval is limited to once per Run.');
    }
    const dialog = this.detailDialog(beneficiaryName);
    await expect(dialog).toBeVisible();
    const approve = dialog.getByRole('button', { name: '通过审核', exact: true });
    await expect(approve).toHaveCount(1);
    await expect(approve).toBeEnabled();

    const observed: Array<{ path: string; status: number; observedAt: string }> = [];
    const origin = new URL(this.page.url()).origin;
    const listener = (response: Response): void => {
      const request = response.request();
      const url = new URL(response.url());
      if (url.origin !== origin || request.method() === 'GET' || !url.pathname.startsWith('/admin-api/')) return;
      observed.push({ path: url.pathname, status: response.status(), observedAt: new Date().toISOString() });
    };

    this.page.on('response', listener);
    this.approvalClicks += 1;
    try {
      await approve.click();
      const confirm = this.page.getByRole('button', {
        name: /^(确认|确定|确认通过|确认审核通过)$/,
        exact: true
      }).filter({ visible: true });
      await expect.poll(async () => {
        if (await confirm.count()) return 'confirmation';
        if (observed.length > 0) return 'response';
        if (!await dialog.isVisible().catch(() => false)) return 'closed';
        const success = this.page.getByText(/审核通过|操作成功|提交成功/).filter({ visible: true });
        if (await success.count()) return 'success';
        return 'waiting';
      }, {
        timeout: 15_000,
        intervals: [250, 500, 1_000],
        message: 'Beneficiary approval produced no confirmation or observable result.'
      }).not.toBe('waiting');

      if (await confirm.count()) {
        await expect(confirm).toHaveCount(1);
        this.confirmationClicks += 1;
        await confirm.click();
      }

      await expect.poll(async () => {
        if (observed.length > 0) return true;
        if (!await dialog.isVisible().catch(() => false)) return true;
        return await this.page.getByText(/审核通过|操作成功|提交成功/).filter({ visible: true }).count() > 0;
      }, {
        timeout: 30_000,
        intervals: [500, 1_000, 2_000],
        message: 'Beneficiary approval was clicked once but completion evidence is unavailable.'
      }).toBe(true);
    } finally {
      this.page.off('response', listener);
    }

    const relevant = observed.find(item => /beneficiar|trust|review|approve/i.test(item.path)) ?? observed.at(-1);
    return {
      approvalClicks: this.approvalClicks,
      confirmationClicks: this.confirmationClicks,
      requestPath: relevant?.path,
      httpStatus: relevant?.status,
      observedAt: relevant?.observedAt
    };
  }

  private async beneficiaryContainer(name: string): Promise<Locator> {
    let current = this.page.getByText(name, { exact: true }).filter({ visible: true });
    await expect(current).toHaveCount(1);
    for (let depth = 0; depth < 7; depth += 1) {
      const text = (await current.innerText()).replace(/\s+/g, ' ').trim();
      if (/待审核|已批准|审核通过|已拒绝/.test(text) && await current.getByRole('button').count()) {
        return current;
      }
      current = current.locator('..');
    }
    throw new Error('Could not scope the unique Admin Beneficiary record.');
  }

  private detailDialog(beneficiaryName: string): Locator {
    return this.page.getByRole('dialog').filter({ hasText: beneficiaryName });
  }

  private async visibleTexts(locator: Locator): Promise<string[]> {
    const values: string[] = [];
    for (const item of await locator.all()) {
      if (!await item.isVisible()) continue;
      const value = (await item.innerText()).replace(/\s+/g, ' ').trim();
      if (value) values.push(value);
    }
    return values;
  }
}
