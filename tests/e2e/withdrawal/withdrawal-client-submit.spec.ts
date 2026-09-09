import path from 'node:path';

import { WithdrawalListPage } from '../../../pages/admin/WithdrawalListPage';
import { WithdrawalHistoryPage } from '../../../pages/client/WithdrawalHistoryPage';
import { WithdrawalPage } from '../../../pages/client/WithdrawalPage';
import type { WithdrawalTransactionDiagnostics } from '../../../pages/client/TransactionsPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import {
  advanceFlowState,
  createPreparedFlowState,
  FlowStateStore
} from '../../../src/flow-engine';
import { runWithdrawalAuthPreflight } from '../../../src/withdrawal/withdrawal-auth-preflight';
import {
  WithdrawalExecutionGuard,
  clientWithdrawalIdPattern,
  deriveUnusedWithdrawalAmount,
  type WithdrawalFingerprint
} from '../../../src/withdrawal/withdrawal-e2e';
import { assertClientTestEnvironment } from '../../../src/utils/clientSafety';
import { Decimal, decimalFromText } from '../../../src/utils/money';
import { getClientSecurityKey } from '../../../src/utils/security-key';
import { getWithdrawalTestConfig } from '../../client/withdrawal/withdrawalTestSupport';

const RECENT_AMOUNT_WINDOW_MS = 24 * 60 * 60 * 1_000;

type SafePostMetadata = {
  path: string;
  status: number;
  occurredAt: string;
  occurredAtMs: number;
};

test.describe.configure({ mode: 'serial', retries: 0 });
test.skip(
  !env.exchange.allowMoneyTests || !env.allowAdminMutationTests,
  'WD-004 requires explicit ALLOW_MONEY_TESTS=true and ALLOW_ADMIN_MUTATION_TESTS=true.'
);

