import { expect, type Page } from '@playwright/test';
import { sameAccountTypeConfiguration, withTransferFeeRule, usdTransferFeeRule, TRANSFER_FEE_LABELS, TRANSFER_FEE_CURRENCY_NAMES,
  type AccountTypeFeeSnapshot, type TransferFeeRule, type TransferFeeType } from '../../src/transfer/account-transfer-fee';

export type UsAccountTypeConfiguration = {
  accountType: '美国账户';
  channel: 'interlace';
  enabled: boolean;
  currency: string;
};

export class AccountTypeConfigurationPage {
  private readonly saveAttempts = new Set<'apply' | 'restore'>();
  constructor(readonly page: Page) {}

  get editor() { return this.page.getByRole('dialog', { name: '编辑账户类型', exact: true }); }

  async openBahrainEditor(): Promise<void> {
    const rows = this.page.locator('tbody tr').filter({ has: this.page.getByText('巴林账户', { exact: true }) });
    await expect(rows).toHaveCount(1, { timeout: 20_000 });
    await rows.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(this.editor.getByPlaceholder('例如：香港账户', { exact: true })).toHaveValue('巴林账户');
    await expect(this.editor.getByPlaceholder('例如：HK_ACCOUNT', { exact: true })).toHaveValue('BH');
    await expect(this.editor.getByText('支持币种及互转手续费', { exact: true })).toBeVisible();
  }

  private currencyRow(name: string) {
    // Verified editor DOM: currency description -> identity box -> one currency/checkbox/fee row.
    return this.editor.getByText(name, { exact: true }).locator('..').locator('..');
  }

  async readFeeConfiguration(): Promise<AccountTypeFeeSnapshot> {
    const fields: Record<string, string> = {};
    for (const placeholder of ['例如：香港账户', '例如：Hong Kong Account', '例如：香港帳戶',
      '例如：HK_ACCOUNT', '例如：HK', '例如：hk_bank', '例如：offshore']) {
      fields[placeholder] = await this.editor.getByPlaceholder(placeholder, { exact: true }).inputValue();
    }
    for (const name of ['展示排序', '开户费金额']) {
      fields[name] = await this.editor.getByRole(name === '展示排序' ? 'spinbutton' : 'textbox', { name: new RegExp(`^${name}\\s*\\*?$`) }).inputValue();
    }
    for (const name of ['状态', '开户是否需要资料', '开户费币种']) {
      const field = this.editor.locator('label').filter({ hasText: new RegExp(`^${name}\\s*\\*?$`) }).locator('..');
      fields[name] = (await field.getByRole('combobox').innerText()).trim();
    }
    const currencies: AccountTypeFeeSnapshot['currencies'] = {};
    for (const [code, name] of Object.entries(TRANSFER_FEE_CURRENCY_NAMES)) {
      const row = this.currencyRow(name);
      await expect(row.getByRole('spinbutton')).toHaveCount(1);
      const label = (await row.getByRole('combobox').innerText()).trim();
      const type = (Object.keys(TRANSFER_FEE_LABELS) as TransferFeeType[]).find(key => TRANSFER_FEE_LABELS[key] === label);
      if (!type) throw new Error('Unrecognized transfer fee mode in currency row.');
      const rule = usdTransferFeeRule(type, await row.getByRole('spinbutton').inputValue());
      currencies[code] = { enabled: await row.getByRole('checkbox').isChecked(), fee: rule.value, feeType: rule.type };
    }
    return { accountType: fields['例如：香港账户'], code: fields['例如：HK_ACCOUNT'], fields, currencies };
  }

  async fillUsdTransferFee(value: string, before: AccountTypeFeeSnapshot): Promise<void> {
    await this.fillUsdTransferFeeRule(usdTransferFeeRule('fixed', value), before);
  }

  async readUsdFeeOptions(): Promise<string[]> {
    const dropdown = this.currencyRow('美元').getByRole('combobox');
    await expect(dropdown).toHaveCount(1);
    await dropdown.click();
    const menu = this.page.getByRole('listbox');
    await expect(menu).toBeVisible();
    const options = await menu.getByRole('option').allTextContents();
    await this.page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    return options.map(value => value.trim());
  }

  async fillUsdTransferFeeRule(rule: TransferFeeRule, before: AccountTypeFeeSnapshot): Promise<void> {
    if (rule.currency !== 'USD') throw new Error('USD editor wrapper cannot change another currency.');
    await this.fillTransferFeeRule(rule, before);
  }

