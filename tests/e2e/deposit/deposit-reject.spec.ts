import { DepositClaimDrawer } from '../../../pages/admin/DepositClaimDrawer';
import { DepositClaimListPage } from '../../../pages/admin/DepositClaimListPage';
import { DepositRejectDrawer } from '../../../pages/admin/DepositRejectDrawer';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { DepositHistoryPage, type ObservedClientDepositRecord } from '../../../pages/client/DepositHistoryPage';
import { DepositPage } from '../../../pages/client/DepositPage';
import { TransactionsPage } from '../../../pages/client/TransactionsPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { runDepositAuthPreflight } from '../../../src/deposit/deposit-auth-preflight';
import {
  buildDepositRejectReason,
  DepositExecutionGuard,
  deriveUniqueDepositAmount,
  diagnoseAdminDepositCandidates,
  matchAdminDepositCandidates,
  matchAdminDepositRecordsIgnoringStatus,
  matchesDepositCustomerIdentity,
  requireUniqueAdminDepositCandidate,
  type AdminDepositCandidate,
  type DepositFingerprint
} from '../../../src/deposit/deposit-e2e';
import { assertClientTestEnvironment } from '../../../src/utils/clientSafety';
import { Decimal } from '../../../src/utils/money';
import {
  getDepositReconciliationConfig,
  getDepositTestConfig
} from '../../client/deposit/depositTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });
test.skip(
  !env.exchange.allowMoneyTests || !env.allowAdminMutationTests,
  'DP-002真实拒绝闭环默认禁用；必须同时显式开启两个Mutation安全开关。'
);

function observedDepositCandidates(input: {
  records: readonly ObservedClientDepositRecord[];
  previousIds: ReadonlySet<string>;
  currency: string;
  amount: string;
  submittedAtMs: number;
  matchWindowMs: number;
}): ObservedClientDepositRecord[] {
  const expectedAmount = new Decimal(input.amount);
  return input.records.filter(record =>
    !input.previousIds.has(record.clientDepositId) &&
    record.currency?.toUpperCase() === input.currency.toUpperCase() &&
    record.requestedAmount !== undefined &&
    new Decimal(record.requestedAmount).equals(expectedAmount) &&
    record.submittedAtMs !== undefined &&
    record.submittedAtMs >= input.submittedAtMs - input.matchWindowMs &&
    record.submittedAtMs <= Date.now() + input.matchWindowMs
  );
}

