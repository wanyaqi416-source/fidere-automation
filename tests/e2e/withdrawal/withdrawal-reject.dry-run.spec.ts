import { WithdrawalListPage } from '../../../pages/admin/WithdrawalListPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { WithdrawalPage } from '../../../pages/client/WithdrawalPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { runWithdrawalAuthPreflight } from '../../../src/withdrawal/withdrawal-auth-preflight';
import {
  WithdrawalExecutionGuard,
  buildWithdrawalRejectReason,
  deriveUniqueWithdrawalAmount
} from '../../../src/withdrawal/withdrawal-e2e';
import { getWithdrawalTestConfig } from '../../client/withdrawal/withdrawalTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'WD-002 出金审核拒绝闭环Dry Run',
  {
    tag: ['@e2e', '@withdrawal', '@readonly', '@dry-run'],
    annotation: [
      { type: 'caseId', description: 'WD-002-DRY-RUN' },
      { type: 'module', description: 'Client + Admin出金' },
      { type: 'priority', description: 'P0' },
      { type: 'type', description: 'Dry Run / Read-only' }
    ]
  },
  async ({ clientPage, adminPage, business }, testInfo) => {
    test.setTimeout(120_000);
    if (!env.client.baseUrl || !env.admin.baseUrl) throw new Error('Withdrawal URLs are required.');
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);
    expect(testInfo.config.workers).toBe(1);
    expect(testInfo.project.retries).toBe(0);
    expect(testInfo.project.repeatEach).toBe(1);

    const config = getWithdrawalTestConfig();
    const runId = `WD002-DRY-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
    const amount = deriveUniqueWithdrawalAmount(
      runId,
      config.uniqueAmountBase,
      config.amountPrecision
    ).toFixed(config.amountPrecision);
    const guard = new WithdrawalExecutionGuard();
    const account = new AccountDetailPage(clientPage);
    const withdrawal = new WithdrawalPage(clientPage);
    const adminList = new WithdrawalListPage(adminPage);

    business.case({
      caseId: 'WD-002-DRY-RUN',
      module: 'Client + Admin出金',
      name: '出金审核拒绝闭环Dry Run',
      priority: 'P0',
      type: ['Dry Run', 'Read-only'],
      scope: 'Client + Admin',
      preconditions: ['Client/Admin认证有效', '两个Mutation开关关闭'],
      expectedResult: '唯一金额、余额、Admin拒绝状态模型和双开关守卫可用，零提交零拒绝。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: false,
      safetySwitches: ['ALLOW_MONEY_TESTS=false', 'ALLOW_ADMIN_MUTATION_TESTS=false']
    });
    business.setBusinessData({
      runId,
      accountType: config.accountType,
      withdrawalCurrency: config.currency,
      requestedAmount: amount,
      rejectReason: buildWithdrawalRejectReason(runId),
      dryRun: true,
      confirmationClicks: 0,
      rejectConfirmationClicks: 0
    });

    await business.step(
      { action: '预检双端认证与写操作守卫', expected: '认证有效，两个Mutation动作均被关闭开关阻断' },
      async ({ setActual }) => {
        await runWithdrawalAuthPreflight({
          clientPage,
          adminPage,
          clientBaseUrl: env.client.baseUrl!,
          adminBaseUrl: env.admin.baseUrl!,
          guard
        });
        expect(() => guard.assertClientSubmissionAllowed(false, false)).toThrow();
        setActual('双端认证有效；Client提交和Admin拒绝均未获授权');
      }
    );

    const balanceBefore = await business.step(
      { action: '读取推荐账户操作前可用余额', expected: '香港账户USD余额唯一可读且足以覆盖建议金额' },
      async ({ setActual, setBusinessData }) => {
        await account.goto(env.client.baseUrl!);
        const value = await account.readBalance({ accountType: config.accountType, currency: config.currency });
        expect(value.availableBalance.greaterThan(amount)).toBe(true);
        setBusinessData({ beforeAvailableBalance: value.availableBalance.toString(), beforeTotalBalance: '页面未提供' });
        setActual('可用余额已读取；页面没有独立总余额/冻结余额字段');
        return value.availableBalance;
      }
    );

    await business.step(
      { action: '构造Client提交前表单', expected: '唯一1.xx USD金额可进入确认页，但确认转账和安全验证点击0次' },
      async ({ setActual }) => {
        await withdrawal.goto(env.client.baseUrl!);
        await withdrawal.selectAccount(config.accountType);
        await withdrawal.selectCurrency(config.currencyLabel);
        await withdrawal.selectBeneficiary({
          name: config.beneficiaryName,
          accountSuffix: config.beneficiaryAccountSuffix,
          currency: config.currency
        });
        await withdrawal.selectPurpose(config.purpose);
        await withdrawal.fillAmount(amount);
        const snapshot = await withdrawal.continueToConfirmation();
        expect(snapshot.requestedAmountText).toContain(amount);
        expect(withdrawal.confirmationClicks()).toBe(0);
        expect(withdrawal.securityVerificationClicks()).toBe(0);
        setActual(`${amount} USD确认摘要可读；真实确认和安全验证均未点击`);
      }
    );

    await business.step(
      { action: '验证Admin拒绝状态模型和零写操作', expected: '历史存在已拒绝终态；当前列表筛选缺少已拒绝但不会触发任何审批' },
      async ({ setActual, setBusinessData, warn }) => {
        await adminList.goto(env.admin.baseUrl!);
        const statuses = await adminList.readStatusOptions();
        const records = await adminList.readCurrentPageRecords();
        const rejected = records.filter(record => record.status === '已拒绝');
        expect(rejected.length).toBeGreaterThan(0);
        expect(statuses).not.toContain('已拒绝');
        warn('Admin出金历史存在“已拒绝”，但状态筛选不提供该选项。');
        setBusinessData({
          adminStatusOptions: statuses,
          historicalRejectedCount: rejected.length,
          afterRejectedAvailableBalanceOracle: balanceBefore.toString(),
          rejectConfirmationClicks: 0,
          finalStatus: 'WD-002 Dry Run通过，未创建或拒绝出金申请'
        });
        setActual(`历史已拒绝记录${rejected.length}条；Admin最终拒绝点击0次`);
      }
    );
  }
);
