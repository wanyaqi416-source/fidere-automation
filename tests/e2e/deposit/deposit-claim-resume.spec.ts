import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DepositClaimDrawer } from '../../../pages/admin/DepositClaimDrawer';
import { DepositClaimListPage } from '../../../pages/admin/DepositClaimListPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import {
  TransactionsPage,
  type DepositTransactionDiagnostics,
  type DepositTransactionRecord
} from '../../../pages/client/TransactionsPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { runDepositAuthPreflight } from '../../../src/deposit/deposit-auth-preflight';
import {
  clientDepositIdPattern,
  DepositExecutionGuard,
  expectedDepositBalanceAfterClaim,
  matchAdminDepositCandidates,
  matchAdminDepositRecordsIgnoringStatus,
  matchesDepositCustomerIdentity,
  requireUniqueAdminDepositCandidate,
  type AdminDepositCandidate,
  type DepositFingerprint
} from '../../../src/deposit/deposit-e2e';
import { Decimal } from '../../../src/utils/money';
import { getDepositTestConfig } from '../../client/deposit/depositTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });
test.skip(
  !env.exchange.allowMoneyTests || !env.allowAdminMutationTests,
  'DP-003 Resume需要在单次进程中显式开启两个Mutation安全开关。'
);

type ArchivedCase = {
  caseId: string;
  startedAt: string;
  businessData: Record<string, unknown>;
};

type ArchivedRun = {
  endedAt: string;
  cases: ArchivedCase[];
};

const archivedRunPath = resolve(
  'reports/business/history/2026-08-27_15-23-13-73c8056a/report.json'
);

function parseChinaReportTime(value: string): number {
  const timestamp = Date.parse(value.replaceAll('/', '-').replace(' ', 'T') + '+08:00');
  if (!Number.isFinite(timestamp)) throw new Error('Archived DP-003 time could not be parsed.');
  return timestamp;
}

function loadExistingDp003(): {
  accountType: string;
  currency: string;
  amount: string;
  balanceBefore: string;
  submittedFromMs: number;
  submittedToMs: number;
} {
  const run = JSON.parse(readFileSync(archivedRunPath, 'utf8')) as ArchivedRun;
  const testCase = run.cases.find(item => item.caseId === 'DP-003');
  if (!testCase) throw new Error('Archived DP-003 execution evidence was not found.');

  const accountType = String(testCase.businessData.accountType ?? '');
  const currency = String(testCase.businessData.depositCurrency ?? '');
  const amount = String(testCase.businessData.depositAmount ?? '');
  const balanceBefore = String(testCase.businessData.depositBalanceBefore ?? '');
  if (
    !accountType ||
    !currency ||
    !new Decimal(amount).isPositive() ||
    !new Decimal(balanceBefore).isFinite()
  ) {
    throw new Error('Archived DP-003 business fingerprint or balance baseline is incomplete.');
  }

  return {
    accountType,
    currency,
    amount,
    balanceBefore,
    submittedFromMs: parseChinaReportTime(testCase.startedAt),
    submittedToMs: parseChinaReportTime(run.endedAt)
  };
}

function buildResumeRemark(runId: string): string {
  const suffix = runId.replace(/[^A-Z0-9]/gi, '').slice(-18);
  if (!suffix) throw new Error('DP-003 Resume runId is required.');
  return `AUTO_DP003_RESUME_${suffix}`;
}

