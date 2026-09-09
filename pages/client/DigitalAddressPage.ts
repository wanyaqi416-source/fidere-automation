import { expect, type Page } from '@playwright/test';
import { ClientSettingsPage } from './ClientSettingsPage';
import { SecurityKeyDialog } from './SecurityKeyDialog';
import { DIGITAL_ASSETS, decodeDigitalAddressReceipt, validateDigitalAddressInput, type DigitalAddressInput } from '../../src/digital-address/digital-address';

export class DigitalAddressPage {
  readonly securityKey: SecurityKeyDialog;
  private submitClicks = 0;
  constructor(readonly page: Page) { this.securityKey = new SecurityKeyDialog(page); }
  get form() { return this.page.getByRole('dialog', { name: '添加地址', exact: true }); }
  get nameInput() { return this.form.getByPlaceholder('请输入地址名称,如:主交易钱包', { exact: true }); }
  get addressInput() { return this.form.getByPlaceholder('请输入钱包地址', { exact: true }); }

  async goto(baseURL: string): Promise<void> {
    await new ClientSettingsPage(this.page).gotoFromProfileMenu(baseURL);
    await this.page.getByRole('button', { name: '地址管理', exact: true }).click();
    await expect(this.page.getByRole('heading', { name: '地址管理', exact: true })).toBeVisible();
    await expect(this.page.getByRole('button', { name: '添加地址', exact: true })).toBeVisible();
  }
  async openAddForm(): Promise<void> {
    await this.page.getByRole('button', { name: '添加地址', exact: true }).click();
    await expect(this.form).toBeVisible();
    await expect(this.form.getByRole('combobox')).toBeEnabled();
  }
  async readAssetOptions(): Promise<string[]> {
    await this.form.getByRole('combobox').click();
    const values = await this.page.getByRole('option').allTextContents();
    await this.page.keyboard.press('Escape');
    return values.map(value => value.trim());
  }
  async fill(input: DigitalAddressInput): Promise<void> {
    validateDigitalAddressInput(input);
    await this.nameInput.fill(input.label);
    await this.form.getByRole('combobox').click();
    const option = this.page.getByRole('option').filter({ has: this.page.getByText(DIGITAL_ASSETS[input.assetKey].option, { exact: true }) });
    await expect(option).toHaveCount(1);
    await option.click();
    await this.addressInput.fill(input.address);
    // Boolean assertions prevent a failed comparison from echoing a full wallet address.
    expect(await this.nameInput.inputValue() === input.label, 'Address name retained').toBe(true);
    expect(await this.addressInput.inputValue() === input.address, 'Wallet address retained').toBe(true);
    await expect(this.form.getByRole('button', { name: '提交', exact: true })).toBeEnabled();
  }
  async cancel(): Promise<void> {
    await this.form.getByRole('button', { name: '取消', exact: true }).click();
    await expect(this.form).not.toBeVisible();
  }
  async expectEmptyValidation(): Promise<void> {
    await expect(this.nameInput).toHaveValue('');
    await expect(this.addressInput).toHaveValue('');
    await expect(this.form.getByRole('combobox')).toHaveText('请选择加密货币类型');
    await this.form.getByRole('button', { name: '提交', exact: true }).click();
    for (const text of ['请输入地址名称', '请输入钱包地址']) {
      await expect(this.form.getByText(text, { exact: true })).toBeVisible();
    }
    await expect(this.form.locator('span').filter({ hasText: /^请选择加密货币类型$/ })).toBeVisible();
    await expect(this.securityKey.dialog).not.toBeVisible();
  }
  async submitForSecurityOnce(beforeClick: () => void): Promise<void> {
    if (this.submitClicks) throw new Error('Digital address submission has already been attempted.');
    await expect(this.form.getByRole('button', { name: '提交', exact: true })).toBeEnabled();
    beforeClick();
    this.submitClicks++;
    await this.form.getByRole('button', { name: '提交', exact: true }).click();
    await this.securityKey.waitForOpen();
  }
  async verifyAndObserveCreation(key: string, beforeVerification: () => void) {
    if (!await this.securityKey.isVerificationStep()) throw new Error('Security Key setup/2FA requires a separate verified preflight; no address created.');
    await this.securityKey.fill(key);
    await expect(this.securityKey.verifyButton).toBeEnabled();
    beforeVerification();
    const origin = new URL(this.page.url()).origin;
    const [response] = await Promise.all([
      this.page.waitForResponse(r => new URL(r.url()).origin === origin && new URL(r.url()).pathname === '/api/wallet-whitelist-add' && r.request().method() === 'POST', { timeout: 30_000 }),
      this.securityKey.verifyOnce()
    ]);
    const receipt = decodeDigitalAddressReceipt(await response.json());
    if (!response.ok() || !receipt.accepted) throw new Error('Digital address business creation was not accepted; do not resubmit.');
    await expect(this.form).not.toBeVisible();
    await expect(this.securityKey.dialog).not.toBeVisible();
    return { ...receipt, httpStatus: response.status() };
  }
  async expectApprovedAddress(input: DigitalAddressInput): Promise<void> {
    const name = this.page.getByText(input.label, { exact: true }).filter({ visible: true });
    await expect(name).toHaveCount(1);
    const visibleRecord = await name.evaluate((element, expected) => {
      let current = element.parentElement;
      while (current && current.tagName !== 'MAIN') {
        const text = current.innerText;
        if (text.includes(expected.address) && /启用|禁用/.test(text)) return text;
        current = current.parentElement;
      }
      return '';
    }, input);
    const asset = DIGITAL_ASSETS[input.assetKey];
    expect(visibleRecord.includes(input.address) && visibleRecord.includes(asset.asset) && visibleRecord.includes(asset.network) && visibleRecord.includes('启用'), 'Approved wallet is visible and enabled').toBe(true);
  }
  counts() { return { clientSubmissionClicks: this.submitClicks, securityKeyVerifications: this.securityKey.verificationClickCount() }; }
}
