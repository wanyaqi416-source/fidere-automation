import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { TransferPage } from '../../../pages/client/TransferPage';
import { TransferDetailPage } from '../../../pages/admin/TransferDetailPage';
import { TransferListPage } from '../../../pages/admin/TransferListPage';
import { TransferRejectDialog } from '../../../pages/admin/TransferRejectDialog';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { runTransferAuthPreflight } from '../../../src/transfer/transfer-auth-preflight';
import {
  assertTransferAmountSafe,
  buildTransferFingerprint,
  buildTransferRejectReason,
  deriveUniqueTransferAmount,
  requireUniqueAdminTransferCandidate,
  TransferExecutionGuard
} from '../../../src/transfer/transfer-e2e';
import { decimalFromText } from '../../../src/utils/money';
import { getClientSecurityKey } from '../../../src/utils/security-key';
import { assertClientTestEnvironment } from '../../../src/utils/clientSafety';
import { getTransferTestConfig } from '../../client/transfer/transferTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });
test.skip(
  !env.exchange.allowMoneyTests || !env.allowAdminMutationTests,
  'TR-002真实拒绝闭环默认禁用；必须同时显式开启两个Mutation安全开关。'
);

test(
  '资金互转审核拒绝闭环',
  {
    tag: ['@e2e', '@transfer', '@mutation', '@money'],
    annotation: [
      { type: 'caseId', description: 'TR-002' },
      { type: 'module', description: '资金互转' },
      { type: 'priority', description: 'P0' },
      { type: 'scope', description: 'Client + Admin' },
      { type: 'type', description: 'E2E / Mutation / Money' }
    ]
  },
  async ({ adminPage, clientPage, business }, testInfo) => {
    if (!env.client.baseUrl || !env.admin.baseUrl) {
      throw new Error('CLIENT_BASE_URL and ADMIN_BASE_URL are required for TR-002.');
    }

    assertClientTestEnvironment(env.client.baseUrl);
    expect(testInfo.config.workers).toBe(1);
    expect(testInfo.project.retries).toBe(0);
    expect(testInfo.project.repeatEach).toBe(1);
    expect(testInfo.retry).toBe(0);
    expect(testInfo.repeatEachIndex).toBe(0);

    const config = getTransferTestConfig();
    const runStartedAtMs = Date.now();
    const runId = `TR002-${new Date(runStartedAtMs).toISOString().replace(/\D/g, '').slice(0, 14)}`;
    const amount = deriveUniqueTransferAmount(
      runId,
      config.uniqueAmountBase,
      config.amountPrecision
    );
    const displayedAmount = amount.toFixed(config.amountPrecision);
    const guard = new TransferExecutionGuard();
    const accountPage = new AccountDetailPage(clientPage);
    const transferPage = new TransferPage(clientPage);
    const adminList = new TransferListPage(adminPage);
    const adminDetail = new TransferDetailPage(adminPage);
    const rejectDialog = new TransferRejectDialog(adminPage);
    const rejectReason = buildTransferRejectReason(runId);
    let clientSubmittedAtMs = 0;

    business.case({
      caseId: 'TR-002',
      module: '资金互转',
      name: '资金互转审核拒绝闭环',
      description: 'Client创建TRF申请，Admin按业务指纹唯一定位并拒绝，Client验证原TRF终态和法域余额恢复。',
      priority: 'P0',
      type: ['E2E', 'Mutation', 'Money'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'Transfer rejection end-to-end',
      preconditions: [
        'Client与Admin认证均有效',
        'Sandbox环境',
        '两个Mutation安全开关均开启',
        'workers=1且retries=0'
      ],
      target: '拒绝本次唯一TRF申请并验证法域余额没有永久扣减。',
      expectedResult: 'Admin候选数为1，原TRF进入拒绝终态，拒绝后法域余额等于提交前余额。',
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
      candidateCount: 0,
      rejectReason,
      confirmed: false
    });

    await business.step(
      { action: '执行Client/Admin双端认证预检', expected: '两端认证均有效，且在Client提交前完成' },
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
        setActual('Client与Admin认证均有效，两个Mutation安全开关已开启');
      }
    );

    const beforeBalance = await business.step(
      { action: '读取提交前法域账户余额', expected: '按账户类型和币种读取唯一可用余额' },
      async ({ setActual, setBusinessData }) => {
        await accountPage.goto(env.client.baseUrl!);
        const balance = await accountPage.readAvailableBalance(
          config.sourceAccountType,
          config.currency
        );
        setBusinessData({ jurisdictionBalanceBefore: balance.availableBalance.toString() });
        setActual('已读取提交前法域账户可用余额');
        return balance.availableBalance;
      }
    );

    await transferPage.gotoBrokerageDetail(
      env.client.baseUrl,
      config.brokerName,
      config.brokerAccountId
    );
    const previousIds = new Set(
      (await transferPage.readHistoryRecords()).map(record => record.clientTransferId)
    );

    const preview = await business.step(
      { action: '填写并核对资金互转申请', expected: '方向、币种、金额、手续费和预计到账正确' },
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
        await transferPage.expectAmountValue(displayedAmount);
        await transferPage.fillPurposeIfPresent(config.purpose);
        const value = await transferPage.readPreview();
        const fee = decimalFromText(value.feeText, 'Transfer fee');
        const received = decimalFromText(value.receivedAmountText, 'Transfer received amount');
        expect(fee.plus(received).equals(amount)).toBe(true);
        assertTransferAmountSafe(amount, {
          fee: fee.toString(),
          minimumAmount: config.uniqueAmountBase,
          availableBalance: beforeBalance.toString()
        });
        setBusinessData({
          fee: value.feeText,
          expectedReceivedAmount: received.toString()
        });
        setActual('申请摘要与Decimal金额计算一致，金额不超过法域账户余额');
        return value;
      }
    );

    const clientRecord = await business.step(
      { action: '单次安全验证并读取新TRF', expected: '安全验证一次，Client历史新增唯一TRF申请' },
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
        const record = await transferPage.readNewHistoryRecord(previousIds, {
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
          transactionStatus: record.status,
          confirmed: true
        });
        context.setActual('已单次验证并从真实Client历史读取新增TRF申请');
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

    const adminRecord = await business.step(
      { action: 'Admin按业务指纹定位唯一候选', expected: '候选数量严格等于1并完成详情二次核对' },
      async ({ setActual, setBusinessData }) => {
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
        expect(detail.adminTransactionId).toBe(unique.adminTransactionId);
        setBusinessData({
          candidateCount: candidates.length,
          adminTransactionId: detail.adminTransactionId
        });
        setActual('Admin业务指纹候选唯一，列表和详情字段一致');
        return detail;
      }
    );

    await business.step(
      { action: 'Admin拒绝唯一资金互转申请', expected: '填写runId拒绝原因并仅确认拒绝一次' },
      async ({ setActual }) => {
        guard.assertAdminReviewAllowed();
        await rejectDialog.open(adminDetail);
        await rejectDialog.fillReason(rejectReason);
        expect(await rejectDialog.readConfirmationSummary()).toContain(rejectReason);
        await rejectDialog.confirmRejectOnce(
          env.exchange.allowMoneyTests,
          env.allowAdminMutationTests
        );
        expect(rejectDialog.wasConfirmed()).toBe(true);
        setActual(`已拒绝唯一Admin记录${adminRecord.adminTransactionId}`);
      }
    );

    const rejectedRecord = await business.step(
      { action: 'Client按原TRF等待拒绝终态', expected: '原TRF状态为拒绝，不创建新申请' },
      async ({ setActual, setBusinessData }) => {
        await transferPage.gotoBrokerageDetail(
          env.client.baseUrl!,
          config.brokerName,
          config.brokerAccountId
        );
        const record = await transferPage.waitForHistoryStatus(
          clientRecord.clientTransferId,
          /已拒绝|拒绝/
        );
        expect(record.clientTransferId).toBe(clientRecord.clientTransferId);
        if (record.rejectReason) {
          expect(record.rejectReason).toContain(runId);
        }
        setBusinessData({
          finalStatus: record.status,
          terminalState: true
        });
        setActual('Client原TRF已进入拒绝终态');
        return record;
      }
    );

    await business.step(
      { action: '核对拒绝后法域账户余额', expected: '拒绝后余额等于提交前余额' },
      async ({ setActual, setBusinessData }) => {
        await accountPage.goto(env.client.baseUrl!);
        const afterBalance = await accountPage.readAvailableBalance(
          config.sourceAccountType,
          config.currency
        );
        expect(afterBalance.availableBalance.equals(beforeBalance)).toBe(true);
        setBusinessData({
          jurisdictionBalanceAfter: afterBalance.availableBalance.toString(),
          finalStatus: rejectedRecord.status
        });
        setActual('拒绝终态后法域账户余额与提交前一致，没有永久扣减');
      }
    );

    testInfo.annotations.push({
      type: 'no-auto-rerun',
      description: `runId=${runId}；真实TRF创建后任何失败均禁止自动重跑`
    });
    expect(preview.feeText).toBeTruthy();
  }
);
