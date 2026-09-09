import { WithdrawalListPage } from '../../../pages/admin/WithdrawalListPage';
import type { WithdrawalDetailPage } from '../../../pages/admin/WithdrawalDetailPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { WithdrawalHistoryPage } from '../../../pages/client/WithdrawalHistoryPage';
import { WithdrawalPage } from '../../../pages/client/WithdrawalPage';
import type { WithdrawalTransactionRecord } from '../../../pages/client/TransactionsPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { matchesDepositCustomerIdentity } from '../../../src/deposit/deposit-e2e';
import { runWithdrawalAuthPreflight } from '../../../src/withdrawal/withdrawal-auth-preflight';
import {
  WithdrawalExecutionGuard,
  buildWithdrawalRejectReason,
  clientWithdrawalIdPattern,
  deriveUnusedWithdrawalAmount,
  matchAdminWithdrawalRecordsIgnoringStatus,
  requireUniqueAdminWithdrawalCandidate,
  type AdminWithdrawalCandidate,
  type WithdrawalFingerprint
} from '../../../src/withdrawal/withdrawal-e2e';
import { assertClientTestEnvironment } from '../../../src/utils/clientSafety';
import { Decimal, decimalFromText } from '../../../src/utils/money';
import { getClientSecurityKey } from '../../../src/utils/security-key';
import { getWithdrawalTestConfig } from '../../client/withdrawal/withdrawalTestSupport';

const REJECTED_STATUS = /已拒绝|拒绝|处理失败|failed|rejected/i;
const RECENT_AMOUNT_WINDOW_MS = 24 * 60 * 60 * 1_000;

test.describe.configure({ mode: 'serial', retries: 0 });
test.skip(
  !env.exchange.allowMoneyTests || !env.allowAdminMutationTests,
  'WD-002真实拒绝闭环默认禁用；必须同时显式开启两个Mutation安全开关。'
);

function decimalIfDisplayed(value: string, label: string): string | undefined {
  if (!/\d/.test(value)) return undefined;
  return decimalFromText(value, label).abs().toString();
}

async function readClientWithdrawalById(
  history: WithdrawalHistoryPage,
  baseURL: string,
  clientWithdrawalId: string
): Promise<WithdrawalTransactionRecord | undefined> {
  await history.goto(baseURL);
  await history.transactions.searchByBusinessId(clientWithdrawalId);
  return history.recordById(clientWithdrawalId);
}

