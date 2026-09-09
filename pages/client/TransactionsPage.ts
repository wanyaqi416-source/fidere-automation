import { expect, type Locator, type Page } from '@playwright/test';

import { extractLedgerTransactionId } from '../../src/utils/business-id';
import { Decimal, decimalFromText } from '../../src/utils/money';
import { ExchangeDetailDrawer } from './ExchangeDetailDrawer';
import { clientRouteUrl } from './HomePage';
import { TransactionDetailDrawer } from './TransactionDetailDrawer';

export type ExchangeRecordCriteria = {
  fromCurrency: string;
  toCurrency: string;
  sourceAmount: string;
  receivedAmount: string;
  status: string;
  executedFrom: string;
  executedTo: string;
};

export type ExchangeTransactionRecord = {
  ledgerTransactionId: string;
  occurredAt: string;
  sourceAmountVisible: boolean;
  row: Locator;
};

export type TransferLedgerRecord = {
  ledgerTransactionId: string;
  clientTransferId?: string;
  occurredAt?: string;
  amounts: string[];
  currencies: string[];
  status?: string;
  rowText: string;
  row: Locator;
};

export type UserTransferLedgerRecord = {
  ledgerTransactionId: string;
  accountType: string;
  currency: string;
  signedAmount: string;
  status: string;
  occurredAt: string;
  row: Locator;
};

export type TransferLedgerCriteria = {
  currency: string;
  transferAmount: string;
  receivedAmount: string;
  status: RegExp;
  occurredOn?: string;
  sourceAccountType?: string;
  targetAccountType?: string;
  clientTransferId?: string;
  excludedLedgerTransactionIds?: ReadonlySet<string>;
};

export type DepositTransactionRecord = {
  ledgerTransactionId: string;
  clientDepositId: string;
  transactionType: string;
  accountType: string;
  currency: string;
  requestedAmount: string;
  status: string;
  occurredAt: string;
  occurredAtMs: number;
  submittedAtMs: number;
  row: Locator;
};

export type DepositTransactionCriteria = {
  accountType: string;
  currency: string;
  requestedAmount: string;
  submittedFromMs: number;
  submittedToMs: number;
  status?: RegExp;
  excludedLedgerTransactionIds?: ReadonlySet<string>;
};

export type DepositTransactionDiagnostics = {
  counts: {
    transactionType: number;
    currency: number;
    requestedAmount: number;
    timeWindow: number;
    accountType: number;
  };
  candidates: DepositTransactionRecord[];
};

export type WithdrawalTransactionRecord = {
  ledgerTransactionId: string;
  clientWithdrawalId: string;
  transactionType: string;
  beneficiaryText: string;
  accountType: string;
  currency: string;
  requestedAmount: string;
  status: string;
  occurredAt: string;
  occurredAtMs: number;
  row: Locator;
};

export type WithdrawalTransactionCriteria = {
  accountType: string;
  currency: string;
  requestedAmount: string;
  occurredFromMs: number;
  occurredToMs: number;
  status?: RegExp;
  beneficiaryAccountSuffix?: string;
  excludedLedgerTransactionIds?: ReadonlySet<string>;
};

export type WithdrawalTransactionDiagnostics = {
  counts: {
    transactionType: number;
    accountType: number;
    currency: number;
    requestedAmount: number;
    beneficiary: number;
    timeWindow: number;
    status: number;
  };
  candidates: WithdrawalTransactionRecord[];
};

function compact(value: string): string {
  return value.replace(/[\s,]/g, '');
}

function normalizedTimestamp(value: string): string {
  return value.replace('T', ' ');
}

