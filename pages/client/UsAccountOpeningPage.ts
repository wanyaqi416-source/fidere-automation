import { basename } from 'node:path';

import { expect, type Locator, type Page } from '@playwright/test';

import type {
  UsOpeningDocumentAsset,
  UsOpeningDocumentField
} from '../../src/account-opening/account-opening-assets';
import { Decimal, decimalFromText } from '../../src/utils/money';
import { SecurityKeyDialog } from './SecurityKeyDialog';

export type UsOpeningUploadResult = {
  field: UsOpeningDocumentField;
  fileName: string;
  accepted: boolean;
};

export type UsOpeningFeeConfirmation = {
  currency: string;
  openingFeeAmount: Decimal;
  openingFeeAmountText: string;
  paymentAccount: string;
  confirmButtonText: string;
  feeDescription: string;
};

export type UsOpeningApplicationEvidence = {
  route: string;
  acknowledgement: 'route-changed' | 'success-message';
};

export class UsAccountOpeningPage {
  readonly securityKey: SecurityKeyDialog;
  private openFeeConfirmationClicks = 0;
  private feeConfirmationClicks = 0;
  private applicationCreations = 0;
  private signingEntryClicks = 0;

  constructor(readonly page: Page) {
    this.securityKey = new SecurityKeyDialog(page);
  }

  async expectLoaded(): Promise<void> {
    await expect(this.page).toHaveURL(/\/account\/us-application/);
    await expect(this.page.getByRole('heading', { name: 'BaaS 开户申请', exact: true })).toBeVisible({
      timeout: 20_000
    });
    await expect(this.submitButton).toBeVisible();
  }

  async validateUploadFields(fields: readonly UsOpeningDocumentField[]): Promise<void> {
    for (const field of fields) {
      const section = this.uploadSection(field);
      await expect(section.getByRole('heading', { name: field, exact: true })).toBeVisible();
      await expect(section.locator('input[type="file"]')).toHaveCount(1);
      await expect(section.getByRole('button', { name: '上传', exact: true })).toHaveCount(1);
    }
    await expect(this.page.locator('input[type="file"]')).toHaveCount(fields.length);
  }

  async validateRequiredPrefilledFields(): Promise<number> {
    const fields = this.page.locator(
      'input[required]:not([type="file"]), textarea[required], select[required]'
    );
    const count = await fields.count();

    for (let index = 0; index < count; index += 1) {
      const field = fields.nth(index);
      if (!(await field.isVisible()) || !(await field.isEnabled())) continue;
      await expect(field).not.toHaveValue('');
    }

    return count;
  }

  async uploadDocument(asset: UsOpeningDocumentAsset): Promise<UsOpeningUploadResult> {
    const section = this.uploadSection(asset.field);
    const input = section.locator('input[type="file"]');
    await expect(input).toHaveCount(1);
    await input.setInputFiles(asset.path);
    const fileName = basename(asset.path);
    await expect.poll(async () => {
      const selected = await input.evaluate(element =>
        [...((element as HTMLInputElement).files ?? [])].map(file => file.name)
      );
      const text = (await section.innerText()).replace(/\s+/g, ' ');
      return selected.includes(fileName) || text.includes(fileName) || /上传成功|已上传/.test(text);
    }, {
      message: `${asset.field}测试文件未显示为页面已接受`,
      timeout: 30_000
    }).toBe(true);
    await expect(section).not.toContainText(/格式错误|文件过大|大小错误|上传失败/);
    return { field: asset.field, fileName, accepted: true };
  }

  async readUploadStatus(field: UsOpeningDocumentField): Promise<string> {
    return (await this.uploadSection(field).innerText()).replace(/\s+/g, ' ').trim();
  }

