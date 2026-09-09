import { expect, type Locator, type Page } from '@playwright/test';

import { clientRouteUrl } from './HomePage';
import {
  SecurityKeyDialog,
  type SecurityKeyDomStructure
} from './SecurityKeyDialog';

export type { SecurityKeyDomStructure } from './SecurityKeyDialog';

type ExchangeSide = 'source' | 'target';

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class ExchangePage {
  readonly page: Page;
  readonly dialog: Locator;
  readonly sourcePanel: Locator;
  readonly targetPanel: Locator;
  readonly sourceAssetButton: Locator;
  readonly targetAssetButton: Locator;
  readonly sourceAmountInput: Locator;
  readonly targetAmountInput: Locator;
  readonly quoteButton: Locator;
  readonly swapButton: Locator;
  readonly confirmationDialog: Locator;
  readonly returnToEditButton: Locator;
  readonly confirmExchangeButton: Locator;
  readonly securityKeyDialog: Locator;
  readonly securityKeyTitle: Locator;
  readonly securityKeyInputs: Locator;
  readonly verifySecurityKeyButton: Locator;
  readonly securityKey: SecurityKeyDialog;
  readonly positiveAmountError: Locator;
  readonly insufficientBalanceError: Locator;
  readonly sameCurrencyError: Locator;
  private exchangeConfirmationClicked = false;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page
      .getByRole('dialog')
      .filter({ has: page.getByText('资产兑换', { exact: true }) });

    const sourceLabel = this.dialog.getByText('你卖出', { exact: true });
    const targetLabel = this.dialog.getByText('你获得', { exact: true });
    this.sourcePanel = sourceLabel.locator('..').locator('..');
    this.targetPanel = targetLabel.locator('..').locator('..');
    this.sourceAssetButton = this.sourcePanel.getByRole('button');
    this.targetAssetButton = this.targetPanel.getByRole('button');
    this.sourceAmountInput = this.sourcePanel.getByRole('textbox');
    this.targetAmountInput = this.targetPanel.getByRole('textbox');
    this.quoteButton = this.dialog.getByRole('button', { name: '获取报价' });
    this.swapButton = this.dialog.getByRole('button', { name: 'swap' });

    this.confirmationDialog = page
      .getByRole('dialog')
      .filter({ has: page.getByText('指令预确认', { exact: true }) });
    this.returnToEditButton = this.confirmationDialog.getByRole('button', { name: '返回修改' });
    this.confirmExchangeButton = this.confirmationDialog.getByRole('button', {
      name: '确认兑换'
    });

    this.securityKey = new SecurityKeyDialog(page);
    this.securityKeyDialog = this.securityKey.dialog;
    this.securityKeyTitle = this.securityKey.title;
    this.securityKeyInputs = this.securityKey.inputs;
    this.verifySecurityKeyButton = this.securityKey.verifyButton;

    this.positiveAmountError = this.dialog.getByText('兑出金额必须为正数', { exact: true });
    this.insufficientBalanceError = this.dialog.getByText('余额不足', { exact: true });
    this.sameCurrencyError = this.dialog.getByText('兑出币种和兑入币种不能相同', {
      exact: true
    });
  }

  async gotoDashboard(baseURL: string): Promise<void> {
    await this.page.goto(clientRouteUrl(baseURL, 'dashboard'), {
      waitUntil: 'domcontentloaded'
    });
    await expect(this.page).toHaveURL(/\/dashboard(?:$|[?#])/);
    await expect(this.page).toHaveTitle(/Fidere Trust \| Dashboard/);
  }

  async openFromAssetRow(assetName: string, networkName: string): Promise<void> {
    const assetTable = this.page.getByRole('table').filter({
      has: this.page.getByRole('columnheader', { name: '快捷操作' })
    });
    const assetRow = assetTable
      .getByRole('row')
      .filter({ has: this.page.getByText(assetName, { exact: true }) })
      .filter({ has: this.page.getByRole('cell', { name: networkName, exact: true }) });

    await assetRow.getByRole('button', { name: '兑换' }).click();
    await expect(this.dialog).toBeVisible();
    await expect(this.dialog.getByText('实时询价 · 到账金额以最终确认为准')).toBeVisible();
    await expect(this.quoteButton).toBeVisible();
  }

  async selectSourceAsset(accountType: string, currency: string): Promise<void> {
    await this.selectAsset('source', accountType, currency);
  }

  async selectTargetAsset(accountType: string, currency: string): Promise<void> {
    await this.selectAsset('target', accountType, currency);
  }

  async fillSourceAmount(amount: string): Promise<void> {
    await this.sourceAmountInput.fill(amount);
  }

  async requestQuote(): Promise<void> {
    await this.quoteButton.click();
  }

  async readSourceBalanceText(): Promise<string> {
    return this.readBalanceText(this.sourcePanel, 'source');
  }

  async readTargetBalanceText(): Promise<string> {
    return this.readBalanceText(this.targetPanel, 'target');
  }

  async readSourceAssetLabel(): Promise<string> {
    return (await this.sourceAssetButton.innerText()).trim();
  }

  async readTargetAssetLabel(): Promise<string> {
    return (await this.targetAssetButton.innerText()).trim();
  }

  async readConfirmationText(): Promise<string> {
    return this.confirmationDialog.innerText();
  }

  async openSecurityKeyDialogOnce(): Promise<void> {
    if (this.exchangeConfirmationClicked) {
      throw new Error('确认兑换已点击过一次；为避免重复操作，本测试不会再次点击。');
    }

    this.exchangeConfirmationClicked = true;
    await this.confirmExchangeButton.click();
    await expect(
      this.securityKeyDialog,
      '打开安全密钥验证弹窗失败：点击确认兑换后，预期显示“安全密钥验证”弹窗，实际未显示。'
    ).toBeVisible();
    await expect(this.securityKeyTitle).toBeVisible();
  }

  async readSecurityKeyDomStructure(): Promise<SecurityKeyDomStructure> {
    return this.securityKey.readDomStructure();
  }

  async fillSecurityKey(securityKey: string): Promise<void> {
    await this.securityKey.fill(securityKey);
  }

  async verifySecurityKeyOnce(): Promise<void> {
    await this.securityKey.verifyOnce();
  }

  async closeSecurityKeyDialogWithoutVerifying(): Promise<void> {
    await this.securityKey.closeWithoutVerifying();
  }

  wasSecurityKeyVerificationClicked(): boolean {
    return this.securityKey.wasVerificationClicked();
  }

  private async selectAsset(
    side: ExchangeSide,
    accountType: string,
    currency: string
  ): Promise<void> {
    const trigger = side === 'source' ? this.sourceAssetButton : this.targetAssetButton;
    await trigger.click();

    const menu = this.page.getByRole('menu');
    await expect(menu).toBeVisible();
    const accountHeading = menu.getByText(accountType, { exact: true });
    await expect(accountHeading).toBeVisible();

    const optionValue = await accountHeading.evaluate((heading, targetCurrency) => {
      let candidate = heading.nextElementSibling;

      while (candidate?.getAttribute('role') === 'menuitem') {
        const labels = Array.from(candidate.querySelectorAll('p')).map(node =>
          node.textContent?.trim()
        );

        if (labels.includes(targetCurrency)) {
          return candidate.getAttribute('value');
        }

        candidate = candidate.nextElementSibling;
      }

      return null;
    }, currency);

    if (!optionValue) {
      throw new Error(`Currency ${currency} was not found under account type ${accountType}.`);
    }

    const option = menu.locator(
      `[role="menuitem"][value="${escapeAttributeValue(optionValue)}"]`
    );
    await option.click();
    await expect(menu).toBeHidden();
  }

  private async readBalanceText(panel: Locator, side: ExchangeSide): Promise<string> {
    const text = await panel.getByText(/^可用余额:/).textContent();

    if (!text) {
      throw new Error(`The ${side} available balance was not displayed.`);
    }

    return text.trim();
  }

}
