import { DepositClaimDrawer } from '../../../pages/admin/DepositClaimDrawer';
import { DepositClaimListPage } from '../../../pages/admin/DepositClaimListPage';
import { DepositRejectDrawer } from '../../../pages/admin/DepositRejectDrawer';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { DepositHistoryPage } from '../../../pages/client/DepositHistoryPage';
import { DepositPage } from '../../../pages/client/DepositPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { runDepositAuthPreflight } from '../../../src/deposit/deposit-auth-preflight';
import {
  DepositExecutionGuard,
  diagnoseAdminDepositCandidates,
  matchAdminDepositCandidates,
  matchesDepositCustomerIdentity,
  requireUniqueAdminDepositCandidate,
  type DepositFingerprint
} from '../../../src/deposit/deposit-e2e';
import { Decimal } from '../../../src/utils/money';
import {
  getDepositReconciliationConfig,
  getDepositTestConfig
} from '../../client/deposit/depositTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'DP-002/DP-003 入金历史只读Reconciliation @e2e @deposit @readonly @reconciliation @dry-run',
  async ({ clientPage, adminPage, business }) => {
    if (!env.client.baseUrl || !env.admin.baseUrl) {
      throw new Error('CLIENT_BASE_URL and ADMIN_BASE_URL are required for Deposit reconciliation.');
    }
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);

    const config = getDepositTestConfig();
    const historical = getDepositReconciliationConfig();
    const guard = new DepositExecutionGuard();
    const accountPage = new AccountDetailPage(clientPage);
    const depositPage = new DepositPage(clientPage);
    const historyPage = new DepositHistoryPage(clientPage);
    const adminList = new DepositClaimListPage(adminPage);
    const claimDrawer = new DepositClaimDrawer(adminPage);
    const rejectDrawer = new DepositRejectDrawer(adminPage);

    business.case({
      caseId: 'DP-RECON-001',
      module: 'Client + Admin入金',
      name: '入金历史只读Reconciliation',
      description: '用历史待处理记录验证Client入金历史、Admin候选唯一性、认领详情和拒绝入口，所有最终操作点击0次。',
      priority: 'P0',
      type: ['Reconciliation', 'Dry Run', 'Read-only'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'Deposit Client/Admin dry run',
      preconditions: ['Client/Admin认证有效', '存在已确认的历史待处理入金', '两个Mutation开关均关闭'],
      target: '确认DP-002/DP-003未来可按业务指纹唯一定位同一申请，并验证Admin操作抽屉。',
      expectedResult: 'Client历史候选和Admin候选均唯一；详情一致；认领和拒绝最终按钮均未点击。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: false,
      safetySwitches: ['ALLOW_MONEY_TESTS=false', 'ALLOW_ADMIN_MUTATION_TESTS=false']
    });
    business.setBusinessData({
      accountType: historical.accountType,
      depositCurrency: historical.currency,
      depositAmount: historical.amount,
      depositChannel: config.channel,
      candidateCount: 0,
      dryRun: true,
      confirmed: false
    });

    await business.step(
      { action: '执行Client/Admin双端认证预检', expected: '两端业务页面可访问，两个写开关保持关闭' },
      async ({ setActual }) => {
        await runDepositAuthPreflight({
          clientPage,
          adminPage,
          clientBaseUrl: env.client.baseUrl!,
          adminBaseUrl: env.admin.baseUrl!,
          guard
        });
        expect(() => guard.assertClientSubmissionAllowed(false, false)).toThrow();
        setActual('Client与Admin认证有效；入金提交和Admin处理均被安全开关阻断');
      }
    );

    await business.step(
      { action: '读取历史目标法域账户余额', expected: '历史香港账户HKD余额仍可用于DP-002只读复核' },
      async ({ setActual, setBusinessData }) => {
        await accountPage.goto(env.client.baseUrl!);
        const balance = await accountPage.readBalance({
          accountType: historical.accountType,
          currency: historical.currency
        });
        setBusinessData({ depositBalanceCurrent: balance.availableBalance.toString() });
        setActual(`已唯一读取${historical.accountType}/${historical.currency}当前可用余额`);
      }
    );

    const clientRecord = await business.step(
      { action: '按历史业务字段定位Client入金记录', expected: '币种、金额、状态和时间窗口候选数为1' },
      async ({ setActual, setBusinessData }) => {
        await depositPage.goto(env.client.baseUrl!);
        await depositPage.selectAccount(historical.accountType);
        await depositPage.selectCurrency(historical.currencyLabel);
        const candidates = await historyPage.findCandidates({
          currency: historical.currency,
          requestedAmount: historical.amount,
          status: historical.clientStatus,
          submittedAtMs: historical.submittedAtMs,
          matchWindowMs: 60_000
        });
        expect(candidates).toHaveLength(1);
        const record = candidates[0];
        setBusinessData({
          clientDepositStatus: record.status,
          clientDepositHistoryCandidateCount: candidates.length,
          depositOrderId: record.clientDepositId ?? '历史摘要未展示TXN编号'
        });
        setActual('已通过币种、金额、状态和提交分钟唯一定位Client历史记录；摘要未展示TXN字段');
        return record;
      }
    );

    const adminCandidate = await business.step(
      { action: '按业务指纹唯一定位Admin入账认领记录', expected: '用户、账户、币种、精确金额、状态和时间窗口候选数严格等于1' },
      async ({ setActual, setBusinessData }) => {
        await adminList.goto(env.admin.baseUrl!);
        await adminList.applyFilters({ status: historical.adminStatus, matchStatus: '已匹配' });
        const records = await adminList.readAllFilteredRecords();
        const fingerprint: DepositFingerprint = {
          runId: 'DP-HISTORICAL-RECON',
          userIdentity: config.adminUserIdentity,
          accountType: historical.accountType,
          currency: historical.currency,
          requestedAmount: historical.amount,
          clientSubmittedAtMs: clientRecord.submittedAtMs,
          adminStatus: historical.adminStatus,
          channel: config.channel
        };
        const diagnostics = diagnoseAdminDepositCandidates(
          records,
          fingerprint,
          config.matchWindowMs
        );
        test.info().annotations.push({
          type: 'deposit-candidate-stage-counts',
          description: JSON.stringify(diagnostics.counts)
        });
        test.info().annotations.push({
          type: 'deposit-pre-user-customer-hashes',
          description: diagnostics.preUserIdentityHashes.join(',') || 'none'
        });
        const candidates = matchAdminDepositCandidates(records, fingerprint, config.matchWindowMs);
        const unique = requireUniqueAdminDepositCandidate(candidates);
        setBusinessData({
          candidateCount: candidates.length,
          candidateStageCounts: diagnostics.counts,
          fingerprintFields: [
            '测试用户', '账户类型', '币种', '精确金额', '待处理状态', '提交时间窗口', '打款渠道'
          ],
          adminDepositStatus: unique.status,
          adminReference: unique.reference
        });
        setActual('Admin候选数为1；未依赖Client TXN与Admin编号直接映射');
        return unique;
      }
    );

    await business.step(
      { action: '打开Admin认领详情并二次核对', expected: '账户、金额、渠道、客户和时间与唯一候选一致' },
      async ({ setActual, setBusinessData }) => {
        await claimDrawer.open(adminList, adminCandidate);
        const detail = await claimDrawer.readDetail();
        expect(detail.accountType).toContain(historical.accountType);
        expect(new Decimal(detail.originalAmount).equals(new Decimal(historical.amount))).toBe(true);
        expect(new Decimal(detail.claimAmount).equals(new Decimal(adminCandidate.actualAmount))).toBe(true);
        expect(detail.channel).toContain(config.channel);
        expect(matchesDepositCustomerIdentity(detail.matchedCustomerText, config.adminUserIdentity)).toBe(true);
        expect(detail.submittedAtText).toContain(adminCandidate.submittedAtText);
        await claimDrawer.expectRequiredRemark();
        expect(claimDrawer.confirmationClickCount()).toBe(0);
        setBusinessData({
          actualDepositAmount: detail.claimAmount,
          detailVerified: true,
          claimConfirmationClicks: 0
        });
        setActual('认领详情与历史业务指纹一致；确认认领点击0次');
        await claimDrawer.closeWithoutConfirming();
      }
    );

    await business.step(
      { action: '验证Admin拒绝入口后停止', expected: '拒绝原因必填，确认拒绝按钮存在但点击次数为0' },
      async ({ setActual, setBusinessData }) => {
        await rejectDrawer.open(adminList, adminCandidate);
        expect(rejectDrawer.confirmationClickCount()).toBe(0);
        setBusinessData({
          rejectActionAvailable: true,
          rejectConfirmationClicks: 0,
          finalStatus: 'Dry Run完成，未创建入金申请且未执行Admin认领或拒绝'
        });
        setActual('拒绝原因输入和确认拒绝按钮可见；确认拒绝点击0次');
        await rejectDrawer.closeWithoutConfirming();
      }
    );
  }
);