  async verifyUploadedDocuments(
    assets: readonly UsOpeningDocumentAsset[]
  ): Promise<UsOpeningUploadResult[]> {
    const results: UsOpeningUploadResult[] = [];
    for (const asset of assets) {
      const section = this.uploadSection(asset.field);
      const fileName = basename(asset.path);
      const text = (await section.innerText()).replace(/\s+/g, ' ').trim();
      const hasNamedFile = text.includes(fileName);
      const hasPersistedStatus = /上传成功|已上传|重新上传|查看文件|删除文件/.test(text);
      if (!hasNamedFile && !hasPersistedStatus) {
        throw new Error(`${asset.field} does not expose persisted upload evidence for the Resume draft.`);
      }
      await expect(section).not.toContainText(/上传失败|格式错误|文件过大|大小错误/);
      results.push({ field: asset.field, fileName, accepted: true });
    }
    return results;
  }

  async readTaxFormStatus(): Promise<string> {
    return (await this.taxFormSection.innerText()).replace(/\s+/g, ' ').trim();
  }

  async openTaxDocumentSigning(): Promise<void> {
    if (this.signingEntryClicks > 0) {
      throw new Error('The US tax document signing entry may be opened only once per Page Object run.');
    }
    this.signingEntryClicks += 1;
    await this.page.getByRole('button', { name: '立即签署', exact: true }).click();
  }

  signingEntryClickCount(): number {
    return this.signingEntryClicks;
  }

  async submitEnabled(): Promise<boolean> {
    return this.submitButton.isEnabled();
  }

  async waitForTaxDocumentSigned(): Promise<string> {
    await expect(this.page.getByRole('button', { name: '立即签署', exact: true })).toBeHidden({
      timeout: 30_000
    });
    await expect(this.submitButton).toBeEnabled({ timeout: 30_000 });
    return this.readTaxFormStatus();
  }

  async openFeeConfirmationOnce(): Promise<void> {
    if (this.openFeeConfirmationClicks > 0) {
      throw new Error('The US Account Opening fee confirmation may be opened only once per run.');
    }
    await expect(this.submitButton).toBeEnabled();
    this.openFeeConfirmationClicks += 1;
    await this.submitButton.click();
    await expect(this.feeDialog).toBeVisible();
  }

  async readOpeningFeeConfirmation(): Promise<UsOpeningFeeConfirmation> {
    await expect(this.feeDialog).toBeVisible();
    const paymentAccount = await this.readFeeField('扣费账户');
    const currencyText = await this.readFeeField('扣费币种');
    const openingFeeAmountText = await this.readFeeField('扣费金额');
    const currency = currencyText.match(/\b[A-Z]{3,10}\b/)?.[0] ??
      openingFeeAmountText.match(/\b[A-Z]{3,10}\b/)?.[0];
    if (!currency) {
      throw new Error('US Account Opening fee dialog does not expose a readable fee currency.');
    }
    const amountCurrency = openingFeeAmountText.match(/\b[A-Z]{3,10}\b/)?.[0];
    if (amountCurrency && amountCurrency !== currency) {
      throw new Error(
        `US Account Opening fee currency mismatch: ${currencyText} / ${openingFeeAmountText}.`
      );
    }
    const openingFeeAmount = decimalFromText(
      openingFeeAmountText,
      'US Account Opening fee amount'
    );
    if (!openingFeeAmount.isPositive()) {
      throw new Error('US Account Opening fee amount must be positive.');
    }
    const confirmButtonText = (await this.feeConfirmButton.innerText()).trim();
    await expect(this.feeConfirmButton).toBeEnabled();

    return {
      currency,
      openingFeeAmount,
      openingFeeAmountText,
      paymentAccount,
      confirmButtonText,
      feeDescription: await this.readFeeDescription()
    };
  }

  async closeFeeConfirmationWithoutConfirming(): Promise<void> {
    if (this.feeConfirmationClicks > 0) {
      throw new Error('The opening fee dialog cannot be closed as a Dry Run after fee confirmation.');
    }
    await this.feeDialog.getByRole('button', { name: /^(取消|Cancel)$/i }).click();
    await expect(this.feeDialog).toBeHidden();
  }