  async fillTransferFeeRule(rule: TransferFeeRule, before: AccountTypeFeeSnapshot): Promise<void> {
    const expected = withTransferFeeRule(before, rule);
    expect(sameAccountTypeConfiguration(await this.readFeeConfiguration(), before), 'Configuration changed before editing').toBe(true);
    const row = this.currencyRow(TRANSFER_FEE_CURRENCY_NAMES[rule.currency]), dropdown = row.getByRole('combobox');
    if ((await dropdown.innerText()).trim() !== TRANSFER_FEE_LABELS[rule.type]) {
      await dropdown.click();
      await this.page.getByRole('listbox').getByRole('option', { name: TRANSFER_FEE_LABELS[rule.type], exact: true }).click();
    }
    await expect(dropdown).toHaveText(TRANSFER_FEE_LABELS[rule.type]);
    const input = row.getByRole('spinbutton');
    await expect(input).toHaveAttribute('min', '0');
    await expect(input).toHaveAttribute('step', '0.01');
    if (rule.type === 'none') {
      await expect(input).toBeDisabled(); await expect(input).toHaveValue('0');
      await expect(row.locator('p').filter({ hasText: /^免手续费$/ })).toBeVisible();
    } else {
      await expect(input).toBeEnabled();
      if (rule.type === 'percent') {
        await expect(input).toHaveAttribute('max', '100');
        await expect(row.getByText('%', { exact: true })).toBeVisible();
      } else {
        expect(await input.getAttribute('max')).toBeNull();
        await expect(row.getByText(rule.currency, { exact: true })).toHaveCount(2);
      }
    await input.fill(expected.currencies[rule.currency].fee);
    }
    expect(sameAccountTypeConfiguration(await this.readFeeConfiguration(), expected), 'Only the selected Bahrain currency transfer fee may change').toBe(true);
    await expect(this.editor.getByRole('button', { name: '保存配置', exact: true })).toBeEnabled();
  }

  async checkUsdFeeInputValidity(value: string): Promise<{ valid: boolean; underflow: boolean; overflow: boolean; stepMismatch: boolean }> {
    const input = this.currencyRow('美元').getByRole('spinbutton');
    await expect(input).toBeEnabled();
    await input.fill(value);
    return input.evaluate((element: HTMLInputElement) => ({ valid: element.validity.valid, underflow: element.validity.rangeUnderflow,
      overflow: element.validity.rangeOverflow, stepMismatch: element.validity.stepMismatch }));
  }

  async cancelFeeEdit(): Promise<void> {
    await this.editor.getByRole('button', { name: '取消', exact: true }).click();
    await expect(this.editor).toBeHidden();
  }

  async saveFeeOnce(phase: 'apply' | 'restore', expected: AccountTypeFeeSnapshot, beforeClick: () => void): Promise<void> {
    if (this.saveAttempts.has(phase)) throw new Error(`Configuration ${phase} was already attempted; read back, never click again.`);
    expect(sameAccountTypeConfiguration(await this.readFeeConfiguration(), expected), 'Configuration changed before Save').toBe(true);
    const button = this.editor.getByRole('button', { name: '保存配置', exact: true });
    await expect(button).toBeEnabled();
    beforeClick();
    this.saveAttempts.add(phase);
    await button.click();
    await expect(this.editor).toBeHidden();
  }

  async goto(baseURL: string): Promise<void> {
    await this.page.goto(
      new URL('/zh-CN/operation/account-type-configuration', baseURL).toString(),
      { waitUntil: 'domcontentloaded' }
    );
    await expect(this.page).toHaveURL(/\/operation\/account-type-configuration/);
  }

  async readUsConfiguration(): Promise<UsAccountTypeConfiguration> {
    const row = this.page.locator('tbody tr').filter({ hasText: '美国账户' });
    await expect(row).toHaveCount(1, { timeout: 20_000 });
    const text = (await row.innerText()).replace(/\s+/g, ' ').trim();
    if (!/interlace/i.test(text)) {
      throw new Error('US Account configuration is not using the Interlace channel.');
    }
    const status = text.match(/启用|停用|正常|禁用/)?.[0];
    return {
      accountType: '美国账户',
      channel: 'interlace',
      enabled: status === '启用' || status === '正常',
      currency: text.match(/USD|美元/)?.[0] ?? '页面未提供'
    };
  }
}
