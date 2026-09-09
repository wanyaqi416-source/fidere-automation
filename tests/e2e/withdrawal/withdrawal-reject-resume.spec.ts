import { WithdrawalListPage } from '../../../pages/admin/WithdrawalListPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { WithdrawalHistoryPage } from '../../../pages/client/WithdrawalHistoryPage';
import type { WithdrawalTransactionRecord } from '../../../pages/client/TransactionsPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { matchesDepositCustomerIdentity } from '../../../src/deposit/deposit-e2e';
import { runWithdrawalAuthPreflight } from '../../../src/withdrawal/withdrawal-auth-preflight';
import {
  WithdrawalExecutionGuard,
  buildWithdrawalRejectReason,
  clientWithdrawalIdPattern,
  matchAdminWithdrawalRecordsIgnoringStatus,
  requireUniqueAdminWithdrawalCandidate,
  type AdminWithdrawalCandidate,
  type WithdrawalFingerprint
} from '../../../src/withdrawal/withdrawal-e2e';
import { assertClientTestEnvironment } from '../../../src/utils/clientSafety';
import { Decimal } from '../../../src/utils/money';
import { getWithdrawalTestConfig } from '../../client/withdrawal/withdrawalTestSupport';

const PENDING_STATUS = /待处理|处理中|pending|processing/i;
const REJECTED_STATUS = /已拒绝|拒绝|处理失败|failed|rejected/i;

test.describe.configure({ mode: 'serial', retries: 0 });
test.skip(
  !env.exchange.allowMoneyTests || !env.allowAdminMutationTests,
  'WD-002 Resume requires both mutation safety switches in this process.'
);

function requiredResumeValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for WD-002 Resume.`);
  return value;
}

function sortedIds(records: readonly WithdrawalTransactionRecord[]): string[] {
  return records.map(record => record.clientWithdrawalId).sort();
}

test(
  '续跑现有WD-002并完成Admin拒绝与Client余额恢复验证',
  {
    tag: ['@e2e', '@withdrawal', '@mutation', '@money', '@resume'],
    annotation: [
      { type: 'caseId', description: 'WD-002-RESUME' },
      { type: 'module', description: 'Client + Admin出金' },
      { type: 'priority', description: 'P0' },
      { type: 'scope', description: 'Client + Admin' },
      { type: 'type', description: 'E2E / Mutation / Money / Resume' }
    ]
  },
  async ({ clientPage, adminPage, business }, testInfo) => {
    test.setTimeout(180_000);
    if (!env.client.baseUrl || !env.admin.baseUrl) {
      throw new Error('CLIENT_BASE_URL and ADMIN_BASE_URL are required for WD-002 Resume.');
    }

    assertClientTestEnvironment(env.client.baseUrl);
    expect(new URL(env.admin.baseUrl).hostname.toLocaleLowerCase()).toContain('sandbox');
    expect(testInfo.config.workers).toBe(1);
    expect(testInfo.project.retries).toBe(0);
    expect(testInfo.project.repeatEach).toBe(1);
    expect(testInfo.retry).toBe(0);
    expect(testInfo.repeatEachIndex).toBe(0);

    const config = getWithdrawalTestConfig();
    const amount = new Decimal(requiredResumeValue('WITHDRAWAL_RESUME_AMOUNT'));
    const fee = new Decimal(requiredResumeValue('WITHDRAWAL_RESUME_FEE'));
    const baselineBalance = new Decimal(
      requiredResumeValue('WITHDRAWAL_RESUME_BALANCE_BEFORE')
    );
    const submittedBalance = new Decimal(
      requiredResumeValue('WITHDRAWAL_RESUME_BALANCE_SUBMITTED')
    );
    const submittedAtMs = Date.parse(requiredResumeValue('WITHDRAWAL_RESUME_SUBMITTED_AT'));
    const expectedTxnSuffix = requiredResumeValue('WITHDRAWAL_RESUME_TXN_SUFFIX')
      .toLocaleLowerCase();
    if (
      !amount.isFinite() ||
      !amount.isPositive() ||
      !fee.isFinite() ||
      fee.isNegative() ||
      !baselineBalance.isFinite() ||
      !submittedBalance.isFinite() ||
      !Number.isFinite(submittedAtMs) ||
      !/^[a-z0-9]{4,12}$/.test(expectedTxnSuffix)
    ) {
      throw new Error('WD-002 Resume parameters are invalid.');
    }

    const runId = `WD002-RESUME-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
    const rejectReason = buildWithdrawalRejectReason(runId);
    const guard = new WithdrawalExecutionGuard();
    const accountPage = new AccountDetailPage(clientPage);
    const historyPage = new WithdrawalHistoryPage(clientPage);
    const adminList = new WithdrawalListPage(adminPage);
    let rejectClicks = 0;

    business.case({
      caseId: 'WD-002-RESUME',
      module: 'Client + Admin出金',
      name: '续跑现有香港账户USD出金审核拒绝闭环',
      description: '不创建第二笔出金，仅恢复原Client TXN、Admin拒绝一次并验证原TXN终态和余额恢复。',
      priority: 'P0',
      type: ['E2E', 'Mutation', 'Money', 'Resume'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'Resume existing WD-002 without another Client submission',
      preconditions: [
        '现有Client TXN处于待处理',
        'Client和Admin认证有效',
        'Fidere Sandbox',
        '两个Mutation安全开关仅在本进程开启'
      ],
      target: '仅拒绝现有唯一出金申请，并验证原TXN拒绝终态及香港账户USD余额恢复。',
      expectedResult: 'Admin唯一定位并拒绝一次，原Client TXN进入拒绝终态，余额恢复且没有第二笔申请。',
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
      requestedAmount: amount.toString(),
      feeAmount: fee.toString(),
      beforeAvailableBalance: baselineBalance.toString(),
      submittedAvailableBalance: submittedBalance.toString(),
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
        action: '1. 执行Sandbox、双端认证和Resume安全预检',
        expected: 'Client和Admin业务页有效；本用例不进入Client出金提交页'
      },
      async ({ setActual }) => {
        await runWithdrawalAuthPreflight({
          clientPage,
          adminPage,
          clientBaseUrl: env.client.baseUrl!,
          adminBaseUrl: env.admin.baseUrl!,
          guard
        });
        expect(env.exchange.allowMoneyTests).toBe(true);
        expect(env.allowAdminMutationTests).toBe(true);
        setActual('Sandbox和双端认证有效；Resume只查询现有申请并准备Admin处理。');
      }
    );

    await historyPage.goto(env.client.baseUrl);
    const clientIdsBefore = sortedIds(await historyPage.readRecords());

    const clientRecord = await business.step(
      {
        action: '2. 按业务指纹恢复唯一原Client TXN',
        expected: '香港账户、USD、精确金额、收款账号尾号、时间窗口和待处理状态只匹配一条，且TXN尾号正确'
      },
      async context => {
        const diagnostics = await historyPage.diagnose({
          accountType: config.accountType,
          currency: config.currency,
          requestedAmount: amount.toString(),
          beneficiaryAccountSuffix: config.beneficiaryAccountSuffix,
          occurredFromMs: submittedAtMs - config.matchWindowMs,
          occurredToMs: submittedAtMs + config.matchWindowMs,
          status: PENDING_STATUS
        });
        expect(diagnostics.candidates).toHaveLength(1);
        const record = diagnostics.candidates[0];
        expect(clientWithdrawalIdPattern.test(record.clientWithdrawalId)).toBe(true);
        expect(record.clientWithdrawalId.toLocaleLowerCase().endsWith(expectedTxnSuffix)).toBe(true);
        expect(new Decimal(record.requestedAmount).equals(amount)).toBe(true);
        guard.recordClientSubmission(record.clientWithdrawalId);
        context.disallowSafeRerun();
        context.recordPrimaryOracle({
          id: 'WD002R-P1',
          name: '原Client TXN唯一存在',
          expected: '唯一待处理TXN-*出金申请',
          actual: record.clientWithdrawalId,
          status: 'passed'
        });
        context.setBusinessData({
          withdrawalOrderId: record.clientWithdrawalId,
          clientWithdrawalCandidateCount: diagnostics.candidates.length,
          clientCandidateStageCounts: diagnostics.counts,
          clientWithdrawalStatus: record.status,
          recordOccurredAt: record.occurredAt
        });
        context.setActual('原Client TXN候选数=1；编号、账户、币种、金额、收款尾号、时间和状态均匹配。');
        return record;
      }
    );

    await business.step(
      {
        action: '3. 核对Admin拒绝前香港账户USD余额',
        expected: '当前可用余额仍等于原申请提交后的已记录余额'
      },
      async ({ setActual }) => {
        await accountPage.goto(env.client.baseUrl!);
        const current = await accountPage.readAvailableBalance(config.accountType, config.currency);
        expect(current.availableBalance.equals(submittedBalance)).toBe(true);
        setActual('拒绝前余额与原申请提交后的基线一致，现有申请尚未被处理。');
      }
    );

    const fingerprint: WithdrawalFingerprint = {
      runId,
      userIdentity: config.adminUserIdentity,
      accountType: config.accountType,
      currency: config.currency,
      requestedAmount: amount.toString(),
      clientSubmittedAtMs: clientRecord.occurredAtMs,
      adminStatus: '待处理'
    };

    let adminCandidate: AdminWithdrawalCandidate;
    const rejection = await business.step(
      {
        action: '4. 使用客户邮箱唯一定位Admin记录并核对详情',
        expected: '邮箱搜索后，账户、USD、精确金额、待处理状态和时间窗口候选数严格等于1；详情收款人为配置值'
      },
      async context => {
        await adminList.goto(env.admin.baseUrl!);
        await adminList.selectStatus('待处理');
        await adminList.searchCustomerEmail(config.adminUserIdentity);
        const diagnostics = await adminList.diagnoseCandidates(
          fingerprint,
          config.matchWindowMs,
          { maxPages: 20 }
        );
        adminCandidate = requireUniqueAdminWithdrawalCandidate(diagnostics.candidates);
        guard.recordUniqueAdminCandidate(diagnostics.candidates.length);

        const liveCandidate = await adminList.locateFingerprintCandidate(
          fingerprint,
          config.matchWindowMs,
          20
        );
        const detailPage = await adminList.openDetail(liveCandidate);
        const detail = await detailPage.readDetail();
        expect(matchesDepositCustomerIdentity(detail.customerText, config.adminUserIdentity)).toBe(true);
        expect(detail.accountType).toBe(config.accountType);
        expect(new Decimal(detail.requestedAmount).equals(amount)).toBe(true);
        expect(new Decimal(detail.feeAmount).equals(fee)).toBe(true);
        expect(detail.beneficiaryText).toContain(config.beneficiaryName);
        expect(detail.purpose).toBe(config.purpose);
        expect(detail.status).toBe('待处理');
        expect(detail.submittedAt).toContain(liveCandidate.submittedAtText);
        const rejectReview = detailPage.rejectionReview();
        await rejectReview.waitForReady();

        context.recordPrimaryOracle({
          id: 'WD002R-P2',
          name: 'Admin候选唯一且详情匹配',
          expected: 'candidateCount=1，详情客户、账户、USD、金额、手续费、收款人、用途、时间和状态一致',
          actual: 'candidateCount=1，全部详情字段一致',
          status: 'passed'
        });
        context.setBusinessData({
          candidateCount: diagnostics.candidates.length,
          candidateStageCounts: diagnostics.counts,
          detailVerified: true,
          adminTransactionId: detail.adminTransactionId ?? '页面未提供独立Admin编号',
          adminWithdrawalStatus: detail.status
        });
        context.setActual('Admin使用配置邮箱搜索；业务指纹候选数=1；收款人仅在唯一详情中核对并通过。');
        return rejectReview;
      }
    );

    try {
      await business.step(
        {
          action: '5. Admin单次拒绝现有唯一出金申请',
          expected: '填写本次自动化拒绝原因，最终拒绝按钮只点击一次'
        },
        async context => {
          guard.assertAdminMutationAllowed(
            env.exchange.allowMoneyTests,
            env.allowAdminMutationTests
          );
          await rejection.fillReason(rejectReason);
          context.markPotentiallySubmitted();
          context.disallowSafeRerun();
          await rejection.confirmRejectOnce(
            env.exchange.allowMoneyTests,
            env.allowAdminMutationTests
          );
          rejectClicks = rejection.confirmationClickCount();
          expect(rejectClicks).toBe(1);
          context.setBusinessData({ rejectConfirmationClicks: rejectClicks });
          context.setActual('Admin最终拒绝点击1次；没有批准，也没有第二次点击。');
        }
      );

      let rejectedAdminRecord: AdminWithdrawalCandidate | undefined;
      await business.step(
        {
          action: '6. 等待Admin原记录进入拒绝终态',
          expected: '不再次点击拒绝，按同一业务指纹只读查询原记录并得到拒绝终态'
        },
        async context => {
          await expect.poll(async () => {
            await adminList.goto(env.admin.baseUrl!);
            await adminList.searchCustomerEmail(config.adminUserIdentity);
            const matches = matchAdminWithdrawalRecordsIgnoringStatus(
              await adminList.readAllFilteredRecords(),
              fingerprint,
              config.matchWindowMs
            );
            rejectedAdminRecord = matches.length === 1 ? matches[0] : undefined;
            return matches.length === 1 ? matches[0].status : `candidateCount=${matches.length}`;
          }, {
            message: 'Existing Admin Withdrawal did not reach a rejected terminal state.',
            timeout: 60_000
          }).toMatch(REJECTED_STATUS);
          context.recordPrimaryOracle({
            id: 'WD002R-P3',
            name: 'Admin拒绝成功且只执行一次',
            expected: '原Admin记录进入拒绝终态，点击次数=1',
            actual: `${rejectedAdminRecord!.status}；点击次数=1`,
            status: 'passed'
          });
          context.setBusinessData({ adminWithdrawalStatus: rejectedAdminRecord!.status });
          context.setActual(`Admin原记录最终状态为${rejectedAdminRecord!.status}。`);
        }
      );

      let rejectedClientRecord: WithdrawalTransactionRecord | undefined;
      await business.step(
        {
          action: '7. 按原TXN等待Client拒绝终态',
          expected: '原TXN编号不变并进入拒绝终态，不按最新记录定位'
        },
        async context => {
          await expect.poll(async () => {
            await historyPage.goto(env.client.baseUrl!);
            await historyPage.transactions.searchByBusinessId(clientRecord.clientWithdrawalId);
            rejectedClientRecord = await historyPage.recordById(clientRecord.clientWithdrawalId);
            return rejectedClientRecord?.status ?? 'missing';
          }, {
            message: 'Original Client Withdrawal TXN did not reach a rejected terminal state.',
            timeout: 60_000
          }).toMatch(REJECTED_STATUS);
          expect(rejectedClientRecord?.clientWithdrawalId).toBe(clientRecord.clientWithdrawalId);
          expect(new Decimal(rejectedClientRecord!.requestedAmount).equals(amount)).toBe(true);
          context.recordPrimaryOracle({
            id: 'WD002R-P4',
            name: '原Client TXN进入拒绝终态',
            expected: '原TXN不变且状态为拒绝',
            actual: rejectedClientRecord!.status,
            status: 'passed'
          });
          context.setBusinessData({
            clientWithdrawalStatus: rejectedClientRecord!.status,
            terminalState: true
          });
          context.setActual('Client按原TXN读取到拒绝终态。');
        }
      );

      await business.step(
        {
          action: '8. 验证香港账户USD余额恢复且没有第二笔申请',
          expected: '最终余额严格等于原提交前余额；Client出金TXN集合未新增'
        },
        async context => {
          await accountPage.goto(env.client.baseUrl!);
          const after = await accountPage.readAvailableBalance(config.accountType, config.currency);
          expect(after.availableBalance.equals(baselineBalance)).toBe(true);

          await historyPage.goto(env.client.baseUrl!);
          const recordsAfter = await historyPage.readRecords();
          expect(sortedIds(recordsAfter)).toEqual(clientIdsBefore);
          const exactRecord = recordsAfter.find(
            record => record.clientWithdrawalId === clientRecord.clientWithdrawalId
          );
          expect(exactRecord).toBeTruthy();
          const drawer = await historyPage.openDetail(exactRecord!);
          const visibleText = await drawer.readFiatWithdrawalVisibleText();
          const reasonDisplayed = visibleText.includes(rejectReason) || visibleText.includes(runId);

          context.recordPrimaryOracle({
            id: 'WD002R-P5',
            name: '拒绝后香港账户USD余额恢复',
            expected: baselineBalance.toString(),
            actual: after.availableBalance.toString(),
            status: 'passed'
          });
          context.recordPrimaryOracle({
            id: 'WD002R-P6',
            name: '没有创建第二笔出金申请',
            expected: 'Resume前后Client TXN集合一致',
            actual: 'Client TXN集合未新增',
            status: 'passed'
          });
          context.recordSecondaryOracle({
            id: 'WD002R-S1',
            name: 'Client详情展示Admin拒绝原因',
            expected: '如产品展示原因，则与本次runId对应',
            actual: reasonDisplayed ? '已展示并匹配' : '页面未展示拒绝原因',
            status: 'passed'
          });
          context.setBusinessData({
            afterRejectedAvailableBalance: after.availableBalance.toString(),
            releasedAmount: after.availableBalance.minus(submittedBalance).toString(),
            rejectReasonDisplayed: reasonDisplayed,
            noNewWithdrawalCreated: true,
            finalStatus: rejectedClientRecord!.status,
            confirmed: true
          });
          context.setActual('余额已恢复到原提交前基线；Resume前后Client TXN集合一致，没有创建第二笔出金。');
        }
      );
    } catch (error) {
      if (rejectClicks === 1) {
        business.requireManualReview('现有Admin出金状态、原Client TXN和香港账户USD余额');
        business.disallowSafeRerun();
      }
      throw error;
    }

    expect(rejectClicks).toBe(1);
    testInfo.annotations.push({
      type: 'no-auto-rerun',
      description: `runId=${runId}；仅Resume原TXN，Client提交点击0次。`
    });
  }
);