test(
  '客户端创建一笔包含转账方式和支持性文件的法币出金申请',
  {
    tag: ['@client', '@withdrawal', '@mutation', '@money'],
    annotation: [
      { type: 'caseId', description: 'WD-004' },
      { type: 'priority', description: 'P0' },
      { type: 'scope', description: 'Client' }
    ]
  },
  async ({ clientPage, adminPage, business }, testInfo) => {
    test.setTimeout(180_000);
    if (!env.client.baseUrl || !env.admin.baseUrl) {
      throw new Error('CLIENT_BASE_URL and ADMIN_BASE_URL are required for WD-004.');
    }

    assertClientTestEnvironment(env.client.baseUrl);
    expect(new URL(env.admin.baseUrl).hostname.toLowerCase()).toContain('sandbox');
    expect(testInfo.config.workers).toBe(1);
    expect(testInfo.project.retries).toBe(0);
    expect(testInfo.project.repeatEach).toBe(1);
    expect(testInfo.retry).toBe(0);
    expect(testInfo.repeatEachIndex).toBe(0);

    const config = getWithdrawalTestConfig();
    const runStartedAtMs = Date.now();
    const runId = `WD004-${new Date(runStartedAtMs).toISOString().replace(/\D/g, '').slice(0, 14)}`;
    const guard = new WithdrawalExecutionGuard();
    const withdrawal = new WithdrawalPage(clientPage);
    const history = new WithdrawalHistoryPage(clientPage);
    const adminList = new WithdrawalListPage(adminPage);
    const stateStore = new FlowStateStore();
    const safePostMetadata: SafePostMetadata[] = [];
    let clientSubmittedAtMs = 0;

    clientPage.on('response', response => {
      if (response.request().method() !== 'POST') return;
      const occurredAtMs = Date.now();
      safePostMetadata.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
        occurredAt: new Date(occurredAtMs).toISOString(),
        occurredAtMs
      });
    });

    business.flow('withdrawal-client-submit', {
      preconditions: [
        'Fidere Sandbox',
        'Client自动认证和Admin认证预检通过',
        'workers=1、retries=0、repeatEach=1',
        '两个Mutation开关仅在本进程临时开启'
      ],
      target: '使用env默认账户创建一笔包含新增选填字段的法币出金申请',
      expectedResult: '安全密钥验证后产生唯一TXN申请，不执行Admin审批'
    });
    business.setBusinessData({
      runId,
      resumeStage: 'PREPARED',
      accountType: config.accountType,
      withdrawalCurrency: config.currency,
      beneficiaryAccountSuffix: `****${config.beneficiaryAccountSuffix}`,
      withdrawalPurpose: config.purpose,
      withdrawalTransferMethod: config.transferMethod,
      supportingDocument: path.basename(config.supportingDocumentPath),
      confirmationClicks: 0,
      securityVerificationClicks: 0,
      adminMutationClicks: 0,
      createdOrderCount: 0
    });

    await business.step(
      {
        action: '1. 执行Sandbox、双端认证和运行器安全预检',
        expected: 'Client/Admin业务页可访问，运行器和Mutation开关约束全部满足'
      },
      async ({ setActual }) => {
        await runWithdrawalAuthPreflight({
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
        getClientSecurityKey();
        setActual('Sandbox和双端认证有效，安全密钥已配置，单worker且无重试');
      }
    );

    await history.goto(env.client.baseUrl);
    const previousRecords = await history.readRecords();
    const previousIds = new Set(previousRecords.map(record => record.clientWithdrawalId));
    const recentAmounts = previousRecords
      .filter(record => record.occurredAtMs >= runStartedAtMs - RECENT_AMOUNT_WINDOW_MS)
      .map(record => record.requestedAmount);
    const amount = deriveUnusedWithdrawalAmount(
      runId,
      config.uniqueAmountBase,
      config.amountPrecision,
      recentAmounts
    );
    const displayedAmount = amount.toFixed(config.amountPrecision);
    const preparedState = createPreparedFlowState({
      runId,
      flowId: 'withdrawal-client-submit',
      amount: displayedAmount,
      currency: config.currency
    });
    stateStore.save(preparedState);
    business.setBusinessData({ requestedAmount: displayedAmount });

    await business.step(
      {
        action: '2. 确认本次唯一金额、余额和Admin待处理记录无冲突',
        expected: '金额高于0且不超过可用余额，历史与Admin均无同指纹候选'
      },
      async ({ setActual, setBusinessData }) => {
        expect(recentAmounts.some(value => new Decimal(value).equals(amount))).toBe(false);
        await withdrawal.goto(env.client.baseUrl!);
        await withdrawal.selectAccount(config.accountType);
        await withdrawal.selectCurrency(config.currencyLabel);
        const balance = await withdrawal.readBalanceSnapshot();
        expect(amount.greaterThan(0)).toBe(true);
        expect(amount.lessThanOrEqualTo(balance.availableBalance)).toBe(true);

        const fingerprint: WithdrawalFingerprint = {
          runId,
          userIdentity: config.adminUserIdentity,
          accountType: config.accountType,
          currency: config.currency,
          requestedAmount: displayedAmount,
          clientSubmittedAtMs: runStartedAtMs,
          adminStatus: '待处理'
        };
        await adminList.goto(env.admin.baseUrl!);
        await adminList.selectStatus('待处理');
        await adminList.searchCustomerEmail(config.adminUserIdentity);
        const adminDiagnostics = await adminList.diagnoseCandidates(
          fingerprint,
          config.matchWindowMs,
          { maxPages: 20 }
        );
        expect(adminDiagnostics.candidates).toHaveLength(0);
        setBusinessData({
          beforeAvailableBalance: balance.availableBalance.toString(),
          preSubmitAdminCandidateCount: 0,
          preSubmitAdminCandidateStages: adminDiagnostics.counts
        });
        setActual(`可用余额充足；本次唯一金额=${displayedAmount} ${config.currency}；Admin冲突候选=0`);
      }
    );

    await business.step(
      {
        action: '3. 填写出金表单并校验新增转账方式和支持性文件',
        expected: '账户、币种、收款人、用途、转账方式、支持性文件和金额全部填写成功'
      },
      async ({ setActual, setBusinessData }) => {
        await withdrawal.goto(env.client.baseUrl!);
        await withdrawal.selectAccount(config.accountType);
        await withdrawal.selectCurrency(config.currencyLabel);
        await withdrawal.selectBeneficiary({
          name: config.beneficiaryName,
          accountSuffix: config.beneficiaryAccountSuffix,
          currency: config.currency
        });
        await withdrawal.selectPurpose(config.purpose);
        const transferMethods = await withdrawal.readTransferMethodOptions();
        expect(transferMethods).toContain(config.transferMethod);
        await withdrawal.selectTransferMethod(config.transferMethod);
        const supportingDocument = await withdrawal.uploadSupportingDocument(
          config.supportingDocumentPath
        );
        await withdrawal.fillAmount(displayedAmount);
        setBusinessData({ supportingDocument, withdrawalTransferMethod: config.transferMethod });
        setActual(`已选择${config.transferMethod}，支持性文件${supportingDocument}已上传`);
      }
    );

    await business.step(
      {
        action: '4. 核对出金确认页',
        expected: '账户、收款人和精确金额与本次输入一致'
      },
      async ({ setActual, setBusinessData }) => {
        const confirmation = await withdrawal.continueToConfirmation();
        expect(confirmation.accountType).toContain(config.accountType);
        expect(confirmation.beneficiary).toBe(config.beneficiaryName);
        expect(
          decimalFromText(confirmation.requestedAmountText, 'Withdrawal confirmation amount')
            .equals(amount)
        ).toBe(true);
        setBusinessData({
          feeAmount: confirmation.feeText,
          actualDebitAmount: confirmation.actualDebitText
        });
        setActual(`确认页金额=${displayedAmount} ${config.currency}；手续费=${confirmation.feeText}；实际扣款=${confirmation.actualDebitText}`);
      }
    );

    await business.step(
      {
        action: '5. 单次确认出金并单次验证安全密钥',
        expected: '确认转账和安全密钥验证各点击一次，不自动重试'
      },
      async context => {
        guard.assertClientSubmissionAllowed(
          env.exchange.allowMoneyTests,
          env.allowAdminMutationTests
        );
        await withdrawal.openSecurityKeyDialogOnce();
        clientSubmittedAtMs = Date.now();
        context.markPotentiallySubmitted();
        context.disallowSafeRerun();
        await withdrawal.verifySecurityKeyOnce(
          getClientSecurityKey(),
          env.exchange.allowMoneyTests,
          env.allowAdminMutationTests
        );
        business.markMutationPerformed('客户端法币出金申请');
        expect(withdrawal.confirmationClicks()).toBe(1);
        expect(withdrawal.securityVerificationClicks()).toBe(1);
        context.setBusinessData({
          confirmationClicks: 1,
          securityVerificationClicks: 1,
          safeToRerun: false
        });
        context.setActual('确认转账点击1次，安全密钥验证点击1次');
      }
    );

    await business.step(
      {
        action: '6. 从Client交易流水和出金详情读取唯一新增TXN',
        expected: '按账户、币种、精确金额、收款尾号、时间窗口和历史排除得到唯一TXN'
      },
      async context => {
        let diagnostics: WithdrawalTransactionDiagnostics | undefined;
        try {
          await expect.poll(async () => {
            await history.goto(env.client.baseUrl!);
            diagnostics = await history.diagnose({
              accountType: config.accountType,
              currency: config.currency,
              requestedAmount: displayedAmount,
              beneficiaryAccountSuffix: config.beneficiaryAccountSuffix,
              occurredFromMs: clientSubmittedAtMs - config.matchWindowMs,
              occurredToMs: Date.now() + config.matchWindowMs,
              excludedLedgerTransactionIds: previousIds
            });
            return diagnostics.candidates.length;
          }, {
            message: 'Client Withdrawal did not expose exactly one new TXN record.',
            timeout: 45_000
          }).toBe(1);
        } catch (error) {
          context.requireManualReview('Client出金历史');
          context.setBusinessData({
            finalStatus: '安全密钥已验证，但Client新增出金记录结果不明确',
            resumeStage: 'SECURITY_KEY_VERIFICATION_ATTEMPTED'
          });
          throw error;
        }

        const record = diagnostics!.candidates[0];
        const detailDrawer = await history.openDetail(record);
        const detail = await detailDrawer.readFiatWithdrawalDetail();
        expect(clientWithdrawalIdPattern.test(detail.clientWithdrawalId)).toBe(true);
        expect(detail.clientWithdrawalId).toBe(record.clientWithdrawalId);
        expect(detail.accountType).toBe(config.accountType);
        expect(detail.currency).toBe(config.currency);
        expect(new Decimal(detail.requestedAmount).equals(amount)).toBe(true);
        guard.recordClientSubmission(detail.clientWithdrawalId);

        const clientCreatedState = advanceFlowState(preparedState, 'CLIENT_CREATED', {
          clientReference: detail.clientWithdrawalId,
          clientSubmittedAt: new Date(clientSubmittedAtMs).toISOString()
        });
        stateStore.save(clientCreatedState);
        const postSubmitEvidence = safePostMetadata
          .filter(item => item.occurredAtMs >= clientSubmittedAtMs)
          .map(({ path: requestPath, status, occurredAt }) => ({ requestPath, status, occurredAt }));

        context.recordPrimaryOracle({
          id: 'WD004-P1',
          name: 'Client仅创建一条TXN出金申请',
          expected: '新增候选数=1且详情存在TXN-*',
          actual: '新增候选数=1，TXN已读取',
          status: 'passed'
        });
        context.recordPrimaryOracle({
          id: 'WD004-P2',
          name: '出金新增字段已参与本次提交',
          expected: `${config.transferMethod} + 支持性文件`,
          actual: `${config.transferMethod} + ${path.basename(config.supportingDocumentPath)}`,
          status: 'passed'
        });
        context.setBusinessData({
          withdrawalOrderId: detail.clientWithdrawalId,
          createdOrderCount: diagnostics!.candidates.length,
          clientCandidateStageCounts: diagnostics!.counts,
          clientWithdrawalStatus: detail.status,
          feeAmount: detail.feeAmount,
          safePostSubmitNetworkMetadata: postSubmitEvidence,
          resumeStage: 'CLIENT_CREATED',
          finalStatus: '客户端出金申请已创建，等待Admin后续处理',
          confirmed: true,
          safeToRerun: false
        });
        context.setActual('Client新增候选数=1，已从详情读取唯一TXN，Resume阶段=CLIENT_CREATED');
      }
    );
  }
);