test(
  'DP-003 Resume现有USD入金并由Admin认领成功 @e2e @deposit @resume @mutation @money',
  async ({ adminPage, clientPage, business }, testInfo) => {
    test.setTimeout(300_000);
    if (!env.client.baseUrl || !env.admin.baseUrl) {
      throw new Error('CLIENT_BASE_URL and ADMIN_BASE_URL are required for DP-003 Resume.');
    }

    expect(new URL(env.client.baseUrl).hostname.toLocaleLowerCase()).toContain('sandbox');
    expect(new URL(env.admin.baseUrl).hostname.toLocaleLowerCase()).toContain('sandbox');
    expect(testInfo.config.workers).toBe(1);
    expect(testInfo.project.retries).toBe(0);
    expect(testInfo.project.repeatEach).toBe(1);
    expect(testInfo.retry).toBe(0);
    expect(testInfo.repeatEachIndex).toBe(0);

    const existing = loadExistingDp003();
    const config = getDepositTestConfig();
    const runId = `DP003-RESUME-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
    const claimRemark = buildResumeRemark(runId);
    const guard = new DepositExecutionGuard();
    const transactionsPage = new TransactionsPage(clientPage);
    const accountPage = new AccountDetailPage(clientPage);
    const adminList = new DepositClaimListPage(adminPage);
    const claimDrawer = new DepositClaimDrawer(adminPage);
    let adminClaimClicked = false;

    business.case({
      caseId: 'DP-003-RESUME',
      module: 'Client + Admin入金',
      name: '现有11.97 USD入金认领成功续跑',
      description: '复用已经创建的Client入金系统TXN，仅执行Admin认领和Client/余额终态验证，不创建第二笔Deposit。',
      priority: 'P0',
      type: ['Resume', 'E2E', 'Mutation', 'Money'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'DP-003 existing deposit claim resume',
      preconditions: [
        '现有Client系统TXN状态为待处理',
        'Admin候选数严格等于1',
        'Fidere Sandbox',
        '两个Mutation安全开关仅在本进程开启',
        'workers=1且retries=0'
      ],
      target: '认领现有TXN并验证原申请完成及香港账户USD准确增加Admin实际入账金额。',
      expectedResult: 'Admin单次认领成功，Client原TXN进入完成终态，余额增加actualDepositAmount。',
      changesData: true,
      affectsMoney: true,
      dependsOnAdmin: true,
      dependsOnThirdParty: false,
      safetySwitches: ['ALLOW_MONEY_TESTS', 'ALLOW_ADMIN_MUTATION_TESTS']
    });
    business.setBusinessData({
      runId,
      accountType: existing.accountType,
      depositCurrency: existing.currency,
      depositAmount: existing.amount,
      depositBalanceBefore: existing.balanceBefore,
      candidateCount: 0,
      confirmationClicks: 0,
      claimConfirmationClicks: 0,
      noNewDepositCreated: true,
      confirmed: false,
      claimRemark
    });

    await business.step(
      {
        action: '1. 执行Sandbox、双端认证和Resume运行器安全预检',
        expected: 'Client/Admin业务页可访问，两个开关开启，单worker、零重试且不含Client提交路径'
      },
      async ({ setActual }) => {
        await runDepositAuthPreflight({
          clientPage,
          adminPage,
          clientBaseUrl: env.client.baseUrl!,
          adminBaseUrl: env.admin.baseUrl!,
          guard
        });
        expect(env.exchange.allowMoneyTests).toBe(true);
        expect(env.allowAdminMutationTests).toBe(true);
        setActual('Sandbox与双端认证有效；Resume执行器仅处理既有申请，两个安全开关仅在本进程开启');
      }
    );

    const balanceBefore = await business.step(
      {
        action: '2. 确认香港账户USD仍处于原操作前余额',
        expected: `当前余额必须仍为归档基线${existing.balanceBefore} USD，确认尚未入账`
      },
      async ({ setActual }) => {
        await accountPage.goto(env.client.baseUrl!);
        const balance = await accountPage.readBalance({
          accountType: existing.accountType,
          currency: existing.currency
        });
        expect(balance.availableBalance.equals(new Decimal(existing.balanceBefore))).toBe(true);
        setActual('当前香港账户USD余额与原始baseline一致，现有入金尚未造成余额增加');
        return balance.availableBalance;
      }
    );

    const clientRecord = await business.step(
      {
        action: '3. 按原业务指纹定位Client系统TXN并打开详情',
        expected: '唯一定位香港账户/USD/11.97/待处理记录，系统TXN后缀与已授权记录一致'
      },
      async context => {
        let diagnostics: DepositTransactionDiagnostics | undefined;
        await expect.poll(async () => {
          await transactionsPage.goto(env.client.baseUrl!);
          await transactionsPage.selectDepositType();
          diagnostics = await transactionsPage.diagnoseDepositRecords({
            accountType: existing.accountType,
            currency: existing.currency,
            requestedAmount: existing.amount,
            submittedFromMs: existing.submittedFromMs,
            submittedToMs: existing.submittedToMs,
            status: /待处理|处理中|pending|processing/i
          });
          return diagnostics.candidates.length;
        }, {
          message: 'Existing DP-003 Client candidateCount did not become 1 before Admin mutation.',
          timeout: 30_000
        }).toBe(1);
        if (!diagnostics) throw new Error('Client Deposit diagnostics were not produced.');
        const record = diagnostics.candidates[0];
        expect(clientDepositIdPattern.test(record.ledgerTransactionId)).toBe(true);
        expect(record.ledgerTransactionId.toLocaleLowerCase().endsWith('cf8c')).toBe(true);
        const detail = await (await transactionsPage.openDepositDetail(record))
          .readFiatDepositDetail();
        expect(detail.ledgerTransactionId).toBe(record.ledgerTransactionId);
        expect(detail.displayedTransactionNumber).toMatch(/^AUTO_DP003-/i);
        expect(detail.accountType).toBe(existing.accountType);
        expect(detail.currency).toBe(existing.currency);
        expect(new Decimal(detail.amount).equals(existing.amount)).toBe(true);
        expect(detail.status).toMatch(/待处理|处理中|pending|processing/i);
        guard.recordClientSubmission(record.ledgerTransactionId);
        context.recordPrimaryOracle({
          id: 'DP003R-P1',
          name: 'Client原系统TXN仍存在且待处理',
          expected: '唯一系统TXN与授权记录一致，详情属于同一11.97 USD入金',
          actual: `已读取${record.ledgerTransactionId}及独立电汇指令参考号`,
          status: 'passed'
        });
        context.setBusinessData({
          systemTransactionId: record.ledgerTransactionId,
          wireReferenceId: detail.displayedTransactionNumber,
          clientDepositStatus: detail.status,
          clientDepositHistoryCandidateCount: diagnostics.candidates.length,
          candidateStageCounts: diagnostics.counts,
          recordOccurredAt: record.occurredAt,
          detailVerified: true
        });
        context.setActual('Client原系统TXN唯一且仍为待处理；系统TXN与电汇指令参考号已分别读取');
        return { record, wireReferenceId: detail.displayedTransactionNumber };
      }
    );

    const fingerprint: DepositFingerprint = {
      runId,
      userIdentity: config.adminUserIdentity,
      accountType: existing.accountType,
      currency: existing.currency,
      requestedAmount: existing.amount,
      clientSubmittedAtMs: clientRecord.record.occurredAtMs,
      adminStatus: '待处理',
      channel: config.channel
    };

    const adminCandidate = await business.step(
      {
        action: '4. Admin重新唯一定位现有待处理入金',
        expected: '测试用户、香港账户、USD、11.97、渠道、状态和时间窗口候选数严格等于1'
      },
      async context => {
        let candidates: AdminDepositCandidate[] = [];
        await expect.poll(async () => {
          await adminList.goto(env.admin.baseUrl!);
          await adminList.applyFilters({ status: '待处理', matchStatus: '已匹配' });
          candidates = matchAdminDepositCandidates(
            await adminList.readAllFilteredRecords(),
            fingerprint,
            config.matchWindowMs
          );
          return candidates.length;
        }, {
          message: 'Existing DP-003 Admin candidateCount did not become exactly 1.',
          timeout: 45_000
        }).toBe(1);
        const candidate = requireUniqueAdminDepositCandidate(candidates);
        guard.recordUniqueAdminCandidate(candidates.length);
        context.recordPrimaryOracle({
          id: 'DP003R-P2',
          name: 'Admin候选唯一',
          expected: 'candidateCount=1',
          actual: `candidateCount=${candidates.length}`,
          status: 'passed'
        });
        context.setBusinessData({
          candidateCount: candidates.length,
          adminStatusBefore: candidate.status,
          adminDepositStatus: candidate.status,
          fingerprintFields: [
            '测试用户', '香港账户', 'USD', '精确金额11.97', '待处理状态', 'Client创建时间窗口', '电汇渠道'
          ]
        });
        context.setActual('Admin业务指纹候选数严格等于1，未按第一条或最新一条选择');
        return candidate;
      }
    );

    const actualDepositAmount = await business.step(
      {
        action: '5. 打开Admin认领详情并再次核对现有申请',
        expected: '用户、香港账户、USD、原始11.97、实际入账金额、渠道、待处理状态和创建时间一致'
      },
      async context => {
        await claimDrawer.open(adminList, adminCandidate);
        const detail = await claimDrawer.readDetail();
        const originalAmount = new Decimal(detail.originalAmount);
        const claimAmount = new Decimal(detail.claimAmount);
        expect(originalAmount.equals(new Decimal(existing.amount))).toBe(true);
        expect(claimAmount.isFinite() && claimAmount.isPositive()).toBe(true);
        expect(detail.accountType).toContain(existing.accountType);
        expect(detail.channel).toContain(config.channel);
        expect(matchesDepositCustomerIdentity(detail.matchedCustomerText, config.adminUserIdentity)).toBe(true);
        expect(detail.submittedAtText).toContain(adminCandidate.submittedAtText);
        expect(adminCandidate.status).toBe('待处理');
        await claimDrawer.expectRequiredRemark();
        await claimDrawer.fillRemark(claimRemark);
        context.recordPrimaryOracle({
          id: 'DP003R-P3',
          name: 'Admin认领详情匹配',
          expected: '现有申请的用户、账户、币种、原始金额、渠道和时间全部一致',
          actual: '详情全部匹配，实际入账金额已从认领表单读取',
          status: 'passed'
        });
        context.setBusinessData({
          originalDepositAmount: originalAmount.toString(),
          actualDepositAmount: claimAmount.toString(),
          detailVerified: true
        });
        context.setActual('Admin详情全部匹配；实际入账金额使用页面当前值，未修改金额');
        return claimAmount;
      }
    );

    await business.step(
      {
        action: '6. Admin单次确认认领现有入金',
        expected: '确认认领只点击一次，不执行拒绝或第二次处理'
      },
      async context => {
        guard.assertAdminMutationAllowed(
          env.exchange.allowMoneyTests,
          env.allowAdminMutationTests
        );
        context.markPotentiallySubmitted();
        context.disallowSafeRerun();
        adminClaimClicked = true;
        try {
          await claimDrawer.confirmClaimOnce();
          expect(claimDrawer.confirmationClickCount()).toBe(1);
          context.setBusinessData({ claimConfirmationClicks: 1 });
          context.setActual('Admin确认认领点击1次；未执行第二次认领、拒绝或Client提交');
        } catch (error) {
          context.requireManualReview('Admin认领点击后结果不明确；只允许查询原申请，禁止再次认领');
          throw error;
        }
      }
    );

    let completedAdminRecord: AdminDepositCandidate | undefined;
    await business.step(
      {
        action: '7. 等待Admin原申请进入成功终态',
        expected: '原业务指纹仍唯一且状态进入处理完成'
      },
      async context => {
        let matching: AdminDepositCandidate[] = [];
        try {
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
            message: 'Admin original Deposit did not reach a readable successful terminal state.',
            timeout: 75_000
          }).toMatch(/处理完成|已完成|完成|completed/i);
        } catch (error) {
          context.requireManualReview('Admin认领已点击，但Admin终态无法确认');
          throw error;
        }
        completedAdminRecord = matching[0];
        context.recordPrimaryOracle({
          id: 'DP003R-P4',
          name: 'Admin认领成功终态',
          expected: '处理完成',
          actual: completedAdminRecord.status,
          status: 'passed'
        });
        context.setBusinessData({
          adminStatusAfter: completedAdminRecord.status,
          adminDepositStatus: completedAdminRecord.status
        });
        context.setActual(`Admin原申请最终状态=${completedAdminRecord.status}`);
      }
    );

    let completedClientRecord: DepositTransactionRecord | undefined;
    await business.step(
      {
        action: '8. Client按原系统TXN等待成功终态',
        expected: '原TXN不变，香港账户/USD/11.97记录进入已完成，不通过最新一条定位'
      },
      async context => {
        try {
          await expect.poll(async () => {
            await transactionsPage.goto(env.client.baseUrl!);
            await transactionsPage.selectDepositType();
            await transactionsPage.searchByBusinessId(clientRecord.record.ledgerTransactionId);
            completedClientRecord = await transactionsPage.depositRecordById(
              clientRecord.record.ledgerTransactionId
            );
            return completedClientRecord?.status ?? 'missing';
          }, {
            message: 'Client original Deposit TXN did not reach a completed terminal state.',
            timeout: 75_000
          }).toMatch(/completed|success|已完成|完成|成功/i);
        } catch (error) {
          context.requireManualReview('Admin已认领，但Client原系统TXN终态无法确认');
          throw error;
        }
        expect(completedClientRecord?.ledgerTransactionId).toBe(
          clientRecord.record.ledgerTransactionId
        );
        expect(completedClientRecord?.accountType).toBe(existing.accountType);
        expect(completedClientRecord?.currency).toBe(existing.currency);
        expect(new Decimal(completedClientRecord!.requestedAmount).equals(existing.amount)).toBe(true);

        const finalDetail = await (
          await transactionsPage.openDepositDetail(completedClientRecord!)
        ).readFiatDepositDetail();
        expect(finalDetail.displayedTransactionNumber).toBe(clientRecord.wireReferenceId);
        context.recordPrimaryOracle({
          id: 'DP003R-P5',
          name: 'Client原系统TXN进入成功终态',
          expected: '同一TXN状态已完成，wireReferenceId保持一致',
          actual: completedClientRecord!.status,
          status: 'passed'
        });
        context.setBusinessData({
          clientDepositStatus: completedClientRecord!.status,
          clientFinalStatus: completedClientRecord!.status,
          wireReferenceId: finalDetail.displayedTransactionNumber,
          terminalState: true
        });
        context.setActual('Client原系统TXN已完成，账户、币种、金额和电汇指令参考号均保持一致');
      }
    );

    await business.step(
      {
        action: '9. 核对认领后香港账户USD余额',
        expected: 'afterBalance = 1.07 + Admin实际入账金额，actualIncrease与实际入账金额严格相等'
      },
      async context => {
        const expectedBalance = expectedDepositBalanceAfterClaim(
          balanceBefore,
          actualDepositAmount
        );
        let balanceAfter = balanceBefore;
        await expect.poll(async () => {
          await accountPage.goto(env.client.baseUrl!);
          balanceAfter = (await accountPage.readBalance({
            accountType: existing.accountType,
            currency: existing.currency
          })).availableBalance;
          return balanceAfter.toString();
        }, {
          message: 'Hong Kong USD balance did not increase by actualDepositAmount.',
          timeout: 75_000
        }).toBe(expectedBalance.toString());
        const actualIncrease = balanceAfter.minus(balanceBefore);
        expect(actualIncrease.equals(actualDepositAmount)).toBe(true);
        context.recordPrimaryOracle({
          id: 'DP003R-P6',
          name: '香港账户USD余额准确增加实际入账金额',
          expected: expectedBalance.toString(),
          actual: balanceAfter.toString(),
          status: 'passed'
        });
        context.setBusinessData({
          depositBalanceAfter: balanceAfter.toString(),
          actualBalanceIncrease: actualIncrease.toString(),
          balanceOracle: `${balanceBefore.toString()} + ${actualDepositAmount.toString()} = ${balanceAfter.toString()}`,
          finalStatus: completedClientRecord!.status,
          confirmed: true,
          noNewDepositCreated: true
        });
        context.setActual('余额Primary Oracle通过；实际增加金额与Admin实际入账金额完全一致');
      }
    );

    await business.step(
      {
        action: '10. 记录Secondary Oracle结果',
        expected: '全局流水核心记录已用于原TXN终态验证；未执行邮件等非核心外部检查'
      },
      async context => {
        context.recordSecondaryOracle({
          id: 'DP003R-S1',
          name: 'Client交易详情辅助字段一致',
          expected: 'wireReferenceId在认领前后保持一致',
          actual: '一致',
          status: 'passed'
        });
        context.setActual('交易详情辅助字段一致；邮件等非核心外部展示不纳入本次阻塞条件');
      }
    );

    expect(adminClaimClicked).toBe(true);
    expect(claimDrawer.confirmationClickCount()).toBe(1);
    expect(completedAdminRecord).toBeTruthy();
    expect(completedClientRecord).toBeTruthy();
    testInfo.annotations.push({
      type: 'no-auto-rerun',
      description: '现有DP-003已认领；禁止再次运行Resume、再次认领或创建第二笔入金'
    });
  }
);