  async confirmOpeningFeeOnce(): Promise<void> {
    if (this.feeConfirmationClicks > 0) {
      throw new Error('The US Account Opening fee confirmation is limited to once per run.');
    }
    await expect(this.feeConfirmButton).toBeEnabled();
    this.feeConfirmationClicks += 1;
    await this.feeConfirmButton.click();
    await this.securityKey.waitForOpen();
  }

  async waitForApplicationCreationEvidence(): Promise<UsOpeningApplicationEvidence> {
    const applicationRoute = /\/account\/us-application(?:$|[?#])/;
    let acknowledgement: UsOpeningApplicationEvidence['acknowledgement'] = 'route-changed';
    await expect.poll(async () => {
      if (!applicationRoute.test(new URL(this.page.url()).pathname)) {
        acknowledgement = 'route-changed';
        return true;
      }
      const success = this.page.getByText(/提交成功|申请已提交|开户申请已创建|等待审核/);
      if ((await success.count()) > 0 && await success.first().isVisible()) {
        acknowledgement = 'success-message';
        return true;
      }
      return false;
    }, {
      timeout: 30_000,
      message: 'Fee and Security Key were confirmed once, but no Client application creation evidence became observable.'
    }).toBe(true);

    this.applicationCreations += 1;
    return { route: new URL(this.page.url()).pathname, acknowledgement };
  }

  openFeeConfirmationClickCount(): number {
    return this.openFeeConfirmationClicks;
  }

  feeConfirmationClickCount(): number {
    return this.feeConfirmationClicks;
  }

  applicationCreateCount(): number {
    return this.applicationCreations;
  }

  /** @deprecated OPEN-US-003 must use the explicit fee confirmation sequence. */
  async submitOnce(): Promise<void> {
    throw new Error(
      'US Account Opening submitOnce() was removed: open the fee dialog, confirm the fee, verify the Security Key, and then confirm application creation.'
    );
  }

  /** @deprecated A hidden form is not application creation evidence. */
  async waitForSubmissionEvidence(): Promise<UsOpeningApplicationEvidence> {
    throw new Error(
      'US Account Opening submission evidence must be collected after fee and Security Key confirmation.'
    );
  }

  /** @deprecated Use applicationCreateCount() or openFeeConfirmationClickCount(). */
  submissionClickCount(): number {
    return this.applicationCreations;
  }

  private uploadSection(field: UsOpeningDocumentField): Locator {
    return this.page
      .getByRole('heading', { name: field, exact: true })
      .locator('..')
      .locator('..');
  }

  private get taxFormSection(): Locator {
    return this.page.getByRole('heading', { name: '美国税务表格', exact: true }).locator('..');
  }

  private get submitButton(): Locator {
    return this.page.getByRole('button', { name: '提交开户申请', exact: true });
  }

  private get feeDialog(): Locator {
    return this.page
      .getByRole('dialog')
      .filter({ has: this.page.getByText('确认开通并扣费', { exact: true }) });
  }

  private get feeConfirmButton(): Locator {
    return this.feeDialog.getByRole('button', { name: /确认(?:开通并)?扣费/ });
  }

  private async readFeeField(label: string): Promise<string> {
    const fieldLabel = this.feeDialog.getByText(label, { exact: true });
    await expect(fieldLabel).toHaveCount(1);
    await expect(fieldLabel).toBeVisible();

    let container = fieldLabel.locator('..');
    for (let level = 0; level < 4; level += 1) {
      const text = (await container.innerText()).replace(/\s+/g, ' ').trim();
      const value = text.replace(label, '').trim();
      if (value && value.length <= 120) return value;
      container = container.locator('..');
    }
    throw new Error(`US Account Opening fee dialog does not expose a value for ${label}.`);
  }

  private async readFeeDescription(): Promise<string> {
    const lines = (await this.feeDialog.innerText())
      .split(/\r?\n/)
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const description = lines.find(line =>
      /美国账户|开户/.test(line) && /扣|费/.test(line) && line !== '开户费用'
    );
    if (!description) {
      throw new Error('US Account Opening fee dialog does not expose a fee description.');
    }
    return description;
  }
}
