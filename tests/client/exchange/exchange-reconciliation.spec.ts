import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { TransactionsPage } from '../../../pages/client/TransactionsPage';
import { expect, test } from '../../../fixtures/client.fixture';
import { env } from '../../../src/config/env';
import {
  isExchangeBusinessId,
  isLedgerTransactionId
} from '../../../src/utils/business-id';
import { Decimal, decimalFromText } from '../../../src/utils/money';
import { getExchangeReconciliationConfig } from './exchangeTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

type HistoricalExchangeEvidence = {
  sourceAmount: string;
  sourceBalanceBefore: string;
  sourceBalanceAfter: string;
  targetBalanceBefore: string;
  targetBalanceAfter: string;
  actualReceivedAmount: string;
  fee: string;
};

type HistoricalBusinessCase = {
  caseId?: string;
  startedAt?: string;
  businessData?: Partial<HistoricalExchangeEvidence> & {
    exchangePair?: string;
  };
};

type HistoricalBusinessRun = {
  cases?: HistoricalBusinessCase[];
};

function normalizeTimestamp(value: string): string {
  return value.slice(0, 19).replace(/\//g, '-').replace('T', ' ');
}

function readHistoricalExchangeEvidence(
  exchangePair: string,
  sourceAmount: string,
  receivedAmount: string,
  executedFrom: string,
  executedTo: string
): HistoricalExchangeEvidence {
  const historyRoot = resolve('reports/business/history');
  const from = normalizeTimestamp(executedFrom);
  const to = normalizeTimestamp(executedTo);
  const matches: HistoricalExchangeEvidence[] = [];

  for (const fileName of readdirSync(historyRoot).filter(name => name.endsWith('.json'))) {
    const run = JSON.parse(
      readFileSync(resolve(historyRoot, fileName), 'utf8')
    ) as HistoricalBusinessRun;

    for (const testCase of run.cases ?? []) {
      const data = testCase.businessData;
      const startedAt = normalizeTimestamp(testCase.startedAt ?? '');

      if (
        testCase.caseId !== 'EX-001' ||
        !data ||
        data.exchangePair !== exchangePair ||
        data.sourceAmount !== sourceAmount ||
        data.actualReceivedAmount !== receivedAmount ||
        startedAt < from ||
        startedAt > to ||
        !data.sourceBalanceBefore ||
        !data.sourceBalanceAfter ||
        !data.targetBalanceBefore ||
        !data.targetBalanceAfter ||
        !data.fee
      ) {
        continue;
      }

      matches.push({
        sourceAmount: data.sourceAmount,
        sourceBalanceBefore: data.sourceBalanceBefore,
        sourceBalanceAfter: data.sourceBalanceAfter,
        targetBalanceBefore: data.targetBalanceBefore,
        targetBalanceAfter: data.targetBalanceAfter,
        actualReceivedAmount: data.actualReceivedAmount,
        fee: data.fee
      });
    }
  }

  if (matches.length !== 1) {
    throw new Error(
      `无法唯一定位EX-001原始执行证据：按币种、金额、到账和时间窗口匹配到 ${matches.length} 份历史报告。`
    );
  }

  return matches[0];
}

test(
  '客户端兑换成交记录只读复核',
  {
    tag: ['@client', '@exchange', '@readonly', '@reconciliation'],
    annotation: [
      { type: 'caseId', description: 'EX-004' },
      { type: 'module', description: '客户端兑换' },
      { type: 'priority', description: 'P0' },
      { type: 'owner', description: 'QA' },
      { type: 'requirement', description: 'Exchange completed-record reconciliation' },
      { type: 'type', description: 'Read-only / Reconciliation' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ baseURL, page, business }) => {
    if (!baseURL) {
      throw new Error('CLIENT_BASE_URL is required for the Exchange reconciliation test.');
    }

    const config = getExchangeReconciliationConfig();
    const transactionsPage = new TransactionsPage(page);
    const exchangePair = `${config.fromCurrency} -> ${config.toCurrency}`;
    let historicalEvidence: HistoricalExchangeEvidence | undefined;

    business.case({
      caseId: 'EX-004',
      module: '客户端兑换',
      name: '客户端兑换成交记录只读复核',
      description: '复核已完成EX-001的TXN流水编号、OTC兑换订单编号、详情字段和原始余额证据，不提交任何兑换。',
      priority: 'P0',
      type: ['Read-only', 'Reconciliation'],
      scope: 'Client',
      owner: 'QA',
      requirement: 'Exchange completed-record reconciliation',
      preconditions: ['客户端自动登录成功', 'EX-001已人工确认成交', 'ALLOW_MONEY_TESTS=false'],
      target: '从唯一交易流水读取TXN编号，并从对应兑换详情读取OTC订单编号。',
      expectedResult: '列表TXN与详情OTC分别读取，详情显示正确币种、金额、手续费、时间和已完成状态。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: false,
      dependsOnThirdParty: false
    });
    business.setBusinessData({
      sourceAccountType: config.sourceAccountType,
      targetAccountType: config.targetAccountType,
      fromCurrency: config.fromCurrency,
      toCurrency: config.toCurrency,
      exchangePair,
      sourceAmount: config.testAmount,
      expectedReceivedAmount: config.receivedAmount
    });

    await business.step(
      {
        action: '确认只读复核条件',
        expected: '资金开关保持关闭且仅访问已有交易数据'
      },
      async ({ setActual }) => {
        expect(env.exchange.allowMoneyTests).toBe(false);
        expect(new URL(baseURL).hostname).toMatch(/sandbox|staging|\.test$/);
        setActual('Sandbox环境已确认，ALLOW_MONEY_TESTS=false，本用例不包含兑换页面或提交动作');
      }
    );

    await business.step(
      {
        action: '读取EX-001原始执行证据',
        expected: '原始历史报告唯一记录0.01转出、0.07到账及两端余额变化'
      },
      async ({ setActual, setBusinessData }) => {
        historicalEvidence = readHistoricalExchangeEvidence(
          exchangePair,
          config.testAmount,
          config.receivedAmount,
          config.executedFrom,
          config.executedTo
        );

        const sourceDelta = new Decimal(historicalEvidence.sourceBalanceBefore).minus(
          historicalEvidence.sourceBalanceAfter
        );
        const targetDelta = new Decimal(historicalEvidence.targetBalanceAfter).minus(
          historicalEvidence.targetBalanceBefore
        );
        expect(sourceDelta.equals(new Decimal(config.testAmount))).toBe(true);
        expect(targetDelta.equals(new Decimal(config.receivedAmount))).toBe(true);
        setBusinessData({
          sourceBalanceBefore: historicalEvidence.sourceBalanceBefore,
          sourceBalanceAfter: historicalEvidence.sourceBalanceAfter,
          targetBalanceBefore: historicalEvidence.targetBalanceBefore,
          targetBalanceAfter: historicalEvidence.targetBalanceAfter,
          actualReceivedAmount: historicalEvidence.actualReceivedAmount,
          sourceAmountEvidence: 'EX-001原始历史报告及余额差'
        });
        setActual('原始历史报告保持不变，转出金额与两端余额差均已交叉验证');
      }
    );

    await business.step(
      {
        action: '打开兑换详情并取得OTC业务编号',
        expected: '按币种、金额、状态和时间窗口唯一定位TXN流水，打开兑换详情并读取唯一OTC订单编号'
      },
      async ({ setActual, setBusinessData }) => {
        await transactionsPage.goto(baseURL);
        await transactionsPage.selectTransferType();
        await expect(
          transactionsPage.exchangeRows(config.fromCurrency, config.toCurrency).first()
        ).toBeVisible();

        const record = await transactionsPage.findUniqueExchangeRecord({
          fromCurrency: config.fromCurrency,
          toCurrency: config.toCurrency,
          sourceAmount: config.testAmount,
          receivedAmount: config.receivedAmount,
          status: '已完成',
          executedFrom: config.executedFrom,
          executedTo: config.executedTo
        });
        const ledgerTransactionId = record.ledgerTransactionId;
        expect(
          isLedgerTransactionId(ledgerTransactionId),
          '交易流水列表必须显示真实TXN流水编号。'
        ).toBe(true);
        await expect(record.row).toContainText('兑换');
        await expect(record.row).toContainText(`${config.fromCurrency} → ${config.toCurrency}`);
        await expect(record.row).toContainText(`${config.receivedAmount} ${config.toCurrency}`);
        await expect(record.row).toContainText('已完成');

        const detailDrawer = await transactionsPage.openExchangeDetail(record);
        const detail = await detailDrawer.read();
        expect(
          isExchangeBusinessId(detail.exchangeOrderId),
          '兑换详情必须显示真实OTC订单编号。'
        ).toBe(true);
        expect(detail.status).toBe('已完成');
        expect(detail.sourceCurrency).toBe(config.fromCurrency);
        expect(detail.targetCurrency).toBe(config.toCurrency);
        expect(
          decimalFromText(detail.sourceAmount, 'exchange detail source amount').equals(
            new Decimal(config.testAmount)
          )
        ).toBe(true);
        expect(
          decimalFromText(detail.targetAmount, 'exchange detail target amount').equals(
            new Decimal(config.receivedAmount)
          )
        ).toBe(true);
        expect(
          decimalFromText(
            detail.actualReceivedAmount,
            'exchange detail actual received amount'
          ).equals(new Decimal(config.receivedAmount))
        ).toBe(true);
        expect(historicalEvidence?.fee).toBe('免费');
        expect(decimalFromText(detail.fee, 'exchange detail fee').isZero()).toBe(true);
        expect(detail.createdAt).toMatch(/^\d{4}年\d{1,2}月\d{1,2}日$/);
        expect(detail.completedAt).toMatch(/^\d{4}年\d{1,2}月\d{1,2}日$/);

        setBusinessData({
          ledgerTransactionId,
          exchangeOrderId: detail.exchangeOrderId,
          transactionType: '兑换',
          recordOccurredAt: record.occurredAt,
          sourceAmount: decimalFromText(detail.sourceAmount, 'exchange detail source amount').toString(),
          actualReceivedAmount: decimalFromText(
            detail.actualReceivedAmount,
            'exchange detail actual received amount'
          ).toString(),
          fee: detail.fee,
          exchangeCreatedAt: detail.createdAt,
          exchangeCompletedAt: detail.completedAt,
          transactionStatus: '已完成',
          finalStatus: '已完成',
          confirmed: true
        });
        setActual(
          record.sourceAmountVisible
            ? `已从列表读取流水编号${ledgerTransactionId}，并从兑换详情读取订单编号${detail.exchangeOrderId}；详情金额、币种、手续费和状态均匹配`
            : `已从列表读取流水编号${ledgerTransactionId}，并从兑换详情读取订单编号${detail.exchangeOrderId}；转出金额由详情及EX-001原始证据交叉验证`
        );
      }
    );

    expect(historicalEvidence).toBeDefined();
  }
);
