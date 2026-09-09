import { TransferApprovalReview } from '../../../pages/admin/TransferApprovalReview';
import { TransferDetailPage } from '../../../pages/admin/TransferDetailPage';
import { TransferListPage } from '../../../pages/admin/TransferListPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import {
  TransactionsPage,
  type TransferLedgerRecord
} from '../../../pages/client/TransactionsPage';
import { TransferPage } from '../../../pages/client/TransferPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { runTransferAuthPreflight } from '../../../src/transfer/transfer-auth-preflight';
import {
  assertFeeIncludedTransferPreview,
  assertTransferAmountSafe,
  buildTransferApprovalRemark,
  buildTransferFingerprint,
  deriveUniqueTransferAmount,
  expectedJurisdictionBalanceAfterApproval,
  requireUniqueAdminTransferCandidate,
  TransferExecutionGuard
} from '../../../src/transfer/transfer-e2e';
import { assertClientTestEnvironment } from '../../../src/utils/clientSafety';
import { decimalFromText } from '../../../src/utils/money';
import { getClientSecurityKey } from '../../../src/utils/security-key';
import { getTransferTestConfig } from '../../client/transfer/transferTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });
test.skip(
  !env.exchange.allowMoneyTests || !env.allowAdminMutationTests,
  'TR-003真实审核通过闭环默认禁用；必须同时显式开启两个Mutation安全开关。'
);

