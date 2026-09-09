import { expect, type Locator, type Page } from '@playwright/test';

import { clientRouteUrl } from './HomePage';
import { SecurityKeyDialog, type SecurityKeyDomStructure } from './SecurityKeyDialog';

export type TransferDirection = 'trust-to-broker' | 'broker-to-trust';

export type TransferPreview = {
  feeText: string;
  receivedAmountText: string;
};

export type ClientTransferRecord = {
  clientTransferId: string;
  dateText: string;
  direction: string;
  sourceAccountType: string;
  targetAccountType: string;
  currency: string;
  transferAmount: string;
  fee: string;
  receivedAmount: string;
  status: string;
  rejectReason?: string;
};

export type NewClientTransferFingerprint = {
  direction: string;
  sourceAccountType: string;
  targetAccountType: string;
  currency: string;
  transferAmount: string;
};

const directionButtonNames: Record<TransferDirection, string> = {
  'trust-to-broker': '从信托账户转入券商账户',
  'broker-to-trust': '从券商账户转出至信托账户'
};

export class TransferPage {
  readonly page: Page;
  readonly forwardButton: Locator;
  readonly reverseButton: Locator;
  readonly dialog: Locator;
  readonly submitForReviewButton: Locator;
  readonly securityKey: SecurityKeyDialog;
  readonly historyTable: Locator;
  private submissionClicked = false;