test(
  'Client香港账户HKD入金并由Admin拒绝',
  {
    tag: ['@e2e', '@deposit', '@mutation', '@money'],
    annotation: [
      { type: 'caseId', description: 'DP-002' },
      { type: 'module', description: '入金' },
      { type: 'priority', description: 'P0' },
      { type: 'scope', description: 'Client + Admin' },
      { type: 'type', description: 'E2E / Mutation / Money' }
    ]
  },
  async ({ adminPage, clientPage, business }, testInfo) => {
    test.setTimeout(180_000);
    if (!env.client.baseUrl || !env.admin.baseUrl) {
      throw new Error('CLIENT_BASE_URL and ADMIN_BASE_URL are required for DP-002.');
    }

    assertClientTestEnvironment(env.client.baseUrl);
    expect(new URL(env.admin.baseUrl).hostname.toLocaleLowerCase()).toContain('sandbox');
    expect(testInfo.config.workers).toBe(1);
    expect(testInfo.project.retries).toBe(0);
    expect(testInfo.project.repeatEach).toBe(1);
    expect(testInfo.retry).toBe(0);
    expect(testInfo.repeatEachIndex).toBe(0);

    const config = getDepositTestConfig();
    const pendingAdminStatus = getDepositReconciliationConfig().adminStatus;
    const runStartedAtMs = Date.now();
    const runId = `DP002-${new Date(runStartedAtMs).toISOString().replace(/\D/g, '').slice(0, 14)}`;
    const amount = deriveUniqueDepositAmount(
      runId,
      config.uniqueAmountBase,
      config.amountPrecision
    );
    const displayedAmount = amount.toFixed(config.amountPrecision);
    const reference = `AUTO_${runId}`;
    const rejectReason = buildDepositRejectReason(runId);
    const guard = new DepositExecutionGuard();
    const accountPage = new AccountDetailPage(clientPage);
    const depositPage = new DepositPage(clientPage);
    const historyPage = new DepositHistoryPage(clientPage);
    const transactionsPage = new TransactionsPage(clientPage);
    const adminList = new DepositClaimListPage(adminPage);
    const claimDrawer = new DepositClaimDrawer(adminPage);
    const rejectDrawer = new DepositRejectDrawer(adminPage);
    let clientSubmissionClicked = false;
    let adminRejectClicked = false;

    business.case({
      caseId: 'DP-002',
      module: 'Client + Admin入金',
      name: '香港账户HKD入金审核拒绝闭环',
      description: 'Client单次创建唯一11.xx HKD银行电汇入金，Admin唯一定位并拒绝，Client按原TXN验证拒绝终态和余额不变。',
      priority: 'P0',
      type: ['E2E', 'Mutation', 'Money'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'Deposit rejection end-to-end',
      preconditions: [
        'Client与Admin认证有效',
        'Fidere Sandbox',
        '两个Mutation安全开关开启',
        'workers=1且retries=0'
      ],
      target: '拒绝本次唯一TXN入金申请并验证香港账户HKD余额保持不变。',
      expectedResult: '原TXN存在，Admin候选数为1并拒绝成功，Client原TXN进入拒绝终态，HKD余额不变。',
      changesData: true,
      affectsMoney: true,
      dependsOnAdmin: true,
      dependsOnThirdParty: false,
      safetySwitches: ['ALLOW_MONEY_TESTS', 'ALLOW_ADMIN_MUTATION_TESTS']
    });
    business.setBusinessData({
      runId,
      accountType: config.accountType,
      depositCurrency: config.currency,
      depositAmount: displayedAmount,
      depositChannel: config.channel,
      depositPurpose: config.purpose,
      depositSourceOfFunds: config.sourceOfFunds,
      rejectReason,
      candidateCount: 0,
      confirmationClicks: 0,
      rejectConfirmationClicks: 0,
      confirmed: false
    });

    await business.step(
      {
        action: '1. 执行Sandbox、双端认证和运行器安全预检',
        expected: 'Client/Admin业务页可访问，两个安全开关开启，单worker、零重试且未重复执行'
      },
      async ({ setActual }) => {
        await runDepositAuthPreflight({
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
        setActual('Sandbox与双端认证有效；两个Mutation开关仅在本进程开启，运行器约束全部满足');
      }
    );

    const balanceBefore = await business.step(
      {
        action: '2. 读取香港账户HKD提交前余额',
        expected: '按账户和币种唯一读取可用余额，作为拒绝后Primary Oracle基线'
      },
      async ({ setActual, setBusinessData }) => {
        await accountPage.goto(env.client.baseUrl!);
        const balance = await accountPage.readAvailableBalance(config.accountType, config.currency);
        setBusinessData({ depositBalanceBefore: balance.availableBalance.toString() });
        setActual('已读取香港账户HKD提交前可用余额');
        return balance.availableBalance;
      }
    );

    await business.step(
      {
        action: '3. 检查本次唯一金额不存在冲突待处理申请',
        expected: '同用户、账户、HKD、11.xx金额、渠道和当前时间窗口候选数为0'
      },
      async ({ setActual, setBusinessData }) => {
        await adminList.goto(env.admin.baseUrl!);
        await adminList.applyFilters({ status: pendingAdminStatus, matchStatus: '已匹配' });
        const records = await adminList.readAllFilteredRecords();
        const prospectiveFingerprint: DepositFingerprint = {
          runId,
          userIdentity: config.adminUserIdentity,
          accountType: config.accountType,
          currency: config.currency,
          requestedAmount: displayedAmount,
          clientSubmittedAtMs: runStartedAtMs,
          adminStatus: pendingAdminStatus,
          channel: config.channel
        };
        const conflicts = matchAdminDepositCandidates(
          records,
          prospectiveFingerprint,
          config.matchWindowMs
        );
        expect(conflicts).toHaveLength(0);
        setBusinessData({ candidateCount: 0, amountPrecision: config.amountPrecision });
        setActual('提交前Admin冲突候选数为0；本次金额符合11.xx和两位小数规则');
      }
    );

    await historyPage.installSafeRecordObserver();
    await depositPage.goto(env.client.baseUrl!);
    const previousIds = new Set(
      (await historyPage.readObservedRecords()).map(record => record.clientDepositId)
    );

    await business.step(
      {
        action: '4. 填写并核对银行电汇入金申请',
        expected: '香港账户、HKD、唯一11.xx金额、银行、渠道、用途、资金来源和runId参考号完整'
      },
      async ({ setActual }) => {
        await depositPage.selectAccount(config.accountType);
        await depositPage.selectCurrency(config.currencyLabel);
        await depositPage.selectFirstPayingBank();
        await depositPage.fillAmount(displayedAmount);
        await depositPage.selectChannel(config.channel);
        await depositPage.selectPurpose(config.purpose);
        await depositPage.selectSourceOfFunds(config.sourceOfFunds);
        await depositPage.fillReference(reference);
        const snapshot = await depositPage.readFormSnapshot();
        expect(snapshot.accountType).toContain(config.accountType);
        expect(snapshot.currencyLabel).toContain(config.currencyLabel);
        expect(new Decimal(snapshot.amount).equals(amount)).toBe(true);
        expect(snapshot.channel).toContain(config.channel);
        expect(snapshot.purpose).toContain(config.purpose);
        expect(snapshot.sourceOfFunds).toContain(config.sourceOfFunds);
        expect(snapshot.submitEnabled).toBe(true);
        setActual('Client入金表单与本次业务数据一致，最终提交按钮已具备单次执行条件');
      }
    );

    const submission = await business.step(
      {
        action: '5. 单次提交Client入金申请',
        expected: '提交按钮仅点击一次，confirm-deposit成功且页面显示成功'
      },
      async context => {
        guard.assertClientSubmissionAllowed(
          env.exchange.allowMoneyTests,
          env.allowAdminMutationTests
        );
        context.markPotentiallySubmitted();
        context.disallowSafeRerun();
        clientSubmissionClicked = true;
        const result = await depositPage.submitOnce();
        expect(depositPage.submissionClicks()).toBe(1);
        context.setBusinessData({
          confirmationClicks: depositPage.submissionClicks(),
          networkObservations: [{ path: result.requestPath, status: result.httpStatus }]
        });
        context.setActual(`Client提交点击1次；${result.requestPath}返回HTTP ${result.httpStatus}`);
        return result;
      }
    );

    const clientRecord = await business.step(
      {
        action: '6. 从Client原始入金记录读取新增TXN',
        expected: '按新ID、HKD、精确金额和本次时间窗口得到唯一TXN申请'
      },
      async context => {
        let candidates: ObservedClientDepositRecord[] = [];
        await expect.poll(async () => {
          await depositPage.goto(env.client.baseUrl!);
          candidates = observedDepositCandidates({
            records: await historyPage.readObservedRecords(),
            previousIds,
            currency: config.currency,
            amount: displayedAmount,
            submittedAtMs: submission.submittedAtMs,
            matchWindowMs: config.matchWindowMs
          });
          return candidates.length;
        }, {
          message: 'Client Deposit did not expose exactly one new TXN record.',
          timeout: 30_000
        }).toBe(1);
        const record = candidates[0];
        guard.recordClientSubmission(record.clientDepositId);
        expect(record.status).toMatch(/pending|processing|待处理|处理中/i);
        context.recordPrimaryOracle({
          id: 'DP002-P1',
          name: 'Client原TXN申请存在',
          expected: '新增唯一TXN-*入金申请',
          actual: `已读取${record.clientDepositId}`,
          status: 'passed'
        });
        context.setBusinessData({
          depositOrderId: record.clientDepositId,
          clientDepositStatus: record.status,
          clientDepositHistoryCandidateCount: candidates.length
        });
        context.setActual('Client新增记录候选数为1，已读取并保存原TXN编号');
        return record;
      }
    );

    const clientSubmittedAtMs = clientRecord.submittedAtMs ?? submission.submittedAtMs;
    const fingerprint: DepositFingerprint = {
      runId,
      userIdentity: config.adminUserIdentity,
      accountType: config.accountType,
      currency: config.currency,
      requestedAmount: displayedAmount,
      clientSubmittedAtMs,
      adminStatus: pendingAdminStatus,
      channel: config.channel
    };

    let adminCandidate: AdminDepositCandidate | undefined;
    await business.step(
      {
        action: '7. Admin按业务指纹唯一定位本次入金',
        expected: '用户、账户、HKD、精确金额、渠道、状态和时间窗口候选数严格等于1'
      },
      async context => {
        let candidates: AdminDepositCandidate[] = [];
        let records: AdminDepositCandidate[] = [];
        await expect.poll(async () => {
          await adminList.goto(env.admin.baseUrl!);
          await adminList.applyFilters({ status: pendingAdminStatus, matchStatus: '已匹配' });
          records = await adminList.readAllFilteredRecords();
          candidates = matchAdminDepositCandidates(records, fingerprint, config.matchWindowMs);
          return candidates.length;
        }, {
          message: 'Admin Deposit candidateCount did not become exactly 1.',
          timeout: 45_000
        }).toBe(1);
        const diagnostics = diagnoseAdminDepositCandidates(records, fingerprint, config.matchWindowMs);
        adminCandidate = requireUniqueAdminDepositCandidate(candidates);
        guard.recordUniqueAdminCandidate(candidates.length);
        context.recordPrimaryOracle({
          id: 'DP002-P2',
          name: 'Admin候选唯一',
          expected: 'candidateCount=1',
          actual: `candidateCount=${candidates.length}`,
          status: 'passed'
        });
        context.setBusinessData({
          candidateCount: candidates.length,
          candidateStageCounts: diagnostics.counts,
          adminDepositStatus: adminCandidate.status,
          adminReference: adminCandidate.reference,
          fingerprintFields: [
            '测试用户', '账户类型', '币种', '精确金额', '渠道', '待处理状态', '提交时间窗口'
          ]
        });
        context.setActual('Admin业务指纹候选数严格等于1，未按第一条或最新一条选择');
      }
    );
    const uniqueAdminCandidate = adminCandidate!;

    await business.step(
      {
        action: '8. 打开Admin详情并二次核对唯一申请',
        expected: '客户、香港账户、HKD金额、渠道、Admin参考号和创建时间与本次TXN一致'
      },
      async ({ setActual, setBusinessData }) => {
        await claimDrawer.open(adminList, uniqueAdminCandidate);
        const detail = await claimDrawer.readDetail();
        expect(detail.accountType).toContain(config.accountType);
        expect(new Decimal(detail.originalAmount).equals(amount)).toBe(true);
        expect(detail.channel).toContain(config.channel);
        expect(detail.reference).toBe(uniqueAdminCandidate.reference);
        expect(matchesDepositCustomerIdentity(detail.matchedCustomerText, config.adminUserIdentity)).toBe(true);
        expect(detail.submittedAtText).toContain(uniqueAdminCandidate.submittedAtText);
        setBusinessData({ detailVerified: true, actualDepositAmount: detail.claimAmount });
        setActual('Admin详情中的客户、账户、金额、渠道、Admin参考号和时间均与本次申请一致');
        await claimDrawer.closeWithoutConfirming();
      }
    );

    await business.step(
      {
        action: '9. Admin单次拒绝唯一入金申请',
        expected: '填写本次runId拒绝原因，确认拒绝只点击一次'
      },
      async context => {
        guard.assertAdminMutationAllowed(
          env.exchange.allowMoneyTests,
          env.allowAdminMutationTests
        );
        await rejectDrawer.open(adminList, uniqueAdminCandidate);
        adminRejectClicked = true;
        await rejectDrawer.confirmRejectOnce(rejectReason);
        expect(rejectDrawer.confirmationClickCount()).toBe(1);
        context.disallowSafeRerun();
        context.setBusinessData({ rejectConfirmationClicks: 1 });
        context.setActual('Admin确认拒绝点击1次；未执行认领或其他处理');
      }
    );

    let rejectedAdminRecord: AdminDepositCandidate | undefined;
    await business.step(
      {
        action: '10. 等待Admin申请进入拒绝终态',
        expected: '原业务指纹仍唯一，状态明确为处理失败或拒绝'
      },
      async context => {
        let matching: AdminDepositCandidate[] = [];
        await expect.poll(async () => {
          await adminList.goto(env.admin.baseUrl!);
          matching = matchAdminDepositRecordsIgnoringStatus(
            await adminList.readAllFilteredRecords(),
            fingerprint,
            config.matchWindowMs
          );
          if (matching.length !== 1) return `candidateCount=${matching.length}`;
          return matching[0].status;
        }, {
          message: 'Admin Deposit status did not reach a readable rejected terminal state.',
          timeout: 60_000
        }).toMatch(/处理失败|已拒绝|拒绝|failed|rejected/i);
        rejectedAdminRecord = matching[0];
        context.recordPrimaryOracle({
          id: 'DP002-P3',
          name: 'Admin拒绝成功',
          expected: '原候选进入拒绝终态',
          actual: rejectedAdminRecord.status,
          status: 'passed'
        });
        context.setBusinessData({ adminDepositStatus: rejectedAdminRecord.status });
        context.setActual(`Admin原申请最终状态=${rejectedAdminRecord.status}`);
      }
    );

    let rejectedClientRecord: ObservedClientDepositRecord | undefined;
    await business.step(
      {
        action: '11. Client按原TXN等待拒绝终态',
        expected: '同一TXN编号进入failed/rejected终态，不创建第二条申请'
      },
      async context => {
        await expect.poll(async () => {
          await depositPage.goto(env.client.baseUrl!);
          rejectedClientRecord = await historyPage.observedRecordById(clientRecord.clientDepositId);
          return rejectedClientRecord?.status ?? 'missing';
        }, {
          message: 'Client original Deposit TXN did not reach a rejected terminal state.',
          timeout: 60_000
        }).toMatch(/failed|rejected|已拒绝|拒绝|处理失败/i);
        expect(rejectedClientRecord?.clientDepositId).toBe(clientRecord.clientDepositId);
        context.recordPrimaryOracle({
          id: 'DP002-P4',
          name: 'Client原TXN进入拒绝终态',
          expected: '原TXN不变且状态为拒绝',
          actual: rejectedClientRecord?.status ?? 'missing',
          status: 'passed'
        });
        context.setBusinessData({
          clientDepositStatus: rejectedClientRecord?.status,
          terminalState: true
        });
        context.setActual('Client按原TXN读取到拒绝终态，未通过最新一条记录定位');
      }
    );

    await business.step(
      {
        action: '12. 核对拒绝后香港账户HKD余额',
        expected: '最终可用余额严格等于提交前余额'
      },
      async context => {
        await accountPage.goto(env.client.baseUrl!);
        const balanceAfter = await accountPage.readAvailableBalance(config.accountType, config.currency);
        const balanceMatches = balanceAfter.availableBalance.equals(balanceBefore);
        expect(balanceMatches).toBe(true);
        context.recordPrimaryOracle({
          id: 'DP002-P5',
          name: '拒绝后香港账户HKD余额不变',
          expected: balanceBefore.toString(),
          actual: balanceAfter.availableBalance.toString(),
          status: 'passed'
        });
        context.setBusinessData({
          depositBalanceAfter: balanceAfter.availableBalance.toString(),
          confirmed: true,
          finalStatus: rejectedClientRecord?.status
        });
        context.setActual('香港账户HKD最终余额与提交前基线完全一致');
      }
    );

    await business.step(
      {
        action: '13. 执行全局交易流水Secondary Oracle',
        expected: '若全局流水展示原TXN则记录；缺失只产生警告，不影响已确认的拒绝闭环'
      },
      async context => {
        await transactionsPage.goto(env.client.baseUrl!);
        await transactionsPage.searchByBusinessId(clientRecord.clientDepositId);
        const recordVisible = await transactionsPage.businessRow(clientRecord.clientDepositId).count() === 1;
        context.recordSecondaryOracle({
          id: 'DP002-S1',
          name: 'Client全局交易流水展示入金TXN',
          expected: '可按原TXN读取全局流水',
          actual: recordVisible ? '已找到' : '未找到',
          status: recordVisible ? 'passed' : 'failed'
        });
        if (!recordVisible) {
          context.warn('入金拒绝闭环已确认完成，但Client全局交易流水未展示对应TXN。');
          context.setActual('全局流水未找到原TXN，已登记为Secondary Oracle警告');
        } else {
          context.setActual('全局流水可按原TXN读取');
        }
      }
    );

    expect(clientSubmissionClicked).toBe(true);
    expect(adminRejectClicked).toBe(true);
    expect(depositPage.submissionClicks()).toBe(1);
    expect(rejectDrawer.confirmationClickCount()).toBe(1);
    expect(rejectedAdminRecord).toBeTruthy();
    testInfo.annotations.push({
      type: 'no-auto-rerun',
      description: `runId=${runId}；原TXN创建后禁止自动重跑或创建第二笔入金`
    });
  }
);
