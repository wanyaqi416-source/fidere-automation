import { WithdrawalListPage } from '../../../pages/admin/WithdrawalListPage';
import { WithdrawalHistoryPage } from '../../../pages/client/WithdrawalHistoryPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { runWithdrawalAuthPreflight } from '../../../src/withdrawal/withdrawal-auth-preflight';
import {
  WithdrawalExecutionGuard,
  clientWithdrawalIdPattern,
  requireUniqueAdminWithdrawalCandidate,
  type WithdrawalFingerprint
} from '../../../src/withdrawal/withdrawal-e2e';
import {
  getWithdrawalReconciliationConfig,
  getWithdrawalTestConfig
} from '../../client/withdrawal/withdrawalTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'Withdrawal历史只读Reconciliation',
  {
    tag: ['@e2e', '@withdrawal', '@readonly', '@reconciliation'],
    annotation: [
      { type: 'caseId', description: 'WD-RECON' },
      { type: 'module', description: 'Client + Admin出金' },
      { type: 'priority', description: 'P0' },
      { type: 'type', description: 'Reconciliation / Read-only' }
    ]
  },
  async ({ clientPage, adminPage, business }, testInfo) => {
    test.setTimeout(120_000);
    if (!env.client.baseUrl || !env.admin.baseUrl) {
      throw new Error('CLIENT_BASE_URL and ADMIN_BASE_URL are required for Withdrawal reconciliation.');
    }
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);
    expect(testInfo.config.workers).toBe(1);
    expect(testInfo.project.retries).toBe(0);
    expect(testInfo.project.repeatEach).toBe(1);

    const config = getWithdrawalTestConfig();
    const historical = getWithdrawalReconciliationConfig();
    const guard = new WithdrawalExecutionGuard();
    const history = new WithdrawalHistoryPage(clientPage);
    const adminList = new WithdrawalListPage(adminPage);

    business.case({
      caseId: 'WD-RECON',
      module: 'Client + Admin出金',
      name: '历史法币出金只读Reconciliation',
      description: '从Client提现流水详情读取真实TXN，并用业务指纹在Admin出金审批历史中唯一匹配同一业务。',
      priority: 'P0',
      type: ['Reconciliation', 'Read-only'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'Withdrawal historical cross-system evidence',
      preconditions: ['Client/Admin认证有效', '两个Mutation开关均关闭', '存在历史已完成法币出金'],
      target: '确认Client TXN详情读取和Admin无编号业务指纹定位能力。',
      expectedResult: 'Client和Admin候选均唯一，详情TXN真实存在，零写操作。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: false,
      safetySwitches: ['ALLOW_MONEY_TESTS=false', 'ALLOW_ADMIN_MUTATION_TESTS=false']
    });
    business.setBusinessData({
      accountType: historical.accountType,
      withdrawalCurrency: historical.currency,
      requestedAmount: historical.requestedAmount,
      beneficiaryAccountSuffix: `****${historical.beneficiaryAccountSuffix}`,
      dryRun: true
    });

    await business.step(
      { action: '执行Client/Admin认证预检', expected: '两端业务页面可访问且Mutation开关关闭' },
      async ({ setActual }) => {
        await runWithdrawalAuthPreflight({
          clientPage,
          adminPage,
          clientBaseUrl: env.client.baseUrl!,
          adminBaseUrl: env.admin.baseUrl!,
          guard
        });
        expect(() => guard.assertClientSubmissionAllowed(false, false)).toThrow();
        setActual('Client与Admin业务路由均有效；写操作被双开关阻断');
      }
    );

    const clientRecord = await business.step(
      { action: '按历史业务指纹定位Client提现流水', expected: '类型、账户、币种、金额、收款尾号、状态和时间候选数为1' },
      async ({ setActual, setBusinessData }) => {
        await history.goto(env.client.baseUrl!);
        const diagnostics = await history.diagnose({
          accountType: historical.accountType,
          currency: historical.currency,
          requestedAmount: historical.requestedAmount,
          beneficiaryAccountSuffix: historical.beneficiaryAccountSuffix,
          occurredFromMs: historical.submittedAtMs - config.matchWindowMs,
          occurredToMs: historical.submittedAtMs + config.matchWindowMs,
          status: new RegExp(historical.clientStatus)
        });
        expect(diagnostics.candidates).toHaveLength(1);
        setBusinessData({
          clientWithdrawalCandidateCount: diagnostics.candidates.length,
          clientCandidateStageCounts: diagnostics.counts
        });
        setActual(`Client逐层指纹候选数=${diagnostics.candidates.length}`);
        return diagnostics.candidates[0];
      }
    );

    const detail = await business.step(
      { action: '打开法币转出详情并读取TXN', expected: '详情TXN与列表一致，金额、币种、状态和手续费可读' },
      async ({ setActual, setBusinessData }) => {
        const drawer = await history.openDetail(clientRecord);
        const value = await drawer.readFiatWithdrawalDetail();
        expect(clientWithdrawalIdPattern.test(value.clientWithdrawalId)).toBe(true);
        expect(value.clientWithdrawalId).toBe(clientRecord.clientWithdrawalId);
        expect(value.accountType).toBe(historical.accountType);
        expect(value.currency).toBe(historical.currency);
        expect(value.requestedAmount).toBe(historical.requestedAmount.replace(/\.00$/, ''));
        expect(value.status).toMatch(new RegExp(historical.clientStatus));
        setBusinessData({
          withdrawalOrderId: value.clientWithdrawalId,
          feeAmount: value.feeAmount,
          clientWithdrawalStatus: value.status,
          recordOccurredAt: clientRecord.occurredAt
        });
        setActual('已从“法币转出 详情”读取与列表一致的真实TXN和手续费');
        return value;
      }
    );

    await business.step(
      { action: '在Admin出金审批历史中交叉定位', expected: '用户、账户、币种、金额、收款尾号、状态和时间候选数严格等于1' },
      async ({ setActual, setBusinessData }) => {
        await adminList.goto(env.admin.baseUrl!);
        await adminList.searchCustomerEmail(config.adminUserIdentity);
        const fingerprint: WithdrawalFingerprint = {
          runId: 'WD-HISTORICAL-RECON',
          userIdentity: config.adminUserIdentity,
          accountType: historical.accountType,
          currency: historical.currency,
          requestedAmount: historical.requestedAmount,
          clientSubmittedAtMs: clientRecord.occurredAtMs,
          adminStatus: historical.adminStatus
        };
        const diagnostics = await adminList.diagnoseCandidates(
          fingerprint,
          config.matchWindowMs,
          { maxPages: 10 }
        );
        if (diagnostics.candidates.length !== 1) {
          throw new Error(
            `Admin Withdrawal candidate diagnostics: ${JSON.stringify(diagnostics.counts)}`
          );
        }
        const candidate = requireUniqueAdminWithdrawalCandidate(diagnostics.candidates);
        expect(candidate.feeAmount).toBe(detail.feeAmount);
        setBusinessData({
          candidateCount: diagnostics.candidates.length,
          candidateStageCounts: diagnostics.counts,
          adminTransactionId: 'Admin列表未展示独立编号',
          adminWithdrawalStatus: candidate.status,
          fingerprintFields: ['测试用户', '账户类型', '币种', '精确金额', '收款账户尾号', '状态', '时间窗口'],
          finalStatus: '历史只读Reconciliation通过'
        });
        setActual('Admin业务指纹候选数=1；Client TXN不能在Admin列表直接搜索或映射');
      }
    );
  }
);