test(
  'Client香港账户USD出金并由Admin拒绝',
  {
    tag: ['@e2e', '@withdrawal', '@mutation', '@money'],
    annotation: [
      { type: 'caseId', description: 'WD-002' },
      { type: 'module', description: 'Client + Admin出金' },
      { type: 'priority', description: 'P0' },
      { type: 'scope', description: 'Client + Admin' },
      { type: 'type', description: 'E2E / Mutation / Money' }
    ]
  },
  async ({ clientPage, adminPage, business }, testInfo) => {
    test.setTimeout(240_000);
    if (!env.client.baseUrl || !env.admin.baseUrl) {
      throw new Error('CLIENT_BASE_URL and ADMIN_BASE_URL are required for WD-002.');
    }

    assertClientTestEnvironment(env.client.baseUrl);
    expect(new URL(env.admin.baseUrl).hostname.toLocaleLowerCase()).toContain('sandbox');
    expect(testInfo.config.workers).toBe(1);
    expect(testInfo.project.retries).toBe(0);
    expect(testInfo.project.repeatEach).toBe(1);
    expect(testInfo.retry).toBe(0);
    expect(testInfo.repeatEachIndex).toBe(0);

    const config = getWithdrawalTestConfig();
    expect(new Decimal(config.uniqueAmountBase).equals(1)).toBe(true);
    const runStartedAtMs = Date.now();
    const runId = `WD002-${new Date(runStartedAtMs).toISOString().replace(/\D/g, '').slice(0, 14)}`;
    const rejectReason = buildWithdrawalRejectReason(runId);
    const guard = new WithdrawalExecutionGuard();
    const accountPage = new AccountDetailPage(clientPage);
    const withdrawalPage = new WithdrawalPage(clientPage);
    const historyPage = new WithdrawalHistoryPage(clientPage);
    const adminList = new WithdrawalListPage(adminPage);
    let clientFinalSubmitClicked = false;
    let adminRejectClicked = false;
    let clientSubmittedAtMs = 0;

    business.case({
      caseId: 'WD-002',
      module: 'Client + Admin出金',
      name: '香港账户USD出金审核拒绝闭环',
      description: 'Client单次创建唯一1.xx USD出金，Admin唯一定位并拒绝，Client按原TXN验证拒绝终态和余额恢复。',
      priority: 'P0',
      type: ['E2E', 'Mutation', 'Money'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'Withdrawal rejection end-to-end',
      preconditions: [
        'Client与Admin认证有效',
        'Fidere Sandbox',
        '香港账户USD余额和已保存收款账户可用',
        '两个Mutation安全开关开启',
        'workers=1、retries=0且repeatEach=1'
      ],
      target: '拒绝本次唯一TXN出金申请并验证香港账户USD没有永久扣减。',
      expectedResult: '原TXN存在，Admin候选数为1并拒绝成功，Client原TXN进入拒绝终态，USD余额恢复。',
      changesData: true,
      affectsMoney: true,
      dependsOnAdmin: true,
      dependsOnThirdParty: false,
      safetySwitches: ['ALLOW_MONEY_TESTS', 'ALLOW_ADMIN_MUTATION_TESTS']
    });
    business.setBusinessData({
      runId,
      accountType: config.accountType,
      withdrawalCurrency: config.currency,
      beneficiaryAccountSuffix: `****${config.beneficiaryAccountSuffix}`,
      withdrawalPurpose: config.purpose,
      rejectReason,
      candidateCount: 0,
      confirmationClicks: 0,
      securityVerificationClicks: 0,
      rejectConfirmationClicks: 0,
      noNewWithdrawalCreated: true,
      confirmed: false
    });

    await business.step(
      {
        action: '1. 执行Sandbox、双端认证和运行器安全预检',
        expected: 'Client/Admin业务页可访问，两个安全开关开启，单worker、零重试且未重复执行'
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
        setActual('Sandbox与双端认证有效；安全密钥已配置；运行器和双Mutation开关约束全部满足');
      }
    );

    const beforeBalance = await business.step(
      {
        action: '2. 读取香港账户USD提交前可观测余额',
        expected: '按账户和币种唯一读取页面可用余额，且不伪造总余额或冻结余额'
      },
      async ({ setActual, setBusinessData }) => {
        await accountPage.goto(env.client.baseUrl!);
        const balance = await accountPage.readAvailableBalance(config.accountType, config.currency);
        setBusinessData({
          beforeAvailableBalance: balance.availableBalance.toString(),
          beforeTotalBalance: '页面未提供'
        });
        setActual('香港账户USD页面可用余额已唯一读取；页面未提供独立总余额或冻结余额');
        return balance.availableBalance;
      }
    );

    await historyPage.goto(env.client.baseUrl!);
    const previousClientRecords = await historyPage.readRecords();
    const previousClientIds = new Set(
      previousClientRecords.map(record => record.clientWithdrawalId)
    );
    const recentAmounts = previousClientRecords
      .filter(record => record.occurredAtMs >= runStartedAtMs - RECENT_AMOUNT_WINDOW_MS)
      .map(record => record.requestedAmount);
    const amount = deriveUnusedWithdrawalAmount(
      runId,
      config.uniqueAmountBase,
      config.amountPrecision,
      recentAmounts
    );
    const displayedAmount = amount.toFixed(config.amountPrecision);
    expect(amount.greaterThanOrEqualTo(1) && amount.lessThan(2)).toBe(true);
    expect(amount.lessThanOrEqualTo(beforeBalance)).toBe(true);
    business.setBusinessData({
      requestedAmount: displayedAmount,
      amountPrecision: config.amountPrecision
    });

    const prospectiveFingerprint: WithdrawalFingerprint = {
      runId,
      userIdentity: config.adminUserIdentity,
      accountType: config.accountType,
      currency: config.currency,
      requestedAmount: displayedAmount,
      clientSubmittedAtMs: runStartedAtMs,
      adminStatus: '待处理'
    };

    await business.step(
      {
        action: '3. 检查唯一金额和当前待处理申请无冲突',
        expected: '近期Client未使用该1.xx金额，Admin完整业务指纹冲突候选数为0'
      },
      async ({ setActual, setBusinessData }) => {
        expect(recentAmounts.some(value => new Decimal(value).equals(amount))).toBe(false);
        await adminList.goto(env.admin.baseUrl!);
        await adminList.selectStatus('待处理');
        await adminList.searchCustomerEmail(config.adminUserIdentity);
        const diagnostics = await adminList.diagnoseCandidates(
          prospectiveFingerprint,
          config.matchWindowMs,
          { maxPages: 20 }
        );
        expect(diagnostics.candidates).toHaveLength(0);
        setBusinessData({ candidateStageCounts: diagnostics.counts });
        setActual('金额由runId确定且未与近期Client记录重复；Admin提交前冲突候选数=0');
      }
    );

    const confirmation = await business.step(
      {
        action: '4. 填写并核对Client出金确认页',
        expected: '香港账户、USD、已保存收款账户、唯一金额、用途及页面手续费信息一致'
      },
      async ({ setActual, setBusinessData }) => {
        await withdrawalPage.goto(env.client.baseUrl!);
        await withdrawalPage.selectAccount(config.accountType);
        await withdrawalPage.selectCurrency(config.currencyLabel);
        await withdrawalPage.selectBeneficiary({
          name: config.beneficiaryName,
          accountSuffix: config.beneficiaryAccountSuffix,
          currency: config.currency
        });
        await withdrawalPage.selectPurpose(config.purpose);
        await withdrawalPage.fillAmount(displayedAmount);
        const snapshot = await withdrawalPage.continueToConfirmation();
        expect(snapshot.accountType).toContain(config.accountType);
        expect(snapshot.beneficiary).toBe(config.beneficiaryName);
        expect(decimalFromText(snapshot.requestedAmountText, 'Withdrawal confirmation amount').equals(amount)).toBe(true);
        const feeAmount = decimalIfDisplayed(snapshot.feeText, 'Withdrawal confirmation fee');
        const actualDebitAmount = decimalIfDisplayed(
          snapshot.actualDebitText,
          'Withdrawal confirmation actual debit'
        );
        setBusinessData({
          feeAmount: feeAmount ?? `${snapshot.feeText}（页面未明确显示）`,
          expectedNetAmount: '页面未提供',
          actualDebitAmount: actualDebitAmount ?? `${snapshot.actualDebitText}（页面未明确显示）`
        });
        setActual(
          feeAmount
            ? '确认页业务字段一致，手续费已按页面数值记录'
            : '确认页业务字段一致；手续费仍显示“-”，已如实记录且未自行推导'
        );
        return { snapshot, feeAmount, actualDebitAmount };
      }
    );

    await business.step(
      {
        action: '5. 单次确认转账并单次验证安全密钥',
        expected: '确认转账和安全密钥“验证”各点击一次，不存在自动重试'
      },
      async context => {
        guard.assertClientSubmissionAllowed(
          env.exchange.allowMoneyTests,
          env.allowAdminMutationTests
        );
        await withdrawalPage.openSecurityKeyDialogOnce();
        clientSubmittedAtMs = Date.now();
        context.markPotentiallySubmitted();
        context.disallowSafeRerun();
        clientFinalSubmitClicked = true;
        await withdrawalPage.verifySecurityKeyOnce(
          getClientSecurityKey(),
          env.exchange.allowMoneyTests,
          env.allowAdminMutationTests
        );
        expect(withdrawalPage.confirmationClicks()).toBe(1);
        expect(withdrawalPage.securityVerificationClicks()).toBe(1);
        context.setBusinessData({
          confirmationClicks: 1,
          securityVerificationClicks: 1,
          noNewWithdrawalCreated: true
        });
        context.setActual('确认转账点击1次；安全密钥验证点击1次；不会再次提交');
      }
    );

    const clientRecord = await business.step(
      {
        action: '6. 从Client交易流水和法币转出详情读取新增TXN',
        expected: '按类型、账户、USD、精确金额、收款尾号和时间窗口得到唯一新增记录并读取TXN-*'
      },
      async context => {
        let diagnostics;
        try {
          await expect.poll(async () => {
            await historyPage.goto(env.client.baseUrl!);
            diagnostics = await historyPage.diagnose({
              accountType: config.accountType,
              currency: config.currency,
              requestedAmount: displayedAmount,
              beneficiaryAccountSuffix: config.beneficiaryAccountSuffix,
              occurredFromMs: clientSubmittedAtMs - config.matchWindowMs,
              occurredToMs: Date.now() + config.matchWindowMs,
              excludedLedgerTransactionIds: previousClientIds
            });
            return diagnostics.candidates.length;
          }, {
            message: 'Client Withdrawal did not expose exactly one new business record.',
            timeout: 45_000
          }).toBe(1);
        } catch (error) {
          context.requireManualReview('Client交易流水 / 法币转出历史');
          context.setBusinessData({
            finalStatus: '安全密钥已验证，但新增出金记录结果不明确；禁止直接重跑',
            noNewWithdrawalCreated: true
          });
          throw error;
        }
        const record = diagnostics!.candidates[0];
        const drawer = await historyPage.openDetail(record);
        const detail = await drawer.readFiatWithdrawalDetail();
        expect(clientWithdrawalIdPattern.test(detail.clientWithdrawalId)).toBe(true);
        expect(detail.clientWithdrawalId).toBe(record.clientWithdrawalId);
        expect(detail.accountType).toBe(config.accountType);
        expect(detail.currency).toBe(config.currency);
        expect(new Decimal(detail.requestedAmount).equals(amount)).toBe(true);
        guard.recordClientSubmission(detail.clientWithdrawalId);
        context.recordPrimaryOracle({
          id: 'WD002-P1',
          name: 'Client仅创建一条原TXN申请',
          expected: '唯一新增TXN-*出金申请',
          actual: `候选数=1，已读取${detail.clientWithdrawalId}`,
          status: 'passed'
        });
        context.setBusinessData({
          withdrawalOrderId: detail.clientWithdrawalId,
          clientWithdrawalCandidateCount: diagnostics!.candidates.length,
          clientCandidateStageCounts: diagnostics!.counts,
          clientWithdrawalStatus: detail.status,
          feeAmount: detail.feeAmount,
          recordOccurredAt: record.occurredAt,
          noNewWithdrawalCreated: true
        });
        context.setActual('Client新增候选数=1，列表TXN与“法币转出 详情”TXN一致');
        return record;
      }
    );

    const submittedBalance = await business.step(
      {
        action: '7. 读取Client申请创建后、Admin拒绝前余额',
        expected: '记录真实可观测余额及before-submitted差值，不预设冻结公式'
      },
      async ({ setActual, setBusinessData }) => {
        await accountPage.goto(env.client.baseUrl!);
        const balance = await accountPage.readAvailableBalance(config.accountType, config.currency);
        const observedHoldAmount = beforeBalance.minus(balance.availableBalance);
        setBusinessData({
          submittedAvailableBalance: balance.availableBalance.toString(),
          submittedTotalBalance: '页面未提供',
          frozenAmount: observedHoldAmount.toString()
        });
        setActual('已记录提交后可用余额和可观测差值；未假定冻结等于申请金额或申请金额加手续费');
        return balance.availableBalance;
      }
    );

    const fingerprint: WithdrawalFingerprint = {
      ...prospectiveFingerprint,
      clientSubmittedAtMs: clientRecord.occurredAtMs
    };

    let adminCandidate: AdminWithdrawalCandidate | undefined;
    let adminDetailPage: WithdrawalDetailPage | undefined;
    await business.step(
      {
        action: '8. Admin按完整业务指纹定位唯一待处理申请',
        expected: '用户、香港账户、USD、精确金额、收款人、待处理状态和时间窗口候选数严格等于1'
      },
      async context => {
        let diagnostics;
        await expect.poll(async () => {
          await adminList.goto(env.admin.baseUrl!);
          await adminList.selectStatus('待处理');
          await adminList.searchCustomerEmail(config.adminUserIdentity);
          diagnostics = await adminList.diagnoseCandidates(
            fingerprint,
            config.matchWindowMs,
            { maxPages: 20 }
          );
          return diagnostics.candidates.length;
        }, {
          message: 'Admin Withdrawal candidateCount did not become exactly 1.',
          timeout: 60_000
        }).toBe(1);
        adminCandidate = requireUniqueAdminWithdrawalCandidate(diagnostics!.candidates);
        guard.recordUniqueAdminCandidate(diagnostics!.candidates.length);
        context.recordPrimaryOracle({
          id: 'WD002-P2',
          name: 'Admin候选唯一',
          expected: 'candidateCount=1',
          actual: `candidateCount=${diagnostics!.candidates.length}`,
          status: 'passed'
        });
        context.setBusinessData({
          candidateCount: diagnostics!.candidates.length,
          candidateStageCounts: diagnostics!.counts,
          fingerprintFields: [
            '测试用户', '香港账户', 'USD', 'Decimal精确金额', '收款人', '待处理状态', '提交时间窗口'
          ]
        });
        context.setActual('Admin完整业务指纹候选数严格等于1，未按第一条或最新一条选择');
      }
    );

    await business.step(
      {
        action: '9. 打开Admin唯一候选详情并二次核对',
        expected: 'Admin可见的客户、账户、币种、金额、收款人、用途、时间和状态与本次申请一致'
      },
      async ({
        setActual,
        setBusinessData,
        recordPrimaryOracle,
        recordSecondaryOracle,
        warn
      }) => {
        const liveCandidate = await adminList.locateFingerprintCandidate(
          fingerprint,
          config.matchWindowMs,
          20
        );
        adminDetailPage = await adminList.openDetail(liveCandidate);
        const detail = await adminDetailPage.readDetail();
        expect(matchesDepositCustomerIdentity(detail.customerText, config.adminUserIdentity)).toBe(true);
        expect(detail.accountType).toBe(config.accountType);
        expect(new Decimal(detail.requestedAmount).equals(amount)).toBe(true);
        expect(detail.beneficiaryText).toContain(config.beneficiaryName);
        expect(detail.purpose).toBe(config.purpose);
        expect(detail.status).toBe('待处理');
        expect(detail.submittedAt).toContain(liveCandidate.submittedAtText);
        expect(detail.feeAmount).toBe(liveCandidate.feeAmount);
        const accountSuffixVisible = await adminDetailPage.containsBeneficiaryAccountSuffix(
          config.beneficiaryAccountSuffix
        );
        const beneficiaryBank = await adminDetailPage.readBeneficiaryBankIfPresent();
        const rejection = adminDetailPage.rejectionReview();
        await rejection.waitForReady();
        recordPrimaryOracle({
          id: 'WD002-P3',
          name: 'Admin详情二次核对',
          expected: '本次申请全部核心字段一致且拒绝入口可用',
          actual: 'Admin可见的客户、账户、币种、金额、收款人、用途、时间和状态全部一致',
          status: 'passed'
        });
        const adminShowsBankIdentity = accountSuffixVisible && Boolean(beneficiaryBank);
        recordSecondaryOracle({
          id: 'WD002-S0',
          name: 'Admin详情展示收款银行与账户尾号',
          expected: '可在Admin详情二次核对银行和账号尾号',
          actual: adminShowsBankIdentity
            ? '银行和账号尾号均可见'
            : '真实Admin详情未展示银行和/或账号尾号；Client提交前已按配置尾号选择收款账户',
          status: adminShowsBankIdentity ? 'passed' : 'failed'
        });
        if (!adminShowsBankIdentity) {
          warn('Admin出金详情未展示收款银行或账号尾号；本次依赖Client已保存收款账户校验和完整业务指纹唯一性。');
        }
        setBusinessData({
          detailVerified: true,
          rejectActionAvailable: true,
          adminTransactionId: detail.adminTransactionId ?? '页面未提供独立Admin编号',
          adminWithdrawalStatus: detail.status
        });
        setActual('Admin可见核心字段全部匹配；审批备注和唯一拒绝按钮可用；未展示的银行/尾号已单独登记');
      }
    );

    const rejectionReview = adminDetailPage!.rejectionReview();
    await business.step(
      {
        action: '10. Admin单次拒绝唯一出金申请',
        expected: '填写AUTO_WITHDRAW_REJECT_<runId>备注并仅点击最终拒绝一次'
      },
      async context => {
        guard.assertAdminMutationAllowed(
          env.exchange.allowMoneyTests,
          env.allowAdminMutationTests
        );
        await rejectionReview.fillReason(rejectReason);
        adminRejectClicked = true;
        context.disallowSafeRerun();
        await rejectionReview.confirmRejectOnce(
          env.exchange.allowMoneyTests,
          env.allowAdminMutationTests
        );
        expect(rejectionReview.confirmationClickCount()).toBe(1);
        context.setBusinessData({
          rejectConfirmationClicks: 1,
          mutationPerformed: true
        });
        context.setActual('Admin最终拒绝点击1次；没有批准，也不会再次点击拒绝');
      }
    );

    let rejectedAdminRecord: AdminWithdrawalCandidate | undefined;
    await business.step(
      {
        action: '11. 等待Admin原申请进入拒绝终态',
        expected: '按同一业务指纹忽略状态后仍唯一，状态明确为拒绝终态'
      },
      async context => {
        let matching: AdminWithdrawalCandidate[] = [];
        try {
          await expect.poll(async () => {
            await adminList.goto(env.admin.baseUrl!);
            await adminList.searchCustomerEmail(config.adminUserIdentity);
            matching = matchAdminWithdrawalRecordsIgnoringStatus(
              await adminList.readAllFilteredRecords(),
              fingerprint,
              config.matchWindowMs
            );
            if (matching.length !== 1) return `candidateCount=${matching.length}`;
            return matching[0].status;
          }, {
            message: 'Admin Withdrawal status did not reach a readable rejected terminal state.',
            timeout: 60_000
          }).toMatch(REJECTED_STATUS);
        } catch (error) {
          context.requireManualReview('Admin出金审批 / Client原TXN / 香港账户USD余额');
          context.setBusinessData({
            adminWithdrawalStatus: matching.length === 1 ? matching[0].status : '结果不明确',
            finalStatus: 'Admin已点击拒绝，但状态结果不明确；禁止再次拒绝或重跑'
          });
          throw error;
        }
        rejectedAdminRecord = matching[0];
        context.recordPrimaryOracle({
          id: 'WD002-P4',
          name: 'Admin拒绝成功且仅执行一次',
          expected: '原候选进入拒绝终态，确认点击次数=1',
          actual: `${rejectedAdminRecord.status}；点击次数=1`,
          status: 'passed'
        });
        context.setBusinessData({ adminWithdrawalStatus: rejectedAdminRecord.status });
        context.setActual(`Admin原申请最终状态=${rejectedAdminRecord.status}`);
      }
    );

    let rejectedClientRecord: WithdrawalTransactionRecord | undefined;
    await business.step(
      {
        action: '12. Client按原TXN等待拒绝终态',
        expected: '同一TXN编号进入拒绝终态，不按最新一条定位且不创建新申请'
      },
      async context => {
        try {
          await expect.poll(async () => {
            rejectedClientRecord = await readClientWithdrawalById(
              historyPage,
              env.client.baseUrl!,
              clientRecord.clientWithdrawalId
            );
            return rejectedClientRecord?.status ?? 'missing';
          }, {
            message: 'Client original Withdrawal TXN did not reach a rejected terminal state.',
            timeout: 60_000
          }).toMatch(REJECTED_STATUS);
        } catch (error) {
          context.requireManualReview('Client原TXN与Admin拒绝状态不一致');
          context.setBusinessData({
            clientWithdrawalStatus: rejectedClientRecord?.status ?? 'missing',
            finalStatus: 'Admin已拒绝，但Client原TXN终态不明确；禁止重跑'
          });
          throw error;
        }
        expect(rejectedClientRecord?.clientWithdrawalId).toBe(clientRecord.clientWithdrawalId);
        expect(rejectedClientRecord?.accountType).toBe(config.accountType);
        expect(rejectedClientRecord?.currency).toBe(config.currency);
        expect(new Decimal(rejectedClientRecord!.requestedAmount).equals(amount)).toBe(true);
        context.recordPrimaryOracle({
          id: 'WD002-P5',
          name: 'Client原TXN进入拒绝终态',
          expected: '原TXN不变且状态为拒绝',
          actual: rejectedClientRecord!.status,
          status: 'passed'
        });
        context.setBusinessData({
          clientWithdrawalStatus: rejectedClientRecord!.status,
          terminalState: true
        });
        context.setActual('Client按原TXN读取到拒绝终态，未使用最新记录定位');
      }
    );

    await business.step(
      {
        action: '13. 核对拒绝后香港账户USD余额与释放金额',
        expected: '最终可用余额严格等于提交前余额，差值按Decimal计算'
      },
      async context => {
        await accountPage.goto(env.client.baseUrl!);
        const balance = await accountPage.readAvailableBalance(config.accountType, config.currency);
        const releasedAmount = balance.availableBalance.minus(submittedBalance);
        const balanceMatches = balance.availableBalance.equals(beforeBalance);
        context.recordPrimaryOracle({
          id: 'WD002-P6',
          name: '拒绝后香港账户USD余额恢复',
          expected: beforeBalance.toString(),
          actual: balance.availableBalance.toString(),
          status: balanceMatches ? 'passed' : 'failed'
        });
        context.setBusinessData({
          afterRejectedAvailableBalance: balance.availableBalance.toString(),
          afterRejectedTotalBalance: '页面未提供',
          releasedAmount: releasedAmount.toString()
        });
        context.setActual(
          balanceMatches
            ? '拒绝后可用余额与提交前基线完全一致，没有永久扣减'
            : '拒绝后可用余额与提交前基线不一致，余额Primary Oracle失败'
        );
        expect(balanceMatches).toBe(true);
      }
    );

    await business.step(
      {
        action: '14. 验证本次执行没有创建第二条出金申请',
        expected: '排除执行前TXN后，本次业务指纹记录总数严格等于1'
      },
      async context => {
        await historyPage.goto(env.client.baseUrl!);
        const diagnostics = await historyPage.diagnose({
          accountType: config.accountType,
          currency: config.currency,
          requestedAmount: displayedAmount,
          beneficiaryAccountSuffix: config.beneficiaryAccountSuffix,
          occurredFromMs: clientSubmittedAtMs - config.matchWindowMs,
          occurredToMs: Date.now() + config.matchWindowMs,
          excludedLedgerTransactionIds: previousClientIds
        });
        const exactlyOne = diagnostics.candidates.length === 1;
        context.recordPrimaryOracle({
          id: 'WD002-P7',
          name: '没有创建第二条Withdrawal',
          expected: '本次业务指纹记录数=1',
          actual: `记录数=${diagnostics.candidates.length}`,
          status: exactlyOne ? 'passed' : 'failed'
        });
        if (!exactlyOne) context.markDuplicateSubmissionRisk();
        context.setBusinessData({ noNewWithdrawalCreated: exactlyOne });
        context.setActual(exactlyOne ? '本次仅存在原TXN一条申请' : '检测到申请数量异常');
        expect(exactlyOne).toBe(true);
      }
    );

    await business.step(
      {
        action: '15. 检查Client详情是否展示本次拒绝原因',
        expected: '如页面展示拒绝原因则与runId对应；页面不展示仅记录为非阻塞辅助结果'
      },
      async context => {
        await historyPage.goto(env.client.baseUrl!);
        await historyPage.transactions.searchByBusinessId(clientRecord.clientWithdrawalId);
        const exactRecord = await historyPage.recordById(clientRecord.clientWithdrawalId);
        expect(exactRecord).toBeTruthy();
        const drawer = await historyPage.openDetail(exactRecord!);
        const visibleText = await drawer.readFiatWithdrawalVisibleText();
        const reasonDisplayed = visibleText.includes(rejectReason) || visibleText.includes(runId);
        context.recordSecondaryOracle({
          id: 'WD002-S1',
          name: 'Client展示Admin拒绝原因',
          expected: '若产品展示原因，则与本次runId对应',
          actual: reasonDisplayed ? '已展示且与本次runId对应' : '页面未展示拒绝原因',
          status: 'passed'
        });
        context.setBusinessData({
          rejectReasonDisplayed: reasonDisplayed,
          finalStatus: rejectedClientRecord!.status,
          confirmed: true,
          noNewWithdrawalCreated: true
        });
        context.setActual(
          reasonDisplayed
            ? 'Client详情展示的拒绝原因与本次runId对应'
            : 'Client详情未展示拒绝原因；按产品实际能力记录，不影响核心拒绝闭环'
        );
      }
    );

    expect(clientFinalSubmitClicked).toBe(true);
    expect(adminRejectClicked).toBe(true);
    expect(withdrawalPage.confirmationClicks()).toBe(1);
    expect(withdrawalPage.securityVerificationClicks()).toBe(1);
    expect(rejectionReview.confirmationClickCount()).toBe(1);
    expect(rejectedAdminRecord).toBeTruthy();
    expect(confirmation.snapshot.feeText).toBeTruthy();
    testInfo.annotations.push({
      type: 'no-auto-rerun',
      description: `runId=${runId}；原TXN创建后禁止自动重跑或创建第二笔出金`
    });
  }
);