  constructor(page: Page) {
    this.page = page;
    this.forwardButton = page.getByRole('button', {
      name: directionButtonNames['trust-to-broker'],
      exact: true
    });
    this.reverseButton = page.getByRole('button', {
      name: directionButtonNames['broker-to-trust'],
      exact: true
    });
    this.dialog = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('button', { name: '提交审核', exact: true }) });
    this.submitForReviewButton = this.dialog.getByRole('button', {
      name: '提交审核',
      exact: true
    });
    this.securityKey = new SecurityKeyDialog(page);
    this.historyTable = page
      .getByRole('table')
      .filter({ has: page.getByRole('columnheader', { name: '参考编号', exact: true }) });
  }

  async gotoBrokerageDetail(
    baseURL: string,
    brokerName: string,
    brokerAccountId: string
  ): Promise<void> {
    await this.page.goto(clientRouteUrl(baseURL, 'investment/trading/securities'), {
      waitUntil: 'domcontentloaded'
    });
    await expect(this.page).toHaveURL(/\/investment\/trading\/securities(?:$|[?#])/);
    const brokerHeading = this.page.getByRole('heading', {
      name: brokerName,
      exact: true
    });
    await expect(brokerHeading).toBeVisible();
    const brokerCard = this.page
      .locator('div')
      .filter({ has: brokerHeading })
      .filter({ has: this.page.getByRole('button', { name: '查看详情', exact: true }) })
      .last();
    const detailButton = brokerCard.getByRole('button', { name: '查看详情', exact: true });
    await expect(detailButton).toHaveCount(1);
    await detailButton.click();

    await expect(this.page).toHaveURL(url => {
      return (
        url.pathname.endsWith('/investment/trading/securities') &&
        url.searchParams.get('status') === 'opened' &&
        url.searchParams.get('accountId') === brokerAccountId
      );
    });
    await expect(this.page.getByText(brokerName, { exact: true })).toBeVisible();
    await expect(this.page.getByText('已开通', { exact: true }).first()).toBeVisible();
    await expect(this.forwardButton).toBeVisible();
    await expect(this.reverseButton).toBeVisible();
  }

  async open(direction: TransferDirection): Promise<void> {
    const trigger = direction === 'trust-to-broker' ? this.forwardButton : this.reverseButton;
    await trigger.click();
    await expect(this.dialog).toBeVisible();
    await expect(this.submitForReviewButton).toBeVisible();
  }

  async expectConfiguredForm(
    direction: TransferDirection,
    sourceAccountType: string,
    targetAccountType: string,
    currency: string
  ): Promise<void> {
    await expect(this.dialog).toContainText(sourceAccountType);
    await expect(this.dialog).toContainText(targetAccountType);
    await expect(this.dialog.getByRole('combobox', { name: /币种/ })).toHaveAccessibleName(
      new RegExp(currency)
    );
    const paymentAccount = this.dialog.getByRole(
      direction === 'trust-to-broker' ? 'combobox' : 'textbox',
      { name: /付款账户/ }
    );
    const recipientAccount = this.dialog.getByRole(
      direction === 'trust-to-broker' ? 'textbox' : 'combobox',
      { name: /收款账户/ }
    );
    await expect(paymentAccount).toBeVisible();
    await expect(recipientAccount).toBeVisible();
    if (direction === 'trust-to-broker') {
      await expect(recipientAccount).not.toHaveValue('');
    } else {
      await expect(paymentAccount).not.toHaveValue('');
      await expect(recipientAccount).toHaveAccessibleName(new RegExp(targetAccountType));
    }
    await expect(
      this.dialog.getByRole('textbox', { name: '券商账户号码', exact: true })
    ).not.toHaveValue('');
  }

  async selectCurrency(currency: string): Promise<void> {
    const currencySelect = this.dialog.getByRole('combobox', { name: /币种/ });
    await currencySelect.click();
    const option = this.page.getByRole('option', { name: currency, exact: true });
    await expect(option).toBeVisible();
    await option.click();
    await expect(currencySelect).toHaveAccessibleName(new RegExp(currency));
  }

  async readSupportedCurrencies(): Promise<string[]> {
    const currencySelect = this.dialog.getByRole('combobox', { name: /币种/ });
    await currencySelect.click();
    const options = this.page.getByRole('option');
    await expect(options.first()).toBeVisible();
    const values = (await options.allTextContents()).map(value => value.trim()).filter(Boolean);
    await this.page.keyboard.press('Escape');
    return [...new Set(values)];
  }

  async fillAmount(amount: string): Promise<void> {
    await (await this.amountInput()).fill(amount);
  }

  async expectAmountValue(amount: string): Promise<void> {
    await expect(await this.amountInput()).toHaveValue(amount);
  }

  async blurAmount(): Promise<void> {
    await (await this.amountInput()).press('Tab');
  }

  async fillPurposeIfPresent(purpose: string): Promise<boolean> {
    const purposeInput = await this.optionalVisibleLocator([
      this.dialog.getByLabel(/转账用途/),
      this.dialog.getByPlaceholder(/请输入.*用途/),
      this.dialog.getByRole('textbox', { name: '转账用途', exact: true })
    ]);

    if (!purposeInput) {
      return false;
    }

    await purposeInput.fill(purpose);
    return true;
  }

  async readSourceBalanceText(currency: string): Promise<string | undefined> {
    const paymentAccount = this.dialog.getByRole('combobox', { name: /付款账户/ });
    await paymentAccount.click();
    const options = this.page.getByRole('option');
    await expect(options.first()).toBeVisible();
    const values = (await options.allTextContents())
      .map(value => value.trim())
      .filter(value => value.includes(currency) && /\d/.test(value));
    await this.page.keyboard.press('Escape');

    return values.length === 1 ? values[0] : undefined;
  }

  async readPreview(): Promise<TransferPreview> {
    return {
      feeText: await this.readSummaryValue('手续费'),
      receivedAmountText: await this.readSummaryValue('预计到账金额')
    };
  }

  async readDisplayedLimits(): Promise<string[]> {
    return (await this.dialog.getByText(/最低|最小|最高|最大|限额/).allTextContents())
      .map(value => value.trim())
      .filter(Boolean);
  }

  async hasInsufficientBalanceState(): Promise<boolean> {
    return (
      (await this.dialog.getByText('余额不足', { exact: true }).isVisible()) ||
      (await this.submitForReviewButton.isDisabled())
    );
  }

  async expectNoSecurityKeyDialog(): Promise<void> {
    await expect(this.securityKey.dialog).not.toBeVisible();
  }

  async openSecurityKeyDialogOnce(): Promise<void> {
    await this.submitForReviewOnce();
    await this.securityKey.waitForOpen();
  }

  async readSecurityKeyDomStructure(): Promise<SecurityKeyDomStructure> {
    return this.securityKey.readDomStructure();
  }

  async fillSecurityKey(securityKey: string): Promise<void> {
    await this.securityKey.fill(securityKey);
  }

  async verifySecurityKeyOnce(
    allowMoneyTests: boolean,
    allowAdminMutationTests: boolean
  ): Promise<void> {
    if (!allowMoneyTests || !allowAdminMutationTests) {
      throw new Error(
        '资金互转安全密钥“验证”要求同时开启ALLOW_MONEY_TESTS和ALLOW_ADMIN_MUTATION_TESTS。'
      );
    }
    await this.securityKey.verifyOnce();
  }

  async closeSecurityKeyWithoutVerifying(): Promise<void> {
    await this.securityKey.closeWithoutVerifying();
  }

  wasSecurityVerificationClicked(): boolean {
    return this.securityKey.wasVerificationClicked();
  }

  async closeWithoutSubmitting(): Promise<void> {
    if (this.securityKey.wasVerificationClicked()) {
      throw new Error('资金互转已经点击安全密钥“验证”，不能作为只读校验关闭。');
    }

    const closeButton = this.dialog.getByRole('button', { name: /^(关闭|close)$/i });
    if ((await closeButton.count()) === 1) {
      await closeButton.click();
    } else {
      await this.page.keyboard.press('Escape');
    }
    await expect(this.dialog).toBeHidden();
  }

  async submitForReviewOnce(): Promise<void> {
    if (this.submissionClicked) {
      throw new Error('提交审核已点击过一次；为避免重复申请，本测试不会再次点击。');
    }

    this.submissionClicked = true;
    await this.submitForReviewButton.click();
  }

  wasSubmissionClicked(): boolean {
    return this.submissionClicked;
  }

  async readHistoryRecords(): Promise<ClientTransferRecord[]> {
    await expect(this.historyTable).toBeVisible();
    const headers = (await this.historyTable.getByRole('columnheader').allTextContents()).map(value =>
      value.trim()
    );
    const recordRows = this.historyTable
      .getByRole('row')
      .filter({ has: this.page.getByRole('cell') })
      .filter({ hasText: /TRF-[A-Z0-9-]+/i });
    const emptyState = this.historyTable.getByText(/暂无数据|没有数据|no data/i).first();
    await expect(recordRows.first().or(emptyState)).toBeVisible();
    const rows = await recordRows.all();

    return Promise.all(rows.map(row => this.readHistoryRow(row, headers)));
  }

  async readHistoryRecord(clientTransferId: string): Promise<ClientTransferRecord> {
    const row = this.historyTable
      .getByRole('row')
      .filter({ has: this.page.getByText(clientTransferId, { exact: true }) });
    await expect(row, `Client Transfer history must contain exactly one ${clientTransferId} record.`).toHaveCount(1);
    const headers = (await this.historyTable.getByRole('columnheader').allTextContents()).map(value =>
      value.trim()
    );
    return this.readHistoryRow(row, headers);
  }

  async readNewHistoryRecord(
    previousIds: ReadonlySet<string>,
    fingerprint: NewClientTransferFingerprint
  ): Promise<ClientTransferRecord> {
    await expect
      .poll(
        async () => {
          await this.page.reload({ waitUntil: 'domcontentloaded' });
          const records = await this.readHistoryRecords();
          return records.filter(record =>
            this.matchesNewRecord(record, previousIds, fingerprint)
          ).length;
        },
        { message: '等待Client历史出现本次唯一TRF申请' }
      )
      .toBe(1);

    const records = await this.readHistoryRecords();
    return records.filter(record => this.matchesNewRecord(record, previousIds, fingerprint))[0];
  }

  async waitForHistoryStatus(
    clientTransferId: string,
    terminalStatus: RegExp
  ): Promise<ClientTransferRecord> {
    await expect
      .poll(
        async () => {
          await this.page.reload({ waitUntil: 'domcontentloaded' });
          return (await this.readHistoryRecord(clientTransferId)).status;
        },
        {
          message: `等待Client Transfer ${clientTransferId}进入预期终态`,
          timeout: 30_000
        }
      )
      .toMatch(terminalStatus);

    return this.readHistoryRecord(clientTransferId);
  }

  async openHistoryDetailsIfAvailable(clientTransferId: string): Promise<Locator | undefined> {
    const row = this.historyTable
      .getByRole('row')
      .filter({ has: this.page.getByText(clientTransferId, { exact: true }) });
    await expect(row).toHaveCount(1);
    const detailButton = row.getByRole('button', { name: /查看详情|详情/ });

    if ((await detailButton.count()) !== 1) {
      return undefined;
    }

    await detailButton.click();
    const detail = this.page
      .getByRole('dialog')
      .filter({ has: this.page.getByText(clientTransferId, { exact: true }) });
    await expect(detail).toBeVisible();
    return detail;
  }

  private async amountInput(): Promise<Locator> {
    const amountInput = await this.optionalVisibleLocator([
      this.dialog.getByLabel(/转账金额/),
      this.dialog.getByPlaceholder(/请输入.*金额/),
      this.dialog.getByRole('spinbutton'),
      this.dialog.getByRole('textbox', { name: '金额', exact: true })
    ]);

    if (!amountInput) {
      throw new Error('资金互转表单没有找到可见的转账金额输入框。');
    }

    return amountInput;
  }

  private async readSummaryValue(label: string): Promise<string> {
    const summaryLabel = this.dialog.getByText(label, { exact: true });
    await expect(summaryLabel).toBeVisible();
    const readAdjacentValues = async (): Promise<string[]> => {
      return (await summaryLabel.locator('..').locator('p').allTextContents())
        .map(value => value.trim())
        .filter(Boolean)
        .filter(value => value !== label);
    };

    await expect
      .poll(async () => (await readAdjacentValues())[0] ?? '', {
        message: `等待资金互转摘要字段“${label}”完成计算`
      })
      .not.toMatch(/计算中|加载中/);
    const values = await readAdjacentValues();

    if (values.length !== 1) {
      throw new Error(`资金互转摘要字段“${label}”没有唯一相邻值。`);
    }

    return values[0];
  }

  private async readHistoryRow(
    row: Locator,
    headers: readonly string[]
  ): Promise<ClientTransferRecord> {
    const cells = row.getByRole('cell');
    const cellText = async (...names: string[]): Promise<string> => {
      const index = headers.findIndex(header => names.includes(header));
      if (index < 0) {
        throw new Error(`Client Transfer history is missing column: ${names.join(' / ')}`);
      }
      return (await cells.nth(index).innerText()).trim();
    };

    const amountText = await cellText('金额');
    const receivedAmount = amountText.split(/\r?\n/)[0]?.trim() ?? '';
    const transferAmount = amountText.match(/转账金额\s*([\d,.]+)/)?.[1];
    const fee = amountText.match(/手续费\s*([\d,.]+)/)?.[1];
    const clientTransferId = await cellText('参考编号', '申请编号');

    if (!/^TRF-[A-Z0-9-]+$/i.test(clientTransferId)) {
      throw new Error('Client Transfer history row did not contain a real TRF identifier.');
    }
    if (!transferAmount || !fee || !/[\d]/.test(receivedAmount)) {
      throw new Error(`Client Transfer ${clientTransferId} amount evidence is incomplete.`);
    }

    return {
      clientTransferId,
      dateText: await cellText('日期', '提交时间'),
      direction: await cellText('类型'),
      sourceAccountType: await cellText('来源账户', '转出账户'),
      targetAccountType: await cellText('目标账户', '转入账户'),
      currency: await cellText('币种'),
      transferAmount,
      fee,
      receivedAmount,
      status: await cellText('状态')
    };
  }

  private matchesNewRecord(
    record: ClientTransferRecord,
    previousIds: ReadonlySet<string>,
    fingerprint: NewClientTransferFingerprint
  ): boolean {
    return (
      !previousIds.has(record.clientTransferId) &&
      record.direction === fingerprint.direction &&
      record.sourceAccountType === fingerprint.sourceAccountType &&
      record.targetAccountType === fingerprint.targetAccountType &&
      record.currency === fingerprint.currency &&
      record.transferAmount.replace(/,/g, '') === fingerprint.transferAmount.replace(/,/g, '')
    );
  }

  private async optionalVisibleLocator(candidates: Locator[]): Promise<Locator | undefined> {
    for (const candidate of candidates) {
      const visible: Locator[] = [];
      for (const item of await candidate.all()) {
        if (await item.isVisible()) {
          visible.push(item);
        }
      }

      if (visible.length === 1) {
        return visible[0];
      }
    }

    return undefined;
  }
}
