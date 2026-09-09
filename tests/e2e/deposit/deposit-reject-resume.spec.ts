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
  'DP-002 Resume默认禁用；必须同时显式开启两个Mutation安全开关。'
);

function requiredResumeValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for DP-002 Resume.`);
  return value;
}

function findExistingClientRecord(input: {
  records: readonly ObservedClientDepositRecord[];
  currency: string;
  amount: Decimal;
  submittedAtMs: number;
  matchWindowMs: number;
}): ObservedClientDepositRecord[] {
  return input.records.filter(record =>
    record.currency?.toUpperCase() === input.currency.toUpperCase() &&
    record.requestedAmount !== undefined &&
    new Decimal(record.requestedAmount).equals(input.amount) &&
    record.submittedAtMs !== undefined &&
    record.submittedAtMs >= input.submittedAtMs - input.matchWindowMs &&
    record.submittedAtMs <= input.submittedAtMs + input.matchWindowMs
  );
}

test(
  '续跑现有DP-002并完成Admin拒绝与Client终态验证',
  {
    tag: ['@e2e', '@deposit', '@mutation', '@money', '@resume'],
    annotation: [
      { type: 'caseId', description: 'DP-002' },
      { type: 'module', description: '入金' },
      { type: 'priority', description: 'P0' },
      { type: 'scope', description: 'Client + Admin' },
      { type: 'type', description: 'E2E / Mutation / Money / Resume' }
    ]
  },
  async ({ adminPage, clientPage, business }, testInfo) => {
    test.setTimeout(180_000);
    if (!env.client.baseUrl || !env.admin.baseUrl) {
      throw new Error('CLIENT_BASE_URL and ADMIN_BASE_URL are required for DP-002 Resume.');
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
    const runId = requiredResumeValue('DEPOSIT_RESUME_RUN_ID');
    const amount = new Decimal(requiredResumeValue('DEPOSIT_RESUME_AMOUNT'));
    const baselineBalance = new Decimal(requiredResumeValue('DEPOSIT_RESUME_BALANCE_BEFORE'));
    const submittedAtMs = Date.parse(requiredResumeValue('DEPOSIT_RESUME_SUBMITTED_AT'));
    if (!amount.isFinite() || !amount.isPositive() || !baselineBalance.isFinite() || !Number.isFinite(submittedAtMs)) {
      throw new Error('DP-002 Resume amount, balance, or submitted timestamp is invalid.');
    }
    const rejectReason = buildDepositRejectReason(runId);
    const guard = new DepositExecutionGuard();
    const accountPage = new AccountDetailPage(clientPage);
    const depositPage = new DepositPage(clientPage);
    const historyPage = new DepositHistoryPage(clientPage);
    const transactionsPage = new TransactionsPage(clientPage);
    const adminList = new DepositClaimListPage(adminPage);
    const claimDrawer = new DepositClaimDrawer(adminPage);
    const rejectDrawer = new DepositRejectDrawer(adminPage);

    business.case({
      caseId: 'DP-002',
      module: 'Client + Admin入金',
      name: '续跑现有香港账户HKD入金审核拒绝闭环',
      description: '不创建第二条申请，仅恢复原Client TXN、唯一定位Admin候选、单次拒绝并验证原TXN终态和HKD余额。',
      priority: 'P0',
      type: ['E2E', 'Mutation', 'Money', 'Resume'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'Resume existing DP-002 without creating another Deposit',
      preconditions: ['现有Client入金申请已提交', 'Client/Admin认证有效', 'Sandbox', '两个安全开关开启'],
      target: '只拒绝现有唯一入金申请，不再次执行Client提交。',
      expectedResult: 'Admin拒绝一次，Client原TXN进入拒绝终态，香港账户HKD余额保持原基线。',
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
      depositAmount: amount.toFixed(config.amountPrecision),
      depositBalanceBefore: baselineBalance.toString(),
      rejectReason,
      candidateCount: 0,
      confirmationClicks: 0,
      rejectConfirmationClicks: 0,
      confirmed: false
    });

    await business.step(
      { action: '1. 执行双端认证与Resume安全门禁', expected: '双端认证有效；进入现有记录查询，不打开Client提交表单' },
      async ({ setActual }) => {
        await runDepositAuthPreflight({
          clientPage,
          adminPage,
          clientBaseUrl: env.client.baseUrl!,
          adminBaseUrl: env.admin.baseUrl!,
          guard
        });
        setActual('Sandbox与双端认证有效；本用例仅续跑现有申请');
      }
    );

    const clientRecord = await business.step(
      { action: '2. 唯一恢复Client原TXN', expected: '按HKD、11.xx金额和原提交时间窗口得到唯一现有TXN' },
      async context => {
        await historyPage.installSafeRecordObserver();
        await depositPage.goto(env.client.baseUrl!);
        const candidates = findExistingClientRecord({
          records: await historyPage.readObservedRecords(),
          currency: config.currency,
          amount,
          submittedAtMs,
          matchWindowMs: config.matchWindowMs
        });
        expect(candidates).toHaveLength(1);
        const record = candidates[0];
        expect(record.status).toMatch(/pending|processing|待处理|处理中/i);
        guard.recordClientSubmission(record.clientDepositId);
        expect(depositPage.submissionClicks()).toBe(0);
        context.recordPrimaryOracle({
          id: 'DP002-P1',
          name: 'Client原TXN申请存在',
          expected: '唯一现有TXN-*申请',
          actual: record.clientDepositId,
          status: 'passed'
        });
        context.setBusinessData({
          depositOrderId: record.clientDepositId,
          clientDepositStatus: record.status,
          clientDepositHistoryCandidateCount: candidates.length
        });
        context.disallowSafeRerun();
        context.setActual('已唯一恢复原Client TXN；Client提交点击0次');
        return record;
      }
    );

    const fingerprint: DepositFingerprint = {
      runId,
      userIdentity: config.adminUserIdentity,
      accountType: config.accountType,
      currency: config.currency,
      requestedAmount: amount.toFixed(config.amountPrecision),
      clientSubmittedAtMs: clientRecord.submittedAtMs ?? submittedAtMs,
      adminStatus: pendingAdminStatus,
      channel: config.channel
    };

    const adminCandidate = await business.step(
      { action: '3. Admin唯一定位并二次核对原申请', expected: 'candidateCount=1，客户、账户、HKD、金额、渠道和时间一致' },
      async context => {
        await adminList.goto(env.admin.baseUrl!);
        await adminList.applyFilters({ status: pendingAdminStatus, matchStatus: '已匹配' });
        const candidates = matchAdminDepositCandidates(
          await adminList.readAllFilteredRecords(),
          fingerprint,
          config.matchWindowMs
        );
        const unique = requireUniqueAdminDepositCandidate(candidates);
        guard.recordUniqueAdminCandidate(candidates.length);
        await claimDrawer.open(adminList, unique);
        const detail = await claimDrawer.readDetail();
        expect(detail.accountType).toContain(config.accountType);
        expect(new Decimal(detail.originalAmount).equals(amount)).toBe(true);
        expect(detail.channel).toContain(config.channel);
        expect(detail.reference).toBe(unique.reference);
        expect(matchesDepositCustomerIdentity(detail.matchedCustomerText, config.adminUserIdentity)).toBe(true);
        expect(detail.submittedAtText).toContain(unique.submittedAtText);
        await claimDrawer.closeWithoutConfirming();
        context.recordPrimaryOracle({
          id: 'DP002-P2',
          name: 'Admin候选唯一且详情匹配',
          expected: 'candidateCount=1且详情一致',
          actual: 'candidateCount=1，详情全部一致',
          status: 'passed'
        });
        context.setBusinessData({ candidateCount: 1, detailVerified: true });
        context.setActual('Admin候选数严格等于1，详情二次核对全部通过');
        return unique;
      }
    );

    await business.step(
      { action: '4. 验证拒绝前HKD余额仍等于原基线', expected: '待处理入金未增加香港账户HKD可用余额' },
      async ({ setActual }) => {
        await accountPage.goto(env.client.baseUrl!);
        const current = await accountPage.readAvailableBalance(config.accountType, config.currency);
        expect(current.availableBalance.equals(baselineBalance)).toBe(true);
        setActual('拒绝前香港账户HKD余额仍等于原提交前基线');
      }
    );

    await business.step(
      { action: '5. Admin单次拒绝原申请', expected: '确认拒绝仅点击一次，不执行认领' },
      async context => {
        guard.assertAdminMutationAllowed(
          env.exchange.allowMoneyTests,
          env.allowAdminMutationTests
        );
        await adminList.goto(env.admin.baseUrl!);
        await adminList.applyFilters({ status: pendingAdminStatus, matchStatus: '已匹配' });
        const currentCandidates = matchAdminDepositCandidates(
          await adminList.readAllFilteredRecords(),
          fingerprint,
          config.matchWindowMs
        );
        const current = requireUniqueAdminDepositCandidate(currentCandidates);
        await rejectDrawer.open(adminList, current);
        context.markPotentiallySubmitted();
        context.disallowSafeRerun();
        await rejectDrawer.confirmRejectOnce(rejectReason);
        expect(rejectDrawer.confirmationClickCount()).toBe(1);
        context.setBusinessData({ rejectConfirmationClicks: 1 });
        context.setActual('Admin确认拒绝点击1次；Client提交点击仍为0');
      }
    );

    let rejectedAdminRecord: AdminDepositCandidate | undefined;
    await business.step(
      { action: '6. 等待Admin原申请进入拒绝终态', expected: '原业务指纹唯一且状态为处理失败或拒绝' },
      async context => {
        let matches: AdminDepositCandidate[] = [];
        await expect.poll(async () => {
          await adminList.goto(env.admin.baseUrl!);
          matches = matchAdminDepositRecordsIgnoringStatus(
            await adminList.readAllFilteredRecords(),
            fingerprint,
            config.matchWindowMs
          );
          return matches.length === 1 ? matches[0].status : `candidateCount=${matches.length}`;
        }, { timeout: 60_000 }).toMatch(/处理失败|已拒绝|拒绝|failed|rejected/i);
        rejectedAdminRecord = matches[0];
        context.recordPrimaryOracle({
          id: 'DP002-P3',
          name: 'Admin拒绝成功',
          expected: '原申请进入拒绝终态',
          actual: rejectedAdminRecord.status,
          status: 'passed'
        });
        context.setBusinessData({ adminDepositStatus: rejectedAdminRecord.status });
        context.setActual(`Admin原申请最终状态=${rejectedAdminRecord.status}`);
      }
    );

    let rejectedClientRecord: ObservedClientDepositRecord | undefined;
    await business.step(
      { action: '7. Client按原TXN验证拒绝终态', expected: '同一TXN变为failed/rejected，未创建第二条申请' },
      async context => {
        await expect.poll(async () => {
          await depositPage.goto(env.client.baseUrl!);
          rejectedClientRecord = await historyPage.observedRecordById(clientRecord.clientDepositId);
          return rejectedClientRecord?.status ?? 'missing';
        }, { timeout: 60_000 }).toMatch(/failed|rejected|已拒绝|拒绝|处理失败/i);
        expect(rejectedClientRecord?.clientDepositId).toBe(clientRecord.clientDepositId);
        expect(depositPage.submissionClicks()).toBe(0);
        context.recordPrimaryOracle({
          id: 'DP002-P4',
          name: 'Client原TXN进入拒绝终态',
          expected: '原TXN不变且拒绝',
          actual: rejectedClientRecord?.status ?? 'missing',
          status: 'passed'
        });
        context.setBusinessData({ clientDepositStatus: rejectedClientRecord?.status, terminalState: true });
        context.setActual('Client原TXN已进入拒绝终态；Resume未创建第二条Deposit');
      }
    );

    await business.step(
      { action: '8. 验证最终HKD余额和Secondary流水', expected: 'HKD余额等于原基线；全局流水缺失只产生警告' },
      async context => {
        await accountPage.goto(env.client.baseUrl!);
        const balanceAfter = await accountPage.readAvailableBalance(config.accountType, config.currency);
        expect(balanceAfter.availableBalance.equals(baselineBalance)).toBe(true);
        context.recordPrimaryOracle({
          id: 'DP002-P5',
          name: '拒绝后香港账户HKD余额不变',
          expected: baselineBalance.toString(),
          actual: balanceAfter.availableBalance.toString(),
          status: 'passed'
        });
        await transactionsPage.goto(env.client.baseUrl!);
        await transactionsPage.searchByBusinessId(clientRecord.clientDepositId);
        const ledgerVisible = await transactionsPage.businessRow(clientRecord.clientDepositId).count() === 1;
        context.recordSecondaryOracle({
          id: 'DP002-S1',
          name: 'Client全局交易流水展示入金TXN',
          expected: '可按原TXN读取',
          actual: ledgerVisible ? '已找到' : '未找到',
          status: ledgerVisible ? 'passed' : 'failed'
        });
        if (!ledgerVisible) context.warn('入金拒绝闭环已确认完成，但Client全局交易流水未展示对应TXN。');
        context.setBusinessData({
          depositBalanceAfter: balanceAfter.availableBalance.toString(),
          finalStatus: rejectedClientRecord?.status,
          confirmed: true
        });
        context.setActual(ledgerVisible
          ? 'HKD余额不变，且全局流水可按原TXN读取'
          : 'HKD余额不变；全局流水缺失已登记为Secondary Oracle警告');
      }
    );

    expect(depositPage.submissionClicks()).toBe(0);
    expect(rejectDrawer.confirmationClickCount()).toBe(1);
    expect(rejectedAdminRecord).toBeTruthy();
    testInfo.annotations.push({
      type: 'no-auto-rerun',
      description: `runId=${runId}；本次仅Resume原申请，Client提交点击0次`
    });
  }
);
