import { DepositClaimListPage } from '../../../pages/admin/DepositClaimListPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { DepositHistoryPage } from '../../../pages/client/DepositHistoryPage';
import { DepositPage } from '../../../pages/client/DepositPage';
import { TransactionsPage } from '../../../pages/client/TransactionsPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import {
  matchAdminDepositRecordsIgnoringStatus,
  requireUniqueAdminDepositCandidate,
  type DepositFingerprint
} from '../../../src/deposit/deposit-e2e';
import { Decimal } from '../../../src/utils/money';
import { getDepositTestConfig } from '../../client/deposit/depositTestSupport';

function requiredPostcheckValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for DP-002 Postcheck.`);
  return value;
}

test('DP-002拒绝后只读终态复核 @deposit @readonly @reconciliation', async ({
  adminPage,
  clientPage,
  business
}, testInfo) => {
  if (!env.client.baseUrl || !env.admin.baseUrl) {
    throw new Error('CLIENT_BASE_URL and ADMIN_BASE_URL are required for DP-002 Postcheck.');
  }
  expect(env.exchange.allowMoneyTests).toBe(false);
  expect(env.allowAdminMutationTests).toBe(false);

  const config = getDepositTestConfig();
  const runId = requiredPostcheckValue('DEPOSIT_RESUME_RUN_ID');
  const amount = new Decimal(requiredPostcheckValue('DEPOSIT_RESUME_AMOUNT'));
  const baselineBalance = new Decimal(requiredPostcheckValue('DEPOSIT_RESUME_BALANCE_BEFORE'));
  const submittedAtMs = Date.parse(requiredPostcheckValue('DEPOSIT_RESUME_SUBMITTED_AT'));
  if (!amount.isFinite() || !baselineBalance.isFinite() || !Number.isFinite(submittedAtMs)) {
    throw new Error('DP-002 Postcheck input is invalid.');
  }

  const historyPage = new DepositHistoryPage(clientPage);
  const depositPage = new DepositPage(clientPage);
  const adminList = new DepositClaimListPage(adminPage);
  const accountPage = new AccountDetailPage(clientPage);
  const transactionsPage = new TransactionsPage(clientPage);

  business.case({
    caseId: 'DP-002',
    module: 'Client + Admin入金',
    name: 'DP-002拒绝后只读终态复核',
    description: 'Admin拒绝只点击一次后，仅查询原TXN、Admin终态和香港账户HKD余额，不执行任何写操作。',
    priority: 'P0',
    type: ['E2E Adjudication', 'Reconciliation', 'Read-only'],
    scope: 'Client + Admin',
    owner: 'QA',
    requirement: 'Adjudicate existing DP-002 after terminal poll exceeded test timeout',
    preconditions: ['原Client TXN已创建', 'Admin确认拒绝已点击一次', '两个Mutation开关均关闭'],
    target: '通过Primary Oracle确认原DP-002业务结果。',
    expectedResult: 'Admin拒绝、Client原TXN拒绝且HKD余额等于提交前基线。',
    changesData: false,
    affectsMoney: false,
    dependsOnAdmin: true,
    dependsOnThirdParty: false,
    safetySwitches: ['ALLOW_MONEY_TESTS=false', 'ALLOW_ADMIN_MUTATION_TESTS=false']
  });
  business.setBusinessData({
    runId,
    accountType: config.accountType,
    depositCurrency: config.currency,
    depositAmount: amount.toString(),
    depositBalanceBefore: baselineBalance.toString(),
    confirmationClicks: 1,
    rejectConfirmationClicks: 1,
    candidateCount: 0,
    confirmed: false
  });
  business.disallowSafeRerun();

  const clientRecord = await business.step(
    { action: '1. 按原业务数据读取Client TXN终态', expected: '唯一TXN存在且状态为failed/rejected' },
    async context => {
      await historyPage.installSafeRecordObserver();
      await depositPage.goto(env.client.baseUrl!);
      let candidates: Awaited<ReturnType<DepositHistoryPage['readObservedRecords']>> = [];
      await expect.poll(async () => {
        candidates = (await historyPage.readObservedRecords()).filter(record =>
          record.currency === config.currency &&
          record.requestedAmount !== undefined &&
          new Decimal(record.requestedAmount).equals(amount) &&
          record.submittedAtMs !== undefined &&
          record.submittedAtMs >= submittedAtMs - config.matchWindowMs &&
          record.submittedAtMs <= submittedAtMs + config.matchWindowMs
        );
        return candidates.length;
      }).toBe(1);
      const record = candidates[0];
      expect(record.status).toMatch(/failed|rejected|已拒绝|拒绝|处理失败/i);
      context.recordPrimaryOracle({
        id: 'DP002-P1',
        name: 'Client原TXN申请存在',
        expected: '唯一原TXN',
        actual: record.clientDepositId,
        status: 'passed'
      });
      context.recordPrimaryOracle({
        id: 'DP002-P4',
        name: 'Client原TXN进入拒绝终态',
        expected: 'failed/rejected',
        actual: record.status ?? 'missing',
        status: 'passed'
      });
      context.setBusinessData({
        depositOrderId: record.clientDepositId,
        clientDepositStatus: record.status,
        clientDepositHistoryCandidateCount: candidates.length
      });
      context.setActual('Client原TXN候选数为1且已进入拒绝终态');
      return record;
    }
  );

  const adminRecord = await business.step(
    { action: '2. 按业务指纹读取Admin拒绝终态', expected: '候选数严格等于1且状态为处理失败/拒绝' },
    async context => {
      const fingerprint: DepositFingerprint = {
        runId,
        userIdentity: config.adminUserIdentity,
        accountType: config.accountType,
        currency: config.currency,
        requestedAmount: amount.toString(),
        clientSubmittedAtMs: clientRecord.submittedAtMs ?? submittedAtMs,
        adminStatus: '待处理',
        channel: config.channel
      };
      await adminList.goto(env.admin.baseUrl!);
      const candidates = matchAdminDepositRecordsIgnoringStatus(
        await adminList.readAllFilteredRecords(),
        fingerprint,
        config.matchWindowMs
      );
      const record = requireUniqueAdminDepositCandidate(candidates);
      expect(record.status).toMatch(/处理失败|已拒绝|拒绝|failed|rejected/i);
      context.recordPrimaryOracle({
        id: 'DP002-P2',
        name: 'Admin候选唯一',
        expected: 'candidateCount=1',
        actual: `candidateCount=${candidates.length}`,
        status: 'passed'
      });
      context.recordPrimaryOracle({
        id: 'DP002-P3',
        name: 'Admin拒绝成功',
        expected: '处理失败/拒绝终态',
        actual: record.status,
        status: 'passed'
      });
      context.setBusinessData({ candidateCount: candidates.length, adminDepositStatus: record.status });
      context.setActual(`Admin候选数为1，最终状态=${record.status}`);
      return record;
    }
  );

  await business.step(
    { action: '3. 验证香港账户HKD余额与Secondary流水', expected: '余额等于70.07基线；全局流水缺失仅警告' },
    async context => {
      await accountPage.goto(env.client.baseUrl!);
      const after = await accountPage.readAvailableBalance(config.accountType, config.currency);
      expect(after.availableBalance.equals(baselineBalance)).toBe(true);
      context.recordPrimaryOracle({
        id: 'DP002-P5',
        name: '拒绝后香港账户HKD余额不变',
        expected: baselineBalance.toString(),
        actual: after.availableBalance.toString(),
        status: 'passed'
      });
      await transactionsPage.goto(env.client.baseUrl!);
      await transactionsPage.searchByBusinessId(clientRecord.clientDepositId);
      await expect.poll(async () =>
        transactionsPage.businessRow(clientRecord.clientDepositId).count()
      ).toBe(1);
      const ledgerVisible = true;
      context.recordSecondaryOracle({
        id: 'DP002-S1',
        name: 'Client全局交易流水展示入金TXN',
        expected: '可按原TXN读取',
        actual: ledgerVisible ? '已找到' : '未找到',
        status: ledgerVisible ? 'passed' : 'failed'
      });
      if (!ledgerVisible) context.warn('入金拒绝闭环已确认完成，但Client全局交易流水未展示对应TXN。');
      context.setBusinessData({
        depositBalanceAfter: after.availableBalance.toString(),
        clientDepositStatus: clientRecord.status,
        adminDepositStatus: adminRecord.status,
        confirmed: true,
        finalStatus: clientRecord.status
      });
      context.setActual(ledgerVisible
        ? '香港账户HKD余额不变，全局流水可读取'
        : '香港账户HKD余额不变；全局流水缺失仅作为Secondary警告');
    }
  );

  expect(depositPage.submissionClicks()).toBe(0);
  testInfo.annotations.push({
    type: 'no-mutation-postcheck',
    description: '只读复核；Client提交0次，Admin最终操作0次'
  });
});
