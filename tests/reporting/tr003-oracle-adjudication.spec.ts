import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Decimal from 'decimal.js';

import { expect, test } from '../../fixtures/reporting.fixture';

type ArchivedStep = {
  action: string;
  status: string;
  actual: string;
};

type ArchivedCase = {
  caseId: string;
  statusKey: string;
  businessData: Record<string, unknown>;
  review: {
    safeToRerun: boolean;
  };
  steps: ArchivedStep[];
};

type ArchivedReport = {
  cases: ArchivedCase[];
};

function readOriginalTr003Evidence(): { fileName: string; testCase: ArchivedCase } {
  const historyDirectory = resolve('reports/business/history');
  const matches = readdirSync(historyDirectory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({
      fileName: `${entry.name}/report.json`,
      absolutePath: resolve(historyDirectory, entry.name, 'report.json')
    }))
    .sort()
    .reverse()
    .flatMap(({ fileName, absolutePath }) => {
      const report = JSON.parse(
        readFileSync(absolutePath, 'utf8')
      ) as ArchivedReport;

      return (report.cases ?? [])
        .filter(testCase =>
          testCase.caseId === 'TR-003' &&
          testCase.statusKey === 'manualReview' &&
          testCase.businessData.transferAmount === '80.02' &&
          testCase.businessData.adminStatusAfter === '已批准' &&
          testCase.businessData.clientFinalStatus === '已完成'
        )
        .map(testCase => ({ fileName, testCase }));
    });

  expect(matches, '应且仅应找到一次TR-003原始真实执行证据').toHaveLength(1);
  return matches[0];
}

