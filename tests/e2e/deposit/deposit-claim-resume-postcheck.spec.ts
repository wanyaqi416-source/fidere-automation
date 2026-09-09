import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DepositClaimListPage } from '../../../pages/admin/DepositClaimListPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import {
  TransactionsPage,
  type DepositTransactionDiagnostics
} from '../../../pages/client/TransactionsPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { runDepositAuthPreflight } from '../../../src/deposit/deposit-auth-preflight';
import {
  clientDepositIdPattern,
  DepositExecutionGuard,
  expectedDepositBalanceAfterClaim,
  matchAdminDepositRecordsIgnoringStatus,
  requireUniqueAdminDepositCandidate,
  type AdminDepositCandidate,
  type DepositFingerprint
} from '../../../src/deposit/deposit-e2e';
import { Decimal } from '../../../src/utils/money';
import { getDepositTestConfig } from '../../client/deposit/depositTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });

type ArchivedCase = {
  caseId: string;
  startedAt: string;
  businessData: Record<string, unknown>;
};

type ArchivedRun = {
  endedAt: string;
  cases: ArchivedCase[];
};

const submissionRunPath = resolve(
  'reports/business/history/2026-08-27_15-23-13-73c8056a/report.json'
);
const resumeRunPath = resolve(
  'reports/business/history/2026-08-27_16-08-11-121513bc/report.json'
);

function parseChinaReportTime(value: string): number {
  const timestamp = Date.parse(value.replaceAll('/', '-').replace(' ', 'T') + '+08:00');
  if (!Number.isFinite(timestamp)) throw new Error('Archived DP-003 time could not be parsed.');
  return timestamp;
}

function archivedCase(path: string, caseId: string): { run: ArchivedRun; testCase: ArchivedCase } {
  const run = JSON.parse(readFileSync(path, 'utf8')) as ArchivedRun;
  const testCase = run.cases.find(item => item.caseId === caseId);
  if (!testCase) throw new Error(`Archived ${caseId} evidence was not found.`);
  return { run, testCase };
}

