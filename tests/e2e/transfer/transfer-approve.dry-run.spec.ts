import { TransferApprovalReview } from '../../../pages/admin/TransferApprovalReview';
import { TransferDetailPage } from '../../../pages/admin/TransferDetailPage';
import { TransferListPage } from '../../../pages/admin/TransferListPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { TransactionsPage } from '../../../pages/client/TransactionsPage';
import { TransferPage } from '../../../pages/client/TransferPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { runTransferAuthPreflight } from '../../../src/transfer/transfer-auth-preflight';
import {
  assertFeeIncludedTransferPreview,
  deriveUniqueTransferAmount,
  expectedJurisdictionBalanceAfterApproval,
  requireUniqueAdminTransferCandidate,
  TransferExecutionGuard
} from '../../../src/transfer/transfer-e2e';
import { assertClientTestEnvironment } from '../../../src/utils/clientSafety';
import { decimalFromText } from '../../../src/utils/money';
import {
  getTransferDryRunConfig,
  getTransferTestConfig
} from '../../client/transfer/transferTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

test(
  'TR-003资金互转审核通过闭环Dry Run @e2e @transfer @readonly @dry-run',
  async ({ adminPage, clientPage, business }, testInfo) => {
    if (!env.client.baseUrl || !env.admin.baseUrl) {
      throw new Error('CLIENT_BASE_URL and ADMIN_BASE_URL are required for TR-003 Dry Run.');
    }

    assertClientTestEnvironment(env.client.baseUrl);
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);
    expect(testInfo.config.workers).toBe(1);
    expect(testInfo.project.retries).toBe(0);
    expect(testInfo.project.repeatEach).toBe(1);

    const config = getTransferTestConfig();
    const historyConfig = getTransferDryRunConfig();
    const runId = 'TR003-DRY-RUN';
    const proposedAmount = deriveUniqueTransferAmount(
      runId,
      config.uniqueAmountBase,
      config.amountPrecision
    );
    const guard = new TransferExecutionGuard();
    const accountPage = new AccountDetailPage(clientPage);
    const transferPage = new TransferPage(clientPage);
    const transactionsPage = new TransactionsPage(clientPage);
    const adminList = new TransferListPage(adminPage);
    const adminDetail = new TransferDetailPage(adminPage);
    const approvalReview = new TransferApprovalReview(adminPage);

    business.case({
      caseId: 'TR-003',
      module: '资金互转',
      name: '法域账户转券商审核通过闭环（Dry Run）',
      description: '使用当前表单和历史已批准Transfer只读验证TR-003金额、状态、流水和Admin批准入口。',
      priority: 'P0',
      type: ['E2E', 'Mutation', 'Money', 'Dry Run'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'Jurisdiction-to-broker Transfer approval end-to-end dry run',
      preconditions: ['两个Mutation开关均关闭', 'Client/Admin认证有效', '存在历史已批准Transfer'],
      target: '在不创建TRF、不验证安全密钥、不批准Admin记录的前提下验证TR-003完整只读Oracle。',
      expectedResult: '表单费用、历史已完成TRF、Admin已批准详情、批准入口和Client流水均可读取。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: false,
      safetySwitches: ['ALLOW_MONEY_TESTS=false', 'ALLOW_ADMIN_MUTATION_TESTS=false']
    });
    business.setBusinessData({
      runId,
      dryRun: true,
      transferDirection: `${config.sourceAccountType} -> ${config.brokerName}`,
      transferCurrency: config.currency,
      proposedTransferAmount: proposedAmount.toFixed(config.amountPrecision),
      targetBrokerBalanceOracle: '券商目标账户当前无余额查询能力',
      approved: false
    });

    await business.step(
      { action: '1-3. 执行Sandbox、双端认证和关闭状态门禁', expected: '真实业务路由有效且两个Mutation开关均关闭' },
      async ({ setActual }) => {
        await runTransferAuthPreflight({
          clientPage,
          adminPage,
          clientBaseUrl: env.client.baseUrl!,
          adminBaseUrl: env.admin.baseUrl!,
          guard
        });
        expect(() =>
          guard.assertClientSubmissionAllowed(
            env.exchange.allowMoneyTests,
            env.allowAdminMutationTests
          )
        ).toThrow('ALLOW_MONEY_TESTS is false');
        setActual('Sandbox域名及Client/Admin真实业务路由有效；两个Mutation开关均为false');
      }
    );

    const currentBalance = await business.step(
      { action: '4. 读取香港账户USD当前余额', expected: '从Client账户页读取唯一可用余额' },
      async ({ setActual, setBusinessData }) => {
        await accountPage.goto(env.client.baseUrl!);
        const balance = await accountPage.readAvailableBalance(
          config.sourceAccountType,
          config.currency
        );
        setBusinessData({ jurisdictionBalanceCurrent: balance.availableBalance.toString() });
        setActual('已读取香港账户USD当前可用余额');
        return balance.availableBalance;
      }
    );

    const currentPreview = await business.step(
      { action: '5-12. 生成唯一金额并核对当前费用预览', expected: '香港账户转老虎证券，手续费内扣且不提交申请' },
      async ({ setActual, setBusinessData }) => {
        await transferPage.gotoBrokerageDetail(
          env.client.baseUrl!,
          config.brokerName,
          config.brokerAccountId
        );
        await transferPage.open('trust-to-broker');
        await transferPage.selectCurrency(config.currency);
        await transferPage.expectConfiguredForm(
          'trust-to-broker',
          config.sourceAccountType,
          config.targetAccountType,
          config.currency
        );
        await transferPage.fillAmount(proposedAmount.toFixed(config.amountPrecision));
        await transferPage.fillPurposeIfPresent(config.purpose);
        const preview = await transferPage.readPreview();
        const fee = decimalFromText(preview.feeText, 'TR-003 current preview fee');
        const received = decimalFromText(
          preview.receivedAmountText,
          'TR-003 current preview received amount'
        );
        assertFeeIncludedTransferPreview(proposedAmount, fee, received);
        const expectedBalance = expectedJurisdictionBalanceAfterApproval(
          currentBalance,
          proposedAmount
        );
        expect(transferPage.wasSubmissionClicked()).toBe(false);
        await transferPage.closeWithoutSubmitting();
        setBusinessData({
          displayedFee: fee.toString(),
          displayedExpectedReceivedAmount: received.toString(),
          expectedJurisdictionBalanceAfterApproval: expectedBalance.toString(),
          sourceBalanceRule: '审核通过后源香港账户减少转账总额；手续费包含在转账金额内'
        });
        setActual('当前页面确认转账金额=手续费+预计到账；提交审核和安全密钥验证点击次数均为0');
        return { fee, received };
      }
    );

    const clientRecord = await business.step(
      { action: '13-14. 读取历史已完成Client TRF', expected: '按方向、账户、币种、金额和状态唯一定位历史记录' },
      async ({ setActual, setBusinessData }) => {
        await transferPage.gotoBrokerageDetail(
          env.client.baseUrl!,
          config.brokerName,
          config.brokerAccountId
        );
        const records = await transferPage.readHistoryRecords();
        const candidates = records.filter(record =>
          record.direction === historyConfig.direction &&
          record.sourceAccountType === config.sourceAccountType &&
          record.targetAccountType === config.brokerName &&
          record.currency === config.currency &&
          decimalFromText(record.transferAmount, 'historical Transfer amount').equals(
            decimalFromText(historyConfig.amount, 'configured historical amount')
          ) &&
          normalized(record.status) === normalized(historyConfig.clientStatus)
        );
        expect(candidates).toHaveLength(1);
        const record = candidates[0];
        const amount = decimalFromText(record.transferAmount, 'historical Transfer amount');
        const fee = decimalFromText(record.fee, 'historical Transfer fee');
        const received = decimalFromText(record.receivedAmount, 'historical received amount');
        assertFeeIncludedTransferPreview(amount, fee, received);
        setBusinessData({
          historicalClientTransferId: record.clientTransferId,
          historicalTransferAmount: amount.toString(),
          historicalFee: fee.toString(),
          historicalReceivedAmount: received.toString(),
          historicalClientStatus: record.status
        });
        setActual('历史TRF唯一且状态为已完成；历史记录同样满足手续费内扣规则');
        return record;
      }
    );

    const adminRecord = await business.step(
      { action: '15-16. 读取Admin已批准记录并二次核对详情', expected: '历史业务指纹候选唯一，详情字段与Client记录一致' },
      async ({ setActual, setBusinessData }) => {
        await adminList.goto(env.admin.baseUrl!);
        await adminList.applySupportedFilters({
          status: historyConfig.adminStatus,
          direction: historyConfig.direction,
          userKeyword: config.adminUserIdentity
        });
        const records = await adminList.readAllFilteredRecords();
        const clientDate = clientRecord.dateText.match(/\d{4}-\d{2}-\d{2}/)?.[0];
        const candidates = records.filter(record =>
          normalized(record.userIdentity).includes(normalized(config.adminUserIdentity)) &&
          normalized(record.sourceAccountType).includes(normalized(config.sourceAccountType)) &&
          normalized(record.targetAccountType).includes(normalized(config.brokerName)) &&
          record.currency === config.currency &&
          decimalFromText(record.amount, 'Admin approved amount').equals(
            decimalFromText(historyConfig.amount, 'configured historical amount')
          ) &&
          normalized(record.status).includes(normalized(historyConfig.adminStatus)) &&
          (!clientDate || record.createdAtText.includes(clientDate))
        );
        const unique = requireUniqueAdminTransferCandidate(candidates);
        await adminDetail.openFromList(adminList, unique.adminTransactionId);
        const detail = await adminDetail.readDetail();
        expect(normalized(detail.userIdentity)).toContain(normalized(config.adminUserIdentity));
        expect(normalized(detail.sourceAccountType)).toContain(normalized(config.sourceAccountType));
        expect(normalized(detail.targetAccountType)).toContain(normalized(config.brokerName));
        expect(detail.currency).toBe(config.currency);
        expect(decimalFromText(detail.amount, 'Admin approved detail amount').equals(
          decimalFromText(clientRecord.transferAmount, 'Client historical amount')
        )).toBe(true);
        expect(normalized(detail.status)).toContain(normalized(historyConfig.adminStatus));
        setBusinessData({
          historicalAdminTransactionId: detail.adminTransactionId,
          adminCandidateCount: candidates.length,
          historicalAdminStatus: detail.status
        });
        setActual('Admin历史候选数为1，详情用户、方向、币种、金额和已批准状态均正确');
        return unique;
      }
    );

    await business.step(
      { action: '17. 只读验证Admin批准入口', expected: '唯一待审核历史记录显示审核备注和批准按钮，但不点击' },
      async ({ setActual, setBusinessData }) => {
        await adminDetail.close();
        const records = await adminList.readAllFilteredRecords();
        const candidates = records.filter(record =>
          normalized(record.userIdentity).includes(normalized(config.adminUserIdentity)) &&
          normalized(record.sourceAccountType).includes(normalized(config.brokerName)) &&
          normalized(record.targetAccountType).includes(normalized(config.sourceAccountType)) &&
          record.currency === config.currency &&
          decimalFromText(record.amount, 'Admin approval-action amount').equals(
            decimalFromText(config.uniqueAmountBase, 'configured unique amount base')
          ) &&
          normalized(record.status).includes(normalized('待审核'))
        );
        const unique = requireUniqueAdminTransferCandidate(candidates);
        await adminDetail.openFromList(adminList, unique.adminTransactionId);
        await approvalReview.open(adminDetail);
        expect(await approvalReview.readReviewSummary()).toContain('审核备注');
        expect(approvalReview.wasApproved()).toBe(false);
        setBusinessData({ approveActionAvailable: true, approvalClickCount: 0 });
        setActual('审核备注和批准入口均可见；批准点击次数为0');
      }
    );

    await business.step(
      { action: '18-20. 核对历史Client终态和资金流水', expected: 'Client TRF与Admin TXN构成可关联资金记录，并记录全局交易流水覆盖情况' },
      async ({ setActual, setBusinessData }) => {
        await transactionsPage.goto(env.client.baseUrl!);
        await transactionsPage.selectTransferType();

        await transactionsPage.searchByBusinessId(clientRecord.clientTransferId);
        const trfSearchRecords = await transactionsPage.readVisibleTransferRecords();
        const trfSearchSupported = trfSearchRecords.some(
          record => record.clientTransferId === clientRecord.clientTransferId
        );
        await transactionsPage.searchByBusinessId('');

        const occurredOn = clientRecord.dateText.match(/\d{4}-\d{2}-\d{2}/)?.[0];
        const ledgerRecords = trfSearchSupported
          ? trfSearchRecords
          : await transactionsPage.findTransferRecords({
              currency: config.currency,
              transferAmount: clientRecord.transferAmount,
              receivedAmount: clientRecord.receivedAmount,
              status: /已完成|成功/,
              occurredOn
            });
        for (const record of ledgerRecords) {
          expect(record.ledgerTransactionId).toMatch(/^TXN-/);
        }
        setBusinessData({
          clientTransferHistoryRecordCount: 1,
          clientGlobalLedgerRecordCount: ledgerRecords.length,
          clientGlobalLedgerTransactionIds: ledgerRecords.map(record => record.ledgerTransactionId),
          clientLedgerTrfSearchSupported: trfSearchSupported,
          clientFinalStatus: clientRecord.status,
          adminFinalStatus: adminRecord.status,
          observedStateFlow: 'Admin已批准 -> Client已完成；历史记录未显示处理中中间态',
          clientGlobalLedgerOracle: ledgerRecords.length > 0
            ? 'Client全局交易流水存在Transfer TXN记录'
            : 'Client全局交易流水选择转账后仍未显示Transfer记录；使用Client TRF历史和Admin TXN作为资金记录Oracle'
        });
        setActual(
          ledgerRecords.length > 0
            ? `历史已完成Transfer匹配到${ledgerRecords.length}条Client全局TXN流水；未执行任何写操作`
            : '历史Client TRF和Admin TXN均已核对；Client全局交易流水未展示Transfer记录，已记录为覆盖缺口'
        );
      }
    );

    expect(transferPage.wasSubmissionClicked()).toBe(false);
    expect(transferPage.wasSecurityVerificationClicked()).toBe(false);
    expect(approvalReview.wasApproved()).toBe(false);
    expect(currentPreview.fee.plus(currentPreview.received).equals(proposedAmount)).toBe(true);
  }
);