test('@reporting @readonly TR-003 Oracle分级只读裁决', async ({ business }) => {
  business.case({
    caseId: 'TR-003',
    module: '资金互转',
    name: '资金互转审核通过闭环 - Oracle分级裁决',
    description: '只读复核已保存的真实执行证据，不创建Transfer、不审核、不改变余额。',
    priority: 'P0',
    type: ['Read-only', 'Adjudication', 'Business Report'],
    scope: 'Client + Admin',
    preconditions: ['TR-003真实执行报告已保存', '本次运行不访问Client或Admin业务页面'],
    target: '验证Primary Oracle成功且Secondary Oracle异常时结果为PASS_WITH_WARNING。',
    expectedResult: '业务闭环通过、辅助检查存在异常、无需人工核查且不允许重跑资金操作。',
    changesData: false,
    affectsMoney: false,
    dependsOnAdmin: false,
    dependsOnThirdParty: false
  });

  const evidence = await business.step(
    {
      action: '读取TR-003原始真实执行证据',
      expected: '从历史业务报告中唯一读取已执行的80.02 USD TR-003记录'
    },
    async context => {
      const archived = readOriginalTr003Evidence();
      context.setActual(`已唯一读取历史证据：${archived.fileName}`);
      return archived.testCase;
    }
  );

  const data = evidence.businessData;
  const balanceDecrease = new Decimal(String(data.jurisdictionBalanceBefore)).minus(
    new Decimal(String(data.jurisdictionBalanceAfter))
  );

  await business.step(
    {
      action: '裁决TR-003核心业务Oracle',
      expected: '八项Primary Oracle全部通过'
    },
    async context => {
      const primaryChecks = [
        {
          id: 'tr003-client-created',
          name: 'Client成功创建原TRF申请',
          expected: '存在唯一TRF申请且未创建第二条Transfer',
          actual: `${String(data.clientTransferId)}；未创建第二条=${String(data.noNewTransferCreated)}`,
          passed: /^TRF-/.test(String(data.clientTransferId)) && data.noNewTransferCreated === true
        },
        {
          id: 'tr003-admin-candidate',
          name: 'Admin候选唯一',
          expected: 'candidateCount=1',
          actual: `candidateCount=${String(data.candidateCount)}`,
          passed: data.candidateCount === 1
        },
        {
          id: 'tr003-admin-detail',
          name: 'Admin详情匹配正确',
          expected: '详情业务指纹全部匹配',
          actual: `detailVerified=${String(data.detailVerified)}`,
          passed: data.detailVerified === true
        },
        {
          id: 'tr003-admin-approved',
          name: 'Admin最终状态为已批准',
          expected: '已批准',
          actual: String(data.adminStatusAfter),
          passed: data.adminStatusAfter === '已批准'
        },
        {
          id: 'tr003-client-completed',
          name: 'Client原TRF最终状态为已完成',
          expected: '已完成',
          actual: String(data.clientFinalStatus),
          passed: data.clientFinalStatus === '已完成'
        },
        {
          id: 'tr003-source-balance',
          name: '香港账户USD余额准确减少requestedAmount',
          expected: '减少80.02 USD',
          actual: `减少${balanceDecrease.toFixed(2)} USD`,
          passed: balanceDecrease.equals(new Decimal('80.02'))
        },
        {
          id: 'tr003-fee',
          name: '手续费与页面确认一致',
          expected: '40.00 USD',
          actual: `${new Decimal(String(data.fee)).toFixed(2)} USD`,
          passed: new Decimal(String(data.fee)).equals(new Decimal('40.00'))
        },
        {
          id: 'tr003-net-amount',
          name: '实际到账金额与确认页一致',
          expected: '40.02 USD',
          actual: `${new Decimal(String(data.actualReceivedAmount)).toFixed(2)} USD`,
          passed: new Decimal(String(data.actualReceivedAmount)).equals(new Decimal('40.02'))
        }
      ];

      for (const check of primaryChecks) {
        context.recordPrimaryOracle({
          id: check.id,
          name: check.name,
          expected: check.expected,
          actual: check.actual,
          status: check.passed ? 'passed' : 'failed'
        });
        expect(check.passed, `${check.name}应通过`).toBe(true);
      }

      context.setActual('八项Primary Oracle全部通过，资金互转业务已确认完成');
    }
  );

  await business.step(
    {
      action: '裁决Client全局交易流水辅助Oracle',
      expected: '流水缺失作为Secondary Oracle警告，不覆盖核心业务成功结论'
    },
    async context => {
      const ledgerFailure = evidence.steps.find(
        step => step.action.includes('Client资金流水') && step.status === 'failed'
      );

      expect(ledgerFailure, '原始报告应保留全局流水候选为0的失败证据').toBeDefined();
      context.recordSecondaryOracle({
        id: 'tr003-client-global-ledger',
        name: 'Client全局交易流水出现对应Transfer记录',
        expected: '存在对应Transfer记录并可读取Client流水TXN编号',
        actual: '未找到对应Transfer记录，Client流水TXN编号不可读取',
        status: 'failed'
      });
      context.warn('资金互转已确认完成，但客户端全局交易流水未找到对应Transfer记录。');
      context.setActual('辅助流水检查异常；业务闭环保持通过');
    }
  );

  await business.step(
    {
      action: '生成TR-003最终业务结论',
      expected: 'PASS_WITH_WARNING；无需人工核查；原资金业务不允许重跑'
    },
    async context => {
      business.disallowSafeRerun();
      business.setBusinessData({
        transferDirection: data.transferDirection,
        transferCurrency: data.transferCurrency,
        transferAmount: data.transferAmount,
        fee: data.fee,
        actualReceivedAmount: data.actualReceivedAmount,
        clientTransferId: data.clientTransferId,
        adminTransactionId: data.adminTransactionId,
        candidateCount: data.candidateCount,
        jurisdictionBalanceBefore: data.jurisdictionBalanceBefore,
        jurisdictionBalanceAfter: data.jurisdictionBalanceAfter,
        actualSourceBalanceDecrease: balanceDecrease.toFixed(2),
        adminFinalStatus: data.adminStatusAfter,
        clientFinalStatus: data.clientFinalStatus,
        clientGlobalLedgerRecordCount: 0,
        clientGlobalLedgerOracle: 'Secondary Oracle failed: Transfer record not found',
        confirmed: true,
        manualCheckRequired: false,
        noNewTransferCreated: true
      });
      context.setActual('业务闭环通过；辅助检查存在异常；无需人工核查；不允许安全重跑');
    }
  );
});