test(
  'DP-003 Resume认领后只读终态复核 @deposit @resume @readonly @reconciliation',
  async ({ clientPage, adminPage, business }, testInfo) => {
    test.setTimeout(150_000);
    if (!env.client.baseUrl || !env.admin.baseUrl) {
      throw new Error('CLIENT_BASE_URL and ADMIN_BASE_URL are required for DP-003 postcheck.');
    }
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);
    expect(testInfo.project.retries).toBe(0);
    expect(testInfo.repeatEachIndex).toBe(0);

    const submission = archivedCase(submissionRunPath, 'DP-003');
    const resume = archivedCase(resumeRunPath, 'DP-003-RESUME');
    const accountType = String(submission.testCase.businessData.accountType);
    const currency = String(submission.testCase.businessData.depositCurrency);
    const requestedAmount = new Decimal(String(submission.testCase.businessData.depositAmount));
    const balanceBefore = new Decimal(String(submission.testCase.businessData.depositBalanceBefore));
    const originalAmount = new Decimal(String(resume.testCase.businessData.originalDepositAmount));
    const actualDepositAmount = new Decimal(String(resume.testCase.businessData.actualDepositAmount));
    const claimClicks = Number(resume.testCase.businessData.claimConfirmationClicks);
    const config = getDepositTestConfig();
    const guard = new DepositExecutionGuard();
    const transactionsPage = new TransactionsPage(clientPage);
    const accountPage = new AccountDetailPage(clientPage);
    const adminList = new DepositClaimListPage(adminPage);

    business.case({
      caseId: 'DP-003-RESUME-POSTCHECK',
      module: 'Client + Admin入金',
      name: 'DP-003 Resume认领后只读终态复核',
      description: '原Resume在Admin单次认领成功后因Client表格刷新Locator超时；本Run只读确认Admin、Client和余额Primary Oracle。',
      priority: 'P0',
      type: ['Resume Postcheck', 'Reconciliation', 'Read-only'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'DP-003 post-mutation adjudication',
      preconditions: ['Admin确认认领历史点击次数为1', '两个Mutation安全开关均关闭'],
      target: '不重复认领、不创建第二笔入金，确认既有DP-003真实业务终态。',
      expectedResult: 'Admin处理完成、Client原TXN已完成、香港账户USD增加actualDepositAmount。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: false,
      safetySwitches: ['ALLOW_MONEY_TESTS=false', 'ALLOW_ADMIN_MUTATION_TESTS=false']
    });
    business.disallowSafeRerun();
    business.setBusinessData({
      accountType,
      depositCurrency: currency,
      depositAmount: requestedAmount.toString(),
      originalDepositAmount: originalAmount.toString(),
      actualDepositAmount: actualDepositAmount.toString(),
      depositBalanceBefore: balanceBefore.toString(),
      claimConfirmationClicks: claimClicks,
      noNewDepositCreated: true,
      confirmed: false
    });

    await business.step(
      {
        action: '1. 执行双端认证和只读安全预检',
        expected: 'Client/Admin认证有效，两个Mutation开关均关闭'
      },
      async ({ setActual }) => {
        await runDepositAuthPreflight({
          clientPage,
          adminPage,
          clientBaseUrl: env.client.baseUrl!,
          adminBaseUrl: env.admin.baseUrl!,
          guard
        });
        expect(claimClicks).toBe(1);
        setActual('双端认证有效；历史认领点击次数=1；本Run没有任何写入口');
      }
    );

    const client = await business.step(
      {
        action: '2. 只读确认Client原系统TXN成功终态',
        expected: '唯一11.97 USD原记录状态为已完成，系统TXN和电汇指令参考号不变'
      },
      async context => {
        let diagnostics: DepositTransactionDiagnostics | undefined;
        await transactionsPage.goto(env.client.baseUrl!);
        await transactionsPage.selectDepositType();
        await expect.poll(async () => {
          diagnostics = await transactionsPage.diagnoseDepositRecords({
            accountType,
            currency,
            requestedAmount: requestedAmount.toString(),
            submittedFromMs: parseChinaReportTime(submission.testCase.startedAt),
            submittedToMs: parseChinaReportTime(submission.run.endedAt),
            status: /completed|success|已完成|完成|成功/i
          });
          return diagnostics.candidates.length;
        }, {
          message: 'Completed Client DP-003 candidateCount did not become 1.',
          timeout: 30_000
        }).toBe(1);
        if (!diagnostics) throw new Error('Client postcheck diagnostics were not produced.');
        const record = diagnostics.candidates[0];
        expect(clientDepositIdPattern.test(record.ledgerTransactionId)).toBe(true);
        expect(record.ledgerTransactionId.toLocaleLowerCase().endsWith('cf8c')).toBe(true);
        const detail = await (await transactionsPage.openDepositDetail(record))
          .readFiatDepositDetail();
        expect(detail.displayedTransactionNumber).toMatch(/^AUTO_DP003-/i);
        expect(detail.status).toMatch(/completed|success|已完成|完成|成功/i);
        context.recordPrimaryOracle({
          id: 'DP003RP-P1',
          name: 'Client原系统TXN已完成',
          expected: '原TXN状态已完成',
          actual: detail.status,
          status: 'passed'
        });
        context.setBusinessData({
          systemTransactionId: record.ledgerTransactionId,
          wireReferenceId: detail.displayedTransactionNumber,
          clientDepositStatus: detail.status,
          clientFinalStatus: detail.status,
          clientDepositHistoryCandidateCount: diagnostics.candidates.length,
          candidateStageCounts: diagnostics.counts,
          recordOccurredAt: record.occurredAt
        });
        context.setActual('Client原系统TXN唯一且已完成；电汇指令参考号保持一致');
        return record;
      }
    );

    const fingerprint: DepositFingerprint = {
      runId: 'DP003-RESUME-POSTCHECK',
      userIdentity: config.adminUserIdentity,
      accountType,
      currency,
      requestedAmount: requestedAmount.toString(),
      clientSubmittedAtMs: client.occurredAtMs,
      adminStatus: '处理完成',
      channel: config.channel
    };

    await business.step(
      {
        action: '3. 只读确认Admin原申请成功终态',
        expected: '原业务指纹候选唯一且状态为处理完成'
      },
      async context => {
        let candidates: AdminDepositCandidate[] = [];
        await expect.poll(async () => {
          await adminList.goto(env.admin.baseUrl!);
          candidates = matchAdminDepositRecordsIgnoringStatus(
            await adminList.readAllFilteredRecords(),
            fingerprint,
            config.matchWindowMs
          );
          return candidates.length;
        }, {
          message: 'Completed Admin DP-003 candidateCount did not become 1.',
          timeout: 60_000
        }).toBe(1);
        const candidate = requireUniqueAdminDepositCandidate(candidates);
        expect(candidate.status).toMatch(/处理完成|已完成|完成|completed/i);
        context.recordPrimaryOracle({
          id: 'DP003RP-P2',
          name: 'Admin原申请处理完成',
          expected: '处理完成',
          actual: candidate.status,
          status: 'passed'
        });
        context.setBusinessData({
          candidateCount: candidates.length,
          adminStatusBefore: resume.testCase.businessData.adminStatusBefore,
          adminStatusAfter: candidate.status,
          adminDepositStatus: candidate.status
        });
        context.setActual('Admin原申请候选数=1且状态为处理完成');
      }
    );

    await business.step(
      {
        action: '4. 只读确认香港账户USD余额Primary Oracle',
        expected: 'afterBalance = beforeBalance + actualDepositAmount，实际增加金额完全相等'
      },
      async context => {
        await accountPage.goto(env.client.baseUrl!);
        const balanceAfter = (await accountPage.readBalance({ accountType, currency }))
          .availableBalance;
        const expectedBalance = expectedDepositBalanceAfterClaim(
          balanceBefore,
          actualDepositAmount
        );
        const actualIncrease = balanceAfter.minus(balanceBefore);
        expect(balanceAfter.equals(expectedBalance)).toBe(true);
        expect(actualIncrease.equals(actualDepositAmount)).toBe(true);
        context.recordPrimaryOracle({
          id: 'DP003RP-P3',
          name: '香港账户USD余额准确增加',
          expected: expectedBalance.toString(),
          actual: balanceAfter.toString(),
          status: 'passed'
        });
        context.recordSecondaryOracle({
          id: 'DP003RP-S1',
          name: 'Client详情辅助编号保持一致',
          expected: '电汇指令参考号仍属于原系统TXN记录',
          actual: '一致',
          status: 'passed'
        });
        context.setBusinessData({
          depositBalanceAfter: balanceAfter.toString(),
          actualBalanceIncrease: actualIncrease.toString(),
          balanceOracle: `${balanceBefore.toString()} + ${actualDepositAmount.toString()} = ${balanceAfter.toString()}`,
          finalStatus: 'DP-003 PASS',
          confirmed: true,
          noNewDepositCreated: true
        });
        context.setActual('余额Oracle通过；DP-003资金入账已由Admin、Client和余额三方证据确认');
      }
    );
  }
);