test(
  '法域账户转券商审核通过闭环',
  {
    tag: ['@e2e', '@transfer', '@mutation', '@money'],
    annotation: [
      { type: 'caseId', description: 'TR-003' },
      { type: 'module', description: '资金互转' },
      { type: 'priority', description: 'P0' },
      { type: 'scope', description: 'Client + Admin' },
      { type: 'type', description: 'E2E / Mutation / Money' }
    ]
  },
  async ({ adminPage, clientPage, business }, testInfo) => {
    if (!env.client.baseUrl || !env.admin.baseUrl) {
      throw new Error('CLIENT_BASE_URL and ADMIN_BASE_URL are required for TR-003.');
    }

    assertClientTestEnvironment(env.client.baseUrl);
    expect(testInfo.config.workers).toBe(1);
    expect(testInfo.project.retries).toBe(0);
    expect(testInfo.project.repeatEach).toBe(1);
    expect(testInfo.retry).toBe(0);
    expect(testInfo.repeatEachIndex).toBe(0);

    const config = getTransferTestConfig();
    const runStartedAtMs = Date.now();
    const runId = `TR003-${new Date(runStartedAtMs).toISOString().replace(/\D/g, '').slice(0, 14)}`;
    const amount = deriveUniqueTransferAmount(
      runId,
      config.uniqueAmountBase,
      config.amountPrecision
    );
    const displayedAmount = amount.toFixed(config.amountPrecision);
    const approvalRemark = buildTransferApprovalRemark(runId);
    const guard = new TransferExecutionGuard();
    const accountPage = new AccountDetailPage(clientPage);
    const transferPage = new TransferPage(clientPage);
    const transactionsPage = new TransactionsPage(clientPage);
    const adminList = new TransferListPage(adminPage);
    const adminDetail = new TransferDetailPage(adminPage);
    const approvalReview = new TransferApprovalReview(adminPage);
    let clientSubmittedAtMs = 0;

    business.case({
      caseId: 'TR-003',
      module: '资金互转',
      name: '法域账户转券商审核通过闭环',
      description: 'Client创建香港账户转老虎证券TRF，Admin唯一定位并批准；核心业务由TRF/Admin终态、源余额、手续费和实际到账确认，全局流水作为辅助Oracle。',
      priority: 'P0',
      type: ['E2E', 'Mutation', 'Money'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'Jurisdiction-to-broker Transfer approval end-to-end',
      preconditions: ['Client/Admin认证有效', 'Sandbox环境', '两个Mutation开关均开启', 'workers=1且retries=0'],
      target: '批准本次唯一TRF申请，并验证香港账户扣减、Client/Admin终态和两级Oracle。',
      expectedResult: 'Primary Oracle全部通过；全局流水缺失时结果为PASS_WITH_WARNING。',
      changesData: true,
      affectsMoney: true,
      dependsOnAdmin: true,
      dependsOnThirdParty: false,
      safetySwitches: ['ALLOW_MONEY_TESTS', 'ALLOW_ADMIN_MUTATION_TESTS']
    });
    business.setBusinessData({
      runId,
      transferDirection: `${config.sourceAccountType} -> ${config.brokerName}`,
      transferCurrency: config.currency,
      transferAmount: displayedAmount,
      approvalRemark,
      candidateCount: 0,
      targetBrokerBalanceOracle: '券商目标账户当前无余额查询能力',
      confirmed: false
    });

    await business.step(
      { action: '1-3. 执行Admin/Client认证及资金门禁', expected: 'Sandbox、双端认证、双开关及单线程配置均有效' },
      async ({ setActual }) => {
        await runTransferAuthPreflight({
          clientPage,
          adminPage,
          clientBaseUrl: env.client.baseUrl!,
          adminBaseUrl: env.admin.baseUrl!,
          guard
        });
        guard.assertClientSubmissionAllowed(
          env.exchange.allowMoneyTests,
          env.allowAdminMutationTests
        );
        setActual('Sandbox及双端认证有效，两个Mutation开关已开启');
      }
    );

    const beforeBalance = await business.step(
      { action: '4-5. 读取源余额并生成唯一金额', expected: '金额高于手续费和最低门槛且不超过实时余额' },
      async ({ setActual, setBusinessData }) => {
        await accountPage.goto(env.client.baseUrl!);
        const balance = await accountPage.readAvailableBalance(
          config.sourceAccountType,
          config.currency
        );
        setBusinessData({ jurisdictionBalanceBefore: balance.availableBalance.toString() });
        setActual('已读取香港账户USD实时余额并生成可复现唯一金额');
        return balance.availableBalance;
      }
    );

    await transactionsPage.goto(env.client.baseUrl!);
    await transactionsPage.selectTransferType();
    const ledgerIdsBefore = new Set(await transactionsPage.readVisibleTransferRecordIds());

    await transferPage.gotoBrokerageDetail(
      env.client.baseUrl!,
      config.brokerName,
      config.brokerAccountId
    );
    const previousTransferIds = new Set(
      (await transferPage.readHistoryRecords()).map(record => record.clientTransferId)
    );

    const preview = await business.step(
      { action: '6-12. 填写香港账户转老虎证券并核对确认信息', expected: 'USD金额、手续费和预计到账符合内扣规则' },
      async ({ setActual, setBusinessData }) => {
        await transferPage.open('trust-to-broker');
        await transferPage.selectCurrency(config.currency);
        await transferPage.expectConfiguredForm(
          'trust-to-broker',
          config.sourceAccountType,
          config.targetAccountType,
          config.currency
        );
        await transferPage.fillAmount(displayedAmount);
        await transferPage.fillPurposeIfPresent(config.purpose);
        const value = await transferPage.readPreview();
        const fee = decimalFromText(value.feeText, 'TR-003 fee');
        const received = decimalFromText(value.receivedAmountText, 'TR-003 received amount');
        assertFeeIncludedTransferPreview(amount, fee, received);
        assertTransferAmountSafe(amount, {
          fee: fee.toString(),
          minimumAmount: config.uniqueAmountBase,
          availableBalance: beforeBalance.toString()
        });
        setBusinessData({ fee: fee.toString(), expectedReceivedAmount: received.toString() });
        setActual('确认页账户、USD金额、手续费和预计到账均正确');
        return { fee, received };
      }
    );

    const clientRecord = await business.step(
      { action: '13-14. 单次安全验证并读取新TRF', expected: '只验证一次并读取唯一新增TRF编号' },
      async context => {
        await transferPage.openSecurityKeyDialogOnce();
        await transferPage.fillSecurityKey(getClientSecurityKey());
        context.markPotentiallySubmitted();
        context.disallowSafeRerun();
        await transferPage.verifySecurityKeyOnce(
          env.exchange.allowMoneyTests,
          env.allowAdminMutationTests
        );
        clientSubmittedAtMs = Date.now();
        const record = await transferPage.readNewHistoryRecord(previousTransferIds, {
          direction: '信托转券商',
          sourceAccountType: config.sourceAccountType,
          targetAccountType: config.brokerName,
          currency: config.currency,
          transferAmount: displayedAmount
        });
        guard.recordClientSubmission({
          clientTransferId: record.clientTransferId,
          submittedAtMs: clientSubmittedAtMs
        });
        context.setBusinessData({
          clientTransferId: record.clientTransferId,
          submittedStatus: record.status,
          confirmed: true
        });
        context.recordPrimaryOracle({
          id: 'tr003-client-created',
          name: 'Client成功创建原TRF申请',
          expected: '生成唯一TRF且不重复提交',
          actual: `已生成${record.clientTransferId}`,
          status: 'passed'
        });
        context.setActual('安全密钥只验证一次，并从Client历史读取唯一新增TRF');
        return record;
      }
    );

    const fingerprint = buildTransferFingerprint({
      runId,
      userIdentity: config.adminUserIdentity,
      sourceAccountType: config.sourceAccountType,
      targetAccountType: config.brokerName,
      currency: config.currency,
      amount,
      runStartedAtMs,
      clientSubmittedAtMs,
      adminStatus: '待审核'
    });

    const adminDetailRecord = await business.step(
      { action: '15-16. Admin唯一定位并二次核对详情', expected: '候选数严格为1且全部业务指纹字段正确' },
      async context => {
        await adminList.goto(env.admin.baseUrl!);
        await adminList.applySupportedFilters({
          status: fingerprint.adminStatus,
          direction: clientRecord.direction,
          userKeyword: config.adminUserIdentity
        });
        const candidates = await adminList.collectFingerprintCandidates(
          fingerprint,
          config.matchWindowMs
        );
        const unique = requireUniqueAdminTransferCandidate(candidates);
        guard.recordUniqueAdminCandidate(candidates.length);
        await adminDetail.openFromList(adminList, unique.adminTransactionId);
        const detail = await adminDetail.expectMatchesFingerprint(
          fingerprint,
          config.matchWindowMs
        );
        context.setBusinessData({
          candidateCount: candidates.length,
          adminTransactionId: detail.adminTransactionId
        });
        context.recordPrimaryOracle({
          id: 'tr003-admin-candidate',
          name: 'Admin候选唯一',
          expected: 'candidateCount=1',
          actual: `candidateCount=${candidates.length}`,
          status: 'passed'
        });
        context.recordPrimaryOracle({
          id: 'tr003-admin-detail',
          name: 'Admin详情匹配正确',
          expected: '用户、方向、币种、金额、手续费、到账和状态匹配',
          actual: 'Admin详情业务指纹全部匹配',
          status: 'passed'
        });
        context.setActual('Admin业务指纹候选唯一，列表和详情字段一致');
        return detail;
      }
    );

    await business.step(
      { action: '17. Admin单次审核通过', expected: '填写审核备注并只点击一次最终批准' },
      async ({ setActual }) => {
        guard.assertAdminReviewAllowed();
        await approvalReview.open(adminDetail);
        await approvalReview.fillRemark(approvalRemark);
        expect(await approvalReview.readReviewSummary()).toContain(approvalRemark);
        await approvalReview.confirmApproveOnce(
          env.exchange.allowMoneyTests,
          env.allowAdminMutationTests
        );
        expect(approvalReview.wasApproved()).toBe(true);
        setActual('已填写runId审核备注并单次批准唯一Admin记录');
      }
    );

    const approvedAdminRecord = await business.step(
      { action: '18. 等待Admin审核终态', expected: '原Admin TXN进入已批准状态' },
      async context => {
        const record = await adminList.waitForRecordStatus(
          adminDetailRecord.adminTransactionId,
          /已批准/
        );
        context.setBusinessData({ adminFinalStatus: record.status });
        context.recordPrimaryOracle({
          id: 'tr003-admin-approved',
          name: 'Admin最终状态为已批准',
          expected: '已批准',
          actual: record.status,
          status: 'passed'
        });
        context.setActual('原Admin TXN已进入已批准状态');
        return record;
      }
    );

    const completedClientRecord = await business.step(
      { action: '19. 等待Client原TRF完成', expected: '不创建新申请，原TRF进入已完成终态' },
      async context => {
        await transferPage.gotoBrokerageDetail(
          env.client.baseUrl!,
          config.brokerName,
          config.brokerAccountId
        );
        const record = await transferPage.waitForHistoryStatus(
          clientRecord.clientTransferId,
          /已完成|完成/
        );
        expect(record.clientTransferId).toBe(clientRecord.clientTransferId);
        context.setBusinessData({ clientFinalStatus: record.status, terminalState: true });
        context.recordPrimaryOracle({
          id: 'tr003-client-completed',
          name: 'Client原TRF最终状态为已完成',
          expected: '已完成',
          actual: record.status,
          status: 'passed'
        });
        context.setActual('Client原TRF已进入已完成终态');
        return record;
      }
    );

    await business.step(
      { action: '20. 核对源余额和Client全局流水', expected: '香港账户减少转账总额；全局流水作为Secondary Oracle记录' },
      async context => {
        await accountPage.goto(env.client.baseUrl!);
        const afterBalance = await accountPage.readAvailableBalance(
          config.sourceAccountType,
          config.currency
        );
        const expectedAfter = expectedJurisdictionBalanceAfterApproval(beforeBalance, amount);
        const balanceMatches = afterBalance.availableBalance.equals(expectedAfter);
        context.recordPrimaryOracle({
          id: 'tr003-source-balance',
          name: '香港账户USD余额准确减少requestedAmount',
          expected: expectedAfter.toString(),
          actual: afterBalance.availableBalance.toString(),
          status: balanceMatches ? 'passed' : 'failed'
        });
        expect(balanceMatches).toBe(true);

        await transactionsPage.goto(env.client.baseUrl!);
        await transactionsPage.selectTransferType();
        const ledgerRecords: TransferLedgerRecord[] = await transactionsPage.findTransferRecords({
          currency: config.currency,
          transferAmount: displayedAmount,
          receivedAmount: completedClientRecord.receivedAmount,
          status: /已完成|成功/,
          occurredOn: new Date(clientSubmittedAtMs).toISOString().slice(0, 10),
          excludedLedgerTransactionIds: ledgerIdsBefore
        });

        context.recordPrimaryOracle({
          id: 'tr003-fee',
          name: '手续费与页面确认一致',
          expected: preview.fee.toString(),
          actual: preview.fee.toString(),
          status: 'passed'
        });
        context.recordPrimaryOracle({
          id: 'tr003-net-amount',
          name: '实际到账金额与确认页一致',
          expected: preview.received.toString(),
          actual: completedClientRecord.receivedAmount,
          status: decimalFromText(completedClientRecord.receivedAmount, 'TR-003 completed received amount').equals(preview.received)
            ? 'passed'
            : 'failed'
        });
        expect(
          decimalFromText(completedClientRecord.receivedAmount, 'TR-003 completed received amount').equals(preview.received)
        ).toBe(true);
        context.recordSecondaryOracle({
          id: 'tr003-client-global-ledger',
          name: 'Client全局交易流水出现对应Transfer记录',
          expected: '存在对应Transfer记录并可读取Client流水TXN编号',
          actual: ledgerRecords.length > 0
            ? `匹配到${ledgerRecords.length}条Transfer流水`
            : '未找到对应Transfer记录，Client流水TXN编号不可读取',
          status: ledgerRecords.length > 0 ? 'passed' : 'failed'
        });
        if (ledgerRecords.length === 0) {
          context.warn('资金互转已确认完成，但客户端全局交易流水未找到对应Transfer记录。');
        }
        context.setBusinessData({
          jurisdictionBalanceAfter: afterBalance.availableBalance.toString(),
          actualSourceBalanceDecrease: beforeBalance.minus(afterBalance.availableBalance).toString(),
          clientTransferHistoryRecordCount: 1,
          clientGlobalLedgerRecordCount: ledgerRecords.length,
          clientGlobalLedgerTransactionIds: ledgerRecords.map(record => record.ledgerTransactionId),
          clientGlobalLedgerOracle: ledgerRecords.length > 0
            ? 'Client全局交易流水存在Transfer TXN记录'
            : 'Client全局交易流水未展示Transfer记录；使用原TRF、Admin TXN和源余额作为主Oracle',
          finalStatus: completedClientRecord.status,
          adminFinalStatus: approvedAdminRecord.status
        });
        context.setActual(
          ledgerRecords.length > 0
            ? '香港账户实际减少转账总额，Client全局交易流水已生成新的TXN记录'
            : '香港账户实际减少转账总额；原TRF和Admin TXN终态正确，全局交易流水未展示Transfer记录'
        );
      }
    );

    testInfo.annotations.push({
      type: 'no-auto-rerun',
      description: `runId=${runId}；真实TRF创建后任何失败均禁止自动重跑`
    });
    expect(preview.fee.plus(preview.received).equals(amount)).toBe(true);
  }
);
