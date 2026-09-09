import { expect, type Locator, type Page } from '@playwright/test';

import { env } from '../../src/config/env';
import type { WithdrawalProofAsset } from '../../src/withdrawal/withdrawal-proof';

export type WithdrawalApprovalFormState = {
  paymentChannel: string;
  paymentBank: string;
  proofFileName: string;
  approvalNote: string;
  approveEnabled: boolean;
};

export type WithdrawalApprovalFormInput = {
  paymentChannel: string;
  paymentBank: string;
  proof: WithdrawalProofAsset;
  approvalNote: string;
};

export class WithdrawalApprovalPage {
  readonly approveButton: Locator;
  readonly rejectButton: Locator;
  readonly fileInput: Locator;
  readonly approvalNote: Locator;
  private approveClickCount = 0;
  private uploadedProofFileName = '';

  constructor(readonly page: Page, readonly root: Locator) {
    this.approveButton = root.getByRole('button', { name: '批准', exact: true });
    this.rejectButton = root.getByRole('button', { name: '拒绝', exact: true });
    this.fileInput = root.locator('input[type="file"]');
    this.approvalNote = root.getByPlaceholder('请输入审批备注');
  }

  async waitForOpen(): Promise<void> {
    await expect(this.root).toBeVisible();
    await expect(this.fieldLabel('打款渠道')).toBeVisible();
    await expect(this.fieldLabel('打款银行')).toBeVisible();
    await expect(this.root.getByText(/上传打款凭证/).first()).toBeVisible();
    await expect(this.fieldLabel('审批备注')).toBeVisible();
    await expect(this.fileInput).toHaveCount(1);
    await expect(this.fileInput).toHaveAttribute('accept', 'image/*');
    await expect(this.approveButton).toBeVisible();
    await expect(this.rejectButton).toBeVisible();
  }

  async readPaymentChannelOptions(): Promise<string[]> {
    return this.readOptions(await this.comboboxFor('打款渠道'));
  }

  async selectPaymentChannel(value: string): Promise<void> {
    await this.selectConfiguredOption(
      await this.comboboxFor('打款渠道'),
      value,
      '配置的打款渠道不存在'
    );
  }

  async readPaymentBankOptions(): Promise<string[]> {
    return this.readOptions(await this.comboboxFor('打款银行'));
  }

  async selectPaymentBank(value: string): Promise<void> {
    await this.selectConfiguredOption(
      await this.comboboxFor('打款银行'),
      value,
      '配置的打款银行不存在'
    );
  }

  async uploadPaymentProof(asset: WithdrawalProofAsset): Promise<void> {
    await expect(this.fileInput).toHaveCount(1);
    await this.fileInput.setInputFiles(asset.absolutePath);
    const selected = await this.fileInput.evaluate((input: HTMLInputElement) => ({
      name: input.files?.[0]?.name,
      size: input.files?.[0]?.size,
      type: input.files?.[0]?.type
    }));
    expect(selected).toEqual({
      name: asset.fileName,
      size: asset.sizeBytes,
      type: asset.mimeType
    });
    await expect(this.page.getByText('凭证上传成功', { exact: true })).toBeVisible();
    await expect(this.root.getByText(asset.fileName, { exact: true })).toBeVisible();
    await expect(
      this.root.getByText(/文件类型错误|不支持的文件类型|文件大小超过|上传失败/)
    ).toHaveCount(0);
    this.uploadedProofFileName = asset.fileName;
  }

  async fillApprovalNote(value: string): Promise<void> {
    await expect(this.approvalNote).toHaveCount(1);
    await this.approvalNote.fill(value);
    await expect(this.approvalNote).toHaveValue(value);
  }

  async fillApprovalForm(input: WithdrawalApprovalFormInput): Promise<void> {
    await this.waitForOpen();
    await this.selectPaymentChannel(input.paymentChannel);
    await this.selectPaymentBank(input.paymentBank);
    await this.uploadPaymentProof(input.proof);
    await this.fillApprovalNote(input.approvalNote);
  }

  async readFormState(): Promise<WithdrawalApprovalFormState> {
    const proofDisplayed = this.uploadedProofFileName
      ? await this.root.getByText(this.uploadedProofFileName, { exact: true }).isVisible()
      : false;
    return {
      paymentChannel: (await (await this.comboboxFor('打款渠道')).innerText()).trim(),
      paymentBank: (await (await this.comboboxFor('打款银行')).innerText()).trim(),
      proofFileName: proofDisplayed ? this.uploadedProofFileName : '',
      approvalNote: await this.approvalNote.inputValue(),
      approveEnabled: await this.approveButton.isEnabled()
    };
  }

  async assertRequiredFieldsSatisfied(expected: {
    paymentChannel: string;
    paymentBank: string;
    proofFileName: string;
    approvalNote: string;
  }): Promise<void> {
    const state = await this.readFormState();
    expect(state).toEqual({ ...expected, approveEnabled: true });
    await expect(this.root.locator('[aria-invalid="true"]')).toHaveCount(0);
    await expect(this.root.getByRole('alert')).toHaveCount(0);
    await expect(this.approveButton).toBeEnabled();
  }

  async confirmApprove(): Promise<void> {
    if (!env.exchange.allowMoneyTests || !env.allowAdminMutationTests) {
      throw new Error(
        'Admin Withdrawal批准要求同时开启ALLOW_MONEY_TESTS和ALLOW_ADMIN_MUTATION_TESTS。'
      );
    }
    if (this.approveClickCount > 0) {
      throw new Error('Admin Withdrawal批准已点击过一次。');
    }
    this.approveClickCount += 1;
    await this.approveButton.click();
  }

  approvalClicks(): number {
    return this.approveClickCount;
  }

  private fieldLabel(label: string): Locator {
    return this.root.getByText(new RegExp(`^${label}\\s*\\*$`)).first();
  }

  private async comboboxFor(label: string): Promise<Locator> {
    const combobox = this.fieldLabel(label).locator('..').getByRole('combobox');
    await expect(combobox, `${label}必须对应唯一combobox。`).toHaveCount(1);
    return combobox;
  }

  private async readOptions(combobox: Locator): Promise<string[]> {
    await combobox.click();
    const listbox = this.page.getByRole('listbox').last();
    await expect(listbox).toBeVisible();
    const options = (await listbox.getByRole('option').allTextContents())
      .map(value => value.trim())
      .filter(Boolean);
    await this.page.keyboard.press('Escape');
    await expect(listbox).toBeHidden();
    return options;
  }

  private async selectConfiguredOption(
    combobox: Locator,
    value: string,
    missingMessage: string
  ): Promise<void> {
    const options = await this.readOptions(combobox);
    if (!options.includes(value)) {
      throw new Error(`${missingMessage}：${value}`);
    }
    await combobox.click();
    const listbox = this.page.getByRole('listbox').last();
    await expect(listbox).toBeVisible();
    const option = listbox.getByRole('option', { name: value, exact: true });
    await expect(option).toHaveCount(1);
    await option.click();
    await expect(listbox).toBeHidden();
    await expect(combobox).toContainText(value);
  }
}