export class TransactionsPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly searchInput: Locator;
  readonly typeFilterButton: Locator;
  readonly table: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole('heading', { name: '交易流水' });
    this.searchInput = page.getByPlaceholder('搜索交易编号');
    this.typeFilterButton = page.getByRole('button', { name: /类型:/ });
    this.table = page.getByRole('table').filter({
      has: page.getByRole('columnheader', { name: '交易编号' })
    });
  }

  async goto(baseURL: string): Promise<void> {
    await this.page.goto(clientRouteUrl(baseURL, 'trading'), {
      waitUntil: 'domcontentloaded'
    });
    await expect(this.page).toHaveURL(/\/trading(?:$|[?#])/);
    await expect(this.heading).toBeVisible();
  }

  async selectTransferType(): Promise<void> {
    await this.typeFilterButton.click();
    await this.page.getByRole('menuitem', { name: '转账', exact: true }).click();
    await expect(this.typeFilterButton).toContainText('转账');
  }

  async selectDepositType(): Promise<void> {
    await this.typeFilterButton.click();
    await this.page.getByRole('menuitem', { name: '入金', exact: true }).click();
    await expect(this.typeFilterButton).toContainText('入金');
  }

  async selectWithdrawalType(): Promise<void> {
    await this.typeFilterButton.click();
    await this.page.getByRole('menuitem', { name: '提现', exact: true }).click();
    await expect(this.typeFilterButton).toContainText('提现');
  }

  async readVisibleWithdrawalRecords(): Promise<WithdrawalTransactionRecord[]> {
    await expect(this.table).toBeVisible();
    await expect(
      this.table.getByText(/已完成|已拒绝|待处理|处理中|暂无数据|暂无交易记录/).first()
    ).toBeVisible();
    const headers = (await this.table.getByRole('columnheader').allTextContents())
      .map(value => value.trim());
    const indexOf = (name: string): number => {
      const index = headers.indexOf(name);
      if (index < 0) throw new Error(`Client Withdrawal history is missing column: ${name}`);
      return index;
    };
    const typeIndex = indexOf('交易类型');
    const accountIndex = indexOf('账户类型');
    const amountIndex = indexOf('交易金额');
    const statusIndex = indexOf('状态');
    const timeIndex = indexOf('时间');
    const idIndex = indexOf('交易编号');
    const records: WithdrawalTransactionRecord[] = [];

    for (const row of await this.table.getByRole('row').all()) {
      const cells = row.getByRole('cell');
      if ((await cells.count()) <= idIndex) continue;
      const typeText = (await cells.nth(typeIndex).innerText()).trim();
      if (!typeText.startsWith('法币转出')) continue;
      const amountText = (await cells.nth(amountIndex).innerText()).trim();
      const currency = amountText.match(/\b[A-Z]{3}\b/)?.[0];
      const ledgerTransactionId = extractLedgerTransactionId(
        await cells.nth(idIndex).innerText()
      );
      const occurredAt = (await cells.nth(timeIndex).innerText())
        .trim()
        .replace(/\s+/g, ' ');
      const occurredAtMs = Date.parse(occurredAt.replace(' ', 'T') + '+08:00');
      if (!currency || !ledgerTransactionId || !Number.isFinite(occurredAtMs)) continue;

      records.push({
        ledgerTransactionId,
        clientWithdrawalId: ledgerTransactionId,
        transactionType: '法币转出',
        beneficiaryText: typeText.replace(/^法币转出\s*/, '').trim(),
        accountType: (await cells.nth(accountIndex).innerText()).trim(),
        currency,
        requestedAmount: decimalFromText(
          amountText,
          'Client Withdrawal list amount'
        ).abs().toString(),
        status: (await cells.nth(statusIndex).innerText()).trim(),
        occurredAt,
        occurredAtMs,
        row
      });
    }

    return records;
  }

  async diagnoseWithdrawalRecords(
    criteria: WithdrawalTransactionCriteria
  ): Promise<WithdrawalTransactionDiagnostics> {
    const expectedAmount = new Decimal(criteria.requestedAmount);
    const byType = (await this.readVisibleWithdrawalRecords()).filter(record =>
      !criteria.excludedLedgerTransactionIds?.has(record.ledgerTransactionId)
    );
    const byAccount = byType.filter(record => record.accountType === criteria.accountType);
    const byCurrency = byAccount.filter(record =>
      record.currency.toUpperCase() === criteria.currency.toUpperCase()
    );
    const byAmount = byCurrency.filter(record =>
      new Decimal(record.requestedAmount).equals(expectedAmount)
    );
    const byBeneficiary = criteria.beneficiaryAccountSuffix
      ? byAmount.filter(record =>
          record.beneficiaryText.replace(/\s/g, '').endsWith(criteria.beneficiaryAccountSuffix!)
        )
      : byAmount;
    const byTime = byBeneficiary.filter(record =>
      record.occurredAtMs >= criteria.occurredFromMs &&
      record.occurredAtMs <= criteria.occurredToMs
    );
    const candidates = criteria.status
      ? byTime.filter(record => criteria.status!.test(record.status))
      : byTime;

    return {
      counts: {
        transactionType: byType.length,
        accountType: byAccount.length,
        currency: byCurrency.length,
        requestedAmount: byAmount.length,
        beneficiary: byBeneficiary.length,
        timeWindow: byTime.length,
        status: candidates.length
      },
      candidates
    };
  }

  async findUniqueWithdrawalRecord(
    criteria: WithdrawalTransactionCriteria
  ): Promise<WithdrawalTransactionRecord> {
    const diagnostics = await this.diagnoseWithdrawalRecords(criteria);
    if (diagnostics.candidates.length !== 1) {
      throw new Error(
        `无法唯一定位Client出金记录：业务指纹匹配到 ${diagnostics.candidates.length} 条记录。`
      );
    }
    return diagnostics.candidates[0];
  }

  async withdrawalRecordById(
    ledgerTransactionId: string
  ): Promise<WithdrawalTransactionRecord | undefined> {
    return (await this.readVisibleWithdrawalRecords()).find(
      record => record.ledgerTransactionId === ledgerTransactionId
    );
  }

  async openWithdrawalDetail(
    record: WithdrawalTransactionRecord
  ): Promise<TransactionDetailDrawer> {
    await record.row.getByText(record.ledgerTransactionId, { exact: true }).click();
    const drawer = new TransactionDetailDrawer(this.page, record.ledgerTransactionId);
    await drawer.waitForWithdrawalOpen();
    return drawer;
  }

  async readVisibleDepositRecords(): Promise<DepositTransactionRecord[]> {
    await expect(this.table).toBeVisible();
    await expect(
      this.table.getByText(/已完成|已拒绝|待处理|处理中|暂无数据/).first()
    ).toBeVisible();
    const headers = (await this.table.getByRole('columnheader').allTextContents())
      .map(value => value.trim());
    const indexOf = (name: string): number => {
      const index = headers.indexOf(name);
      if (index < 0) throw new Error(`Client Deposit history is missing column: ${name}`);
      return index;
    };
    const typeIndex = indexOf('交易类型');
    const accountIndex = indexOf('账户类型');
    const amountIndex = indexOf('交易金额');
    const statusIndex = indexOf('状态');
    const timeIndex = indexOf('时间');
    const idIndex = indexOf('交易编号');
    const rowSnapshots = await this.table.getByRole('row').evaluateAll(rows =>
      rows.map(row =>
        Array.from(row.querySelectorAll('td')).map(cell =>
          (cell.textContent ?? '').trim().replace(/\s+/g, ' ')
        )
      )
    );
    const records: DepositTransactionRecord[] = [];

    for (const cells of rowSnapshots) {
      if (cells.length <= idIndex) continue;
      const transactionTypeText = cells[typeIndex];
      if (!transactionTypeText.startsWith('法币转入')) continue;

      const amountText = cells[amountIndex];
      const currency = amountText.match(/\b[A-Z]{3}\b/)?.[0];
      const ledgerTransactionId = extractLedgerTransactionId(cells[idIndex]);
      const occurredAt = cells[timeIndex];
      const occurredAtMs = Date.parse(occurredAt.replace(' ', 'T') + '+08:00');
      if (!currency || !ledgerTransactionId || !Number.isFinite(occurredAtMs)) continue;

      records.push({
        ledgerTransactionId,
        clientDepositId: ledgerTransactionId,
        transactionType: '法币转入',
        accountType: cells[accountIndex],
        currency,
        requestedAmount: decimalFromText(amountText, 'Client Deposit list amount').abs().toString(),
        status: cells[statusIndex],
        occurredAt,
        occurredAtMs,
        submittedAtMs: occurredAtMs,
        row: this.businessRow(ledgerTransactionId)
      });
    }

    return records;
  }

  async diagnoseDepositRecords(
    criteria: DepositTransactionCriteria
  ): Promise<DepositTransactionDiagnostics> {
    const records = await this.readVisibleDepositRecords();
    const expectedAmount = new Decimal(criteria.requestedAmount);
    const byType = records.filter(record =>
      !criteria.excludedLedgerTransactionIds?.has(record.ledgerTransactionId)
    );
    const byCurrency = byType.filter(record =>
      record.currency.toUpperCase() === criteria.currency.toUpperCase()
    );
    const byAmount = byCurrency.filter(record =>
      new Decimal(record.requestedAmount).equals(expectedAmount)
    );
    const byTime = byAmount.filter(record =>
      record.occurredAtMs >= criteria.submittedFromMs &&
      record.occurredAtMs <= criteria.submittedToMs
    );
    const byAccount = byTime.filter(record => record.accountType === criteria.accountType);
    const candidates = criteria.status
      ? byAccount.filter(record => criteria.status!.test(record.status))
      : byAccount;

    return {
      counts: {
        transactionType: byType.length,
        currency: byCurrency.length,
        requestedAmount: byAmount.length,
        timeWindow: byTime.length,
        accountType: byAccount.length
      },
      candidates
    };
  }

  async findUniqueDepositRecord(
    criteria: DepositTransactionCriteria
  ): Promise<DepositTransactionRecord> {
    const diagnostics = await this.diagnoseDepositRecords(criteria);
    if (diagnostics.candidates.length !== 1) {
      throw new Error(
        `无法唯一定位Client入金记录：业务指纹匹配到 ${diagnostics.candidates.length} 条记录。`
      );
    }
    return diagnostics.candidates[0];
  }

  async depositRecordById(ledgerTransactionId: string): Promise<DepositTransactionRecord | undefined> {
    return (await this.readVisibleDepositRecords()).find(
      record => record.ledgerTransactionId === ledgerTransactionId
    );
  }

  async openDepositDetail(record: DepositTransactionRecord): Promise<TransactionDetailDrawer> {
    const row = this.businessRow(record.ledgerTransactionId);
    await expect(row).toHaveCount(1);
    await expect(row).toBeVisible();
    await row.click();
    const drawer = new TransactionDetailDrawer(this.page, record.ledgerTransactionId);
    await drawer.waitForOpen();
    return drawer;
  }

  async readVisibleTransferRecords(): Promise<TransferLedgerRecord[]> {
    await expect(this.table).toBeVisible();
    const rows = await this.table
      .getByRole('row')
      .filter({ has: this.page.getByRole('cell') })
      .filter({ hasText: /TXN-[A-Z0-9-]+/i })
      .all();

    const records: TransferLedgerRecord[] = [];
    for (const row of rows) {
      const rowText = (await row.innerText()).trim();
      if (!/^转账(?:\s|$)/.test(rowText)) {
        continue;
      }
      const ledgerTransactionId = extractLedgerTransactionId(rowText);
      if (!ledgerTransactionId) {
        continue;
      }

      const clientTransferId = rowText.match(/\bTRF-[A-Z0-9-]+\b/i)?.[0];
      const occurredAt = rowText.match(
        /\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\b/
      )?.[0];
      const amountMatches = [...rowText.matchAll(/-?[\d,]+(?:\.\d+)?/g)]
        .map(match => match[0].replace(/,/g, ''));
      const currencyMatches = [...rowText.matchAll(/\b[A-Z][A-Z0-9_]{2,20}\b/g)]
        .map(match => match[0]);

      records.push({
        ledgerTransactionId,
        clientTransferId,
        occurredAt,
        amounts: [...new Set(amountMatches)],
        currencies: [...new Set(currencyMatches)],
        status: rowText.match(/已完成|成功|已批准|处理中|待处理|失败|已拒绝/)?.[0],
        rowText,
        row
      });
    }

    return records;
  }

  async readVisibleUserTransferRecords(): Promise<UserTransferLedgerRecord[]> {
    await expect(this.table).toBeVisible();
    const headers = (await this.table.getByRole('columnheader').allInnerTexts()).map(value => value.trim());
    const labels = ['交易类型', '账户类型', '交易金额', '状态', '时间', '交易编号'];
    if (labels.some(label => !headers.includes(label))) throw new Error('U2U ledger headers changed.');
    const records: UserTransferLedgerRecord[] = [];
    for (const row of await this.table.getByRole('row').filter({ has: this.page.getByRole('cell') }).all()) {
      const cells = await row.getByRole('cell').allInnerTexts();
      if (cells.length !== headers.length) continue;
      const field = (label: string) => cells[headers.indexOf(label)].trim();
      if (!field('交易类型').startsWith('用户转账')) continue;
      const amount = field('交易金额').replace(/,/g, '').match(/^([+-])\s*(\d+(?:\.\d+)?)\s+([A-Z][A-Z0-9_]*)$/);
      const id = extractLedgerTransactionId(field('交易编号'));
      if (!amount || !id) throw new Error('U2U ledger amount or transaction identifier unreadable.');
      records.push({ ledgerTransactionId: id, accountType: field('账户类型'), currency: amount[3],
        signedAmount: `${amount[1]}${amount[2]}`, status: field('状态'),
        occurredAt: field('时间').replace(/\s+/g, ' '), row });
    }
    return records;
  }

  async gotoUserTransferHistory(baseURL: string): Promise<void> {
    const responsePromise = this.page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/get-activitys-table', { timeout: 20_000 });
    await this.goto(baseURL);
    const response = await responsePromise;
    expect(response.ok(), 'Client transaction history authentication is valid').toBe(true);
    const data = await response.json();
    expect(data.code, 'Client transaction history query succeeded').toBe(0);
    const records = data.data?.data;
    if (!Array.isArray(records)) throw new Error('Client history list response schema changed.');
    if (records.length > 0) {
      await expect(this.table.getByRole('row').filter({ hasText: /TXN-[A-Z0-9-]+/i })).not.toHaveCount(0);
    }
  }

  async openUserTransferDetail(record: UserTransferLedgerRecord) {
    await record.row.click();
    return new TransactionDetailDrawer(this.page, record.ledgerTransactionId).readUserTransferDetail();
  }

  async findTransferRecords(
    criteria: TransferLedgerCriteria
  ): Promise<TransferLedgerRecord[]> {
    const expectedAmounts = new Set([
      compact(criteria.transferAmount),
      compact(criteria.receivedAmount)
    ]);

    return (await this.readVisibleTransferRecords()).filter(record => {
      if (criteria.excludedLedgerTransactionIds?.has(record.ledgerTransactionId)) {
        return false;
      }
      if (criteria.clientTransferId && record.clientTransferId !== criteria.clientTransferId) {
        return false;
      }
      if (criteria.occurredOn && !record.occurredAt?.startsWith(criteria.occurredOn)) {
        return false;
      }
      if (!record.currencies.includes(criteria.currency)) {
        return false;
      }
      if (!record.amounts.some(amount => expectedAmounts.has(compact(amount)))) {
        return false;
      }
      if (!criteria.status.test(record.status ?? record.rowText)) {
        return false;
      }
      if (
        criteria.sourceAccountType &&
        criteria.targetAccountType &&
        (!record.rowText.includes(criteria.sourceAccountType) ||
          !record.rowText.includes(criteria.targetAccountType))
      ) {
        return false;
      }
      return true;
    });
  }

  async readVisibleTransferRecordIds(): Promise<string[]> {
    return (await this.readVisibleTransferRecords()).map(record => record.ledgerTransactionId);
  }

  async searchByBusinessId(businessId: string): Promise<void> {
    await this.searchInput.fill(businessId);
  }

  businessRow(businessId: string): Locator {
    return this.table.getByRole('row').filter({
      has: this.page.getByText(businessId, { exact: true })
    });
  }

  exchangeRows(fromCurrency: string, toCurrency: string): Locator {
    return this.table
      .getByRole('row')
      .filter({ hasText: `兑换${fromCurrency} → ${toCurrency}` });
  }

  async readVisibleExchangeRecordIds(
    fromCurrency: string,
    toCurrency: string
  ): Promise<string[]> {
    await expect(this.table).toBeVisible();
    const recordIds: string[] = [];

    for (const row of await this.exchangeRows(fromCurrency, toCurrency).all()) {
      const recordId = extractLedgerTransactionId(await row.innerText());

      if (recordId) {
        recordIds.push(recordId);
      }
    }

    return recordIds;
  }

  async findExchangeRecords(
    criteria: ExchangeRecordCriteria
  ): Promise<ExchangeTransactionRecord[]> {
    const records: ExchangeTransactionRecord[] = [];
    const expectedPair = compact(`兑换${criteria.fromCurrency} → ${criteria.toCurrency}`);
    const expectedReceivedAmount = compact(`${criteria.receivedAmount} ${criteria.toCurrency}`);
    const expectedSourceAmount = compact(`${criteria.sourceAmount} ${criteria.fromCurrency}`);
    const from = normalizedTimestamp(criteria.executedFrom);
    const to = normalizedTimestamp(criteria.executedTo);

    for (const row of await this.exchangeRows(criteria.fromCurrency, criteria.toCurrency).all()) {
      const text = await row.innerText();
      const compactText = compact(text);
      const ledgerTransactionId = extractLedgerTransactionId(text);
      const timestamp = text
        .match(/\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\b/)?.[0]
        .replace(/\s+/, ' ');

      if (
        !timestamp ||
        !ledgerTransactionId ||
        !compactText.includes(expectedPair) ||
        !compactText.includes(expectedReceivedAmount) ||
        !text.includes(criteria.status) ||
        timestamp < from ||
        timestamp > to
      ) {
        continue;
      }

      records.push({
        ledgerTransactionId,
        occurredAt: timestamp,
        sourceAmountVisible: compactText.includes(expectedSourceAmount),
        row
      });
    }

    return records;
  }

  async findUniqueExchangeRecord(
    criteria: ExchangeRecordCriteria
  ): Promise<ExchangeTransactionRecord> {
    const records = await this.findExchangeRecords(criteria);

    if (records.length !== 1) {
      throw new Error(
        `无法唯一定位兑换记录：按当前账号、兑换类型、币种、金额、状态和执行时间窗口匹配到 ${records.length} 条记录。`
      );
    }

    return records[0];
  }

  async openExchangeDetail(
    record: ExchangeTransactionRecord
  ): Promise<ExchangeDetailDrawer> {
    const trigger = record.row.getByText(record.ledgerTransactionId, { exact: true });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const detailDrawer = new ExchangeDetailDrawer(this.page);
    await detailDrawer.waitForOpen();
    return detailDrawer;
  }
}
