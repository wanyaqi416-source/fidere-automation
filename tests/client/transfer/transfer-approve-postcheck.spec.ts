import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { TransactionsPage } from '../../../pages/client/TransactionsPage';
import { TransferPage } from '../../../pages/client/TransferPage';
import { expect, test } from '../../../fixtures/client.fixture';
import { env } from '../../../src/config/env';
import { maskBusinessId } from '../../../src/reporting/sensitive-data-mask';
import { transferAccountsMatch } from '../../../src/transfer/transfer-e2e';
import { Decimal, decimalFromText } from '../../../src/utils/money';
import {
  getTransferReconciliationConfig,
  getTransferTestConfig
} from './transferTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });

test('TR-003批准后Client只读后查 @client @transfer @readonly @reconciliation @L2', async ({ page, business }, testInfo) => {
  if (!env.client.baseUrl) {
    throw new Error('CLIENT_BASE_URL is required for TR-003 postcheck.');
  }
  expect(env.exchange.allowMoneyTests).toBe(false);
  expect(env.allowAdminMutationTests).toBe(false);

  const config = getTransferTestConfig();
  const expected = getTransferReconciliationConfig();
  const amount = new Decimal(expected.requestedAmount);
  const netAmount = new Decimal(expected.netAmount);
  const transferPage = new TransferPage(page);
  const accountPage = new AccountDetailPage(page);
  const transactionsPage = new TransactionsPage(page);

  business.flow('transfer-jurisdiction-to-broker', {
    name: 'TR-003批准后Client只读后查',
    level: 'L2',
    type: ['Read-only', 'Reconciliation'],
    changesData: false,
    affectsMoney: false
  });

  await transferPage.gotoBrokerageDetail(
    env.client.baseUrl,
    config.brokerName,
    config.brokerAccountId
  );
  const completed = (await transferPage.readHistoryRecords()).filter(record =>
    record.direction === expected.recordType &&
    transferAccountsMatch(record.sourceAccountType, expected.sourceAccount) &&
    transferAccountsMatch(record.targetAccountType, expected.targetAccount) &&
    record.currency === expected.currency &&
    decimalFromText(record.transferAmount, 'postcheck Transfer amount').equals(amount) &&
    /已完成|完成/.test(record.status)
  );
  expect(completed).toHaveLength(1);
  business.recordPrimaryOracle({
    id: 'tr003-client-final-state',
    name: 'Client原TRF保持成功终态',
    expected: '唯一历史TRF状态为已完成',
    actual: completed.length === 1 ? completed[0].status : `候选数=${completed.length}`,
    status:
      completed.length === 1 && /已完成|完成/.test(completed[0].status)
        ? 'passed'
        : 'failed'
  });

  await accountPage.goto(env.client.baseUrl);
  const balance = await accountPage.readAvailableBalance(
    expected.sourceAccount,
    expected.currency
  );

  await transactionsPage.goto(env.client.baseUrl);
  await transactionsPage.selectTransferType();
  const records = await transactionsPage.readVisibleTransferRecords();
  const candidates = records.filter(record => {
    const amountMatches = record.amounts.some(value => {
      const decimal = new Decimal(value);
      return decimal.isFinite() &&
        (decimal.abs().equals(amount) || decimal.abs().equals(netAmount));
    });
    return record.currencies.includes(expected.currency) &&
      amountMatches &&
      /已完成|成功|已批准/.test(record.status ?? record.rowText);
  });

  await testInfo.attach('tr003-client-postcheck.json', {
    body: Buffer.from(JSON.stringify({
      clientTransferId: maskBusinessId(completed[0].clientTransferId),
      clientStatus: completed[0].status,
      sourceBalance: balance.availableBalance.toString(),
      visibleTransferRecordCount: records.length,
      candidateCount: candidates.length,
      candidates: candidates.map(record => ({
        ledgerTransactionId: maskBusinessId(record.ledgerTransactionId),
        status: record.status,
        currencies: record.currencies,
        matchingAmounts: record.amounts.filter(value => {
          const decimal = new Decimal(value);
          return decimal.isFinite() &&
            (decimal.abs().equals(amount) || decimal.abs().equals(netAmount));
        })
      }))
    }, null, 2)),
    contentType: 'application/json'
  });

  business.setBusinessData({
    clientTransferId: completed[0].clientTransferId,
    clientFinalStatus: completed[0].status,
    sourceBalanceCurrent: balance.availableBalance.toString(),
    globalLedgerCandidateCount: candidates.length
  });
  business.recordSecondaryOracle({
    id: 'tr003-global-ledger',
    name: 'Client全局交易流水展示对应Transfer记录',
    expected: '唯一对应流水及TXN编号',
    actual: candidates.length === 1 ? '已找到唯一对应流水' : `候选数=${candidates.length}`,
    status: candidates.length === 1 ? 'passed' : 'failed'
  });
  if (candidates.length !== 1) {
    business.warn('资金互转已确认完成，但客户端全局交易流水未找到唯一对应Transfer记录。');
  }
});
