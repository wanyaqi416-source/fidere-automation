import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DepositClaimListPage } from '../../../pages/admin/DepositClaimListPage';
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
  diagnoseAdminDepositCandidates,
  matchAdminDepositCandidates,
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
  submittedFromMs: number;
  submittedToMs: number;
} {
  const run = JSON.parse(readFileSync(archivedRunPath, 'utf8')) as ArchivedRun;
  const testCase = run.cases.find(item => item.caseId === 'DP-003');
  if (!testCase) throw new Error('Archived DP-003 execution evidence was not found.');

  const accountType = String(testCase.businessData.accountType ?? '');
  const currency = String(testCase.businessData.depositCurrency ?? '');
  const amount = String(testCase.businessData.depositAmount ?? '');
  if (!accountType || !currency || !new Decimal(amount).isPositive()) {
    throw new Error('Archived DP-003 business fingerprint is incomplete.');
  }

  return {
    accountType,
    currency,
    amount,
    submittedFromMs: parseChinaReportTime(testCase.startedAt),
    submittedToMs: parseChinaReportTime(run.endedAt)
  };
}

test(
  'DP-003现有11.97 USD入金只读Reconciliation @e2e @deposit @readonly @reconciliation',
  async ({ clientPage, adminPage, business }, testInfo) => {
    test.setTimeout(120_000);
    if (!env.client.baseUrl || !env.admin.baseUrl) {
      throw new Error('CLIENT_BASE_URL and ADMIN_BASE_URL are required for DP-003 reconciliation.');
    }
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);
    expect(testInfo.project.retries).toBe(0);
    expect(testInfo.repeatEachIndex).toBe(0);

    const existing = loadExistingDp003();
    const config = getDepositTestConfig();
    const guard = new DepositExecutionGuard();
    const transactionsPage = new TransactionsPage(clientPage);
    const adminList = new DepositClaimListPage(adminPage);

    business.case({
      caseId: 'DP-003-RECON',
      module: 'Client + Admin入金',
      name: '现有11.97 USD入金续跑就绪只读复核',
      description: '只读定位已提交的DP-003入金，打开Client交易详情并确认系统TXN，再验证Admin待处理候选唯一。',
      priority: 'P0',
      type: ['Reconciliation', 'Read-only'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'DP-003 resume readiness',
      preconditions: ['现有11.97 USD入金已提交一次', '两个Mutation安全开关均关闭'],
      target: '确认现有业务可直接从Client TXN继续Admin认领，不创建第二笔申请。',
      expectedResult: 'Client入金候选唯一、详情可打开且系统TXN有效；Admin候选数严格为1。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: false,
      safetySwitches: ['ALLOW_MONEY_TESTS=false', 'ALLOW_ADMIN_MUTATION_TESTS=false']
    });
    business.setBusinessData({
      accountType: existing.accountType,
      depositCurrency: existing.currency,
      depositAmount: existing.amount,
      candidateCount: 0,
      dryRun: true,
      confirmed: false,
      noNewDepositCreated: true
    });

    await business.step(
      {
        action: '1. 执行双端认证和只读安全预检',
        expected: 'Client/Admin业务页可访问，两个写开关保持关闭'
      },
      async ({ setActual }) => {
        await runDepositAuthPreflight({
          clientPage,
          adminPage,
          clientBaseUrl: env.client.baseUrl!,
          adminBaseUrl: env.admin.baseUrl!,
          guard
        });
        expect(() => guard.assertClientSubmissionAllowed(false, false)).toThrow();
        setActual('Client/Admin认证有效；Client提交和Admin认领均被安全开关阻断');
      }
    );

    const clientRecord = await business.step(
      {
        action: '2. 按业务指纹逐层定位现有Client入金记录',
        expected: '入金类型、USD、11.97、执行时间窗口和香港账户逐层筛选后候选数为1'
      },
      async ({ setActual, setBusinessData }) => {
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
          message: 'Existing DP-003 Client Deposit candidateCount did not become 1.',
          timeout: 30_000
        }).toBe(1);
        if (!diagnostics) throw new Error('Client Deposit diagnostics were not produced.');
        test.info().annotations.push({
          type: 'client-deposit-candidate-stage-counts',
          description: JSON.stringify(diagnostics.counts)
        });
        setBusinessData({
          clientDepositHistoryCandidateCount: diagnostics.candidates.length,
          candidateStageCounts: diagnostics.counts,
          recordOccurredAt: diagnostics.candidates[0].occurredAt
        });
        setActual(`逐层候选数=${JSON.stringify(diagnostics.counts)}；最终candidateCount=1`);
        return diagnostics.candidates[0];
      }
    );

    const clientDetail = await business.step(
      {
        action: '3. 打开唯一入金记录的法币转入详情',
        expected: '详情抽屉打开，读取TXN系统编号、类型、账户、币种、金额、状态和创建日期'
      },
      async context => {
        const drawer = await transactionsPage.openDepositDetail(clientRecord);
        const detail = await drawer.readFiatDepositDetail();
        expect(clientDepositIdPattern.test(detail.ledgerTransactionId)).toBe(true);
        expect(detail.transactionType).toBe('法币转入');
        expect(detail.accountType).toBe(existing.accountType);
        expect(detail.currency).toBe(existing.currency);
        expect(new Decimal(detail.amount).equals(existing.amount)).toBe(true);
        expect(detail.status).toMatch(/待处理|处理中|pending|processing/i);
        context.recordPrimaryOracle({
          id: 'DP003-RECON-P1',
          name: 'Client唯一入金记录与系统TXN存在',
          expected: '唯一记录可打开详情且所选记录编号为TXN-*',
          actual: `详情已打开；系统编号=${detail.ledgerTransactionId}`,
          status: 'passed'
        });
        context.setBusinessData({
          depositOrderId: detail.ledgerTransactionId,
          clientDetailTransactionNumber: detail.displayedTransactionNumber,
          clientDepositStatus: detail.status,
          detailVerified: true
        });
        context.setActual('法币转入详情已打开；所选唯一流水的TXN、状态、金额、币种、账户和创建日期均已读取');
        return detail;
      }
    );

    await business.step(
      {
        action: '4. 只读查询Admin入账认领候选',
        expected: '测试用户、香港账户、USD、11.97、待处理状态和Client创建时间窗口候选数严格为1'
      },
      async context => {
        const fingerprint: DepositFingerprint = {
          runId: 'DP003-EXISTING-READONLY',
          userIdentity: config.adminUserIdentity,
          accountType: existing.accountType,
          currency: existing.currency,
          requestedAmount: existing.amount,
          clientSubmittedAtMs: clientRecord.occurredAtMs,
          adminStatus: '待处理',
          channel: config.channel
        };
        let records: AdminDepositCandidate[] = [];
        let candidates: AdminDepositCandidate[] = [];
        await expect.poll(async () => {
          await adminList.goto(env.admin.baseUrl!);
          await adminList.applyFilters({ status: '待处理', matchStatus: '已匹配' });
          records = await adminList.readAllFilteredRecords();
          candidates = matchAdminDepositCandidates(records, fingerprint, config.matchWindowMs);
          return candidates.length;
        }, {
          message: 'Existing DP-003 Admin Deposit candidateCount did not become 1.',
          timeout: 45_000
        }).toBe(1);
        const diagnostics = diagnoseAdminDepositCandidates(
          records,
          fingerprint,
          config.matchWindowMs
        );
        const candidate = requireUniqueAdminDepositCandidate(candidates);
        expect(candidate.accountType).toBe(existing.accountType);
        expect(candidate.currency).toBe(existing.currency);
        expect(new Decimal(candidate.requestedAmount).equals(existing.amount)).toBe(true);
        expect(candidate.status).toBe('待处理');
        context.recordPrimaryOracle({
          id: 'DP003-RECON-P2',
          name: 'Admin待处理候选唯一',
          expected: 'candidateCount=1',
          actual: `candidateCount=${candidates.length}`,
          status: 'passed'
        });
        context.setBusinessData({
          candidateCount: candidates.length,
          adminDepositStatus: candidate.status,
          existingDepositResume: 'DP-003 Resume Ready',
          fingerprintFields: [
            '测试用户', '香港账户', 'USD', '精确金额11.97', '待处理状态', 'Client交易创建时间窗口'
          ],
          finalStatus: 'DP-003 Resume Ready'
        });
        test.info().annotations.push({
          type: 'admin-deposit-candidate-stage-counts',
          description: JSON.stringify(diagnostics.counts)
        });
        context.setActual('Admin候选数严格等于1；本测试未打开认领动作、未认领、未拒绝');
      }
    );

    expect(clientDetail.ledgerTransactionId).toBe(clientRecord.ledgerTransactionId);
    testInfo.annotations.push({
      type: 'no-mutation',
      description: '复核现有DP-003；未创建第二笔入金，未执行Admin认领或拒绝'
    });
  }
);
