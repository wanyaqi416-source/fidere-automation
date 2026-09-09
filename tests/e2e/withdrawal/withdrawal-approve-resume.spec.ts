import { WithdrawalListPage } from '../../../pages/admin/WithdrawalListPage';
import type { WithdrawalApprovalPage } from '../../../pages/admin/WithdrawalApprovalPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { WithdrawalHistoryPage } from '../../../pages/client/WithdrawalHistoryPage';
import type { WithdrawalTransactionRecord } from '../../../pages/client/TransactionsPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { matchesDepositCustomerIdentity } from '../../../src/deposit/deposit-e2e';
import { runWithdrawalAuthPreflight } from '../../../src/withdrawal/withdrawal-auth-preflight';
import {
  WithdrawalExecutionGuard,
  buildWithdrawalApprovalNote,
  clientWithdrawalIdPattern,
  matchAdminWithdrawalRecordsIgnoringStatus,
  requireUniqueAdminWithdrawalCandidate,
  type AdminWithdrawalCandidate,
  type WithdrawalFingerprint
} from '../../../src/withdrawal/withdrawal-e2e';
import { validateWithdrawalProofAsset } from '../../../src/withdrawal/withdrawal-proof';
import { assertClientTestEnvironment } from '../../../src/utils/clientSafety';
import { Decimal } from '../../../src/utils/money';
import {
  getWithdrawalApprovalConfig,
  getWithdrawalTestConfig
} from '../../client/withdrawal/withdrawalTestSupport';

const PENDING_STATUS = /待处理|处理中|pending|processing/i;
const ADMIN_SUCCESS_STATUS = /处理完成|已完成|已批准|approved|completed/i;
const CLIENT_SUCCESS_STATUS = /已完成|完成|成功|completed|success/i;

test.describe.configure({ mode: 'serial', retries: 0 });
test.skip(
  !env.exchange.allowMoneyTests || !env.allowAdminMutationTests,
  'WD-003 Resume requires both mutation safety switches in this process.'
);

function requiredResumeValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for WD-003 Resume.`);
  return value;
}

function sortedIds(records: readonly WithdrawalTransactionRecord[]): string[] {
  return records.map(record => record.clientWithdrawalId).sort();
}

test(
  '续跑现有WD-003并完成Admin批准与Client终态验证',
  {
    tag: ['@e2e', '@withdrawal', '@mutation', '@money', '@resume'],
    annotation: [
      { type: 'caseId', description: 'WD-003-RESUME' },
      { type: 'module', description: 'Client + Admin出金' },
      { type: 'priority', description: 'P0' },
      { type: 'scope', description: 'Client + Admin' },
      { type: 'type', description: 'E2E / Mutation / Money / Resume' }
    ]
  },
  async ({ clientPage, adminPage, business }, testInfo) => {
    test.setTimeout(240_000);
    if (!env.client.baseUrl || !env.admin.baseUrl) {
      throw new Error('CLIENT_BASE_URL and ADMIN_BASE_URL are required for WD-003 Resume.');
    }

    assertClientTestEnvironment(env.client.baseUrl);
    expect(new URL(env.admin.baseUrl).hostname.toLocaleLowerCase()).toContain('sandbox');
    expect(testInfo.config.workers).toBe(1);
    expect(testInfo.project.retries).toBe(0);
    expect(testInfo.project.repeatEach).toBe(1);
    expect(testInfo.retry).toBe(0);
    expect(testInfo.repeatEachIndex).toBe(0);

    const config = getWithdrawalTestConfig();
    const approvalConfig = getWithdrawalApprovalConfig();
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
      throw new Error('WD-003 Resume parameters are invalid.');
    }

    const runId = `WD003-RESUME-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
    const approvalNote = buildWithdrawalApprovalNote(
      runId,
      approvalConfig.approvalNotePrefix
    );
    const proof = await validateWithdrawalProofAsset();
    const guard = new WithdrawalExecutionGuard();
    const accountPage = new AccountDetailPage(clientPage);
    const historyPage = new WithdrawalHistoryPage(clientPage);
    const adminList = new WithdrawalListPage(adminPage);
    let approval: WithdrawalApprovalPage;
    let approvalClicks = 0;

    business.case({
      caseId: 'WD-003-RESUME',
      module: 'Client + Admin出金',
      name: '续跑现有香港账户USD出金审核通过闭环',
      description: '不创建第二笔出金，复用已存在的Client TXN和已验证的Admin批准表单能力完成审核通过。',
      priority: 'P0',
      type: ['E2E', 'Mutation', 'Money', 'Resume'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'Resume existing WD-003 with the verified Withdrawal Approval Form',
      preconditions: [
        '现有Client TXN处于待处理',
        'Client和Admin认证有效',
        'Fidere Sandbox',
        '固定Sandbox打款凭证有效',
        '两个Mutation安全开关仅在本进程开启'
      ],
      target: '只批准现有唯一出金申请，并验证原TXN成功终态、最终余额和无第二笔申请。',
      expectedResult: '批准表单四项必填满足，Admin批准一次，原Client TXN完成，余额无二次扣减。',
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
      selectedPaymentChannel: approvalConfig.paymentChannel,
      selectedPaymentBank: approvalConfig.paymentBank,
      paymentProofFileName: proof.fileName,
      paymentProofType: 'Sandbox自动化测试凭证',
      paymentProofSizeBytes: proof.sizeBytes,
      approvalNote,
      candidateCount: 0,
      approvalClicks: 0,
      noNewWithdrawalCreated: true,
      confirmed: false
    });

    await business.step(
      {
        action: '1. 执行Sandbox、双端认证和Resume安全预检',
        expected: 'Client和Admin业务页有效；固定凭证已验证；本用例不进入Client出金提交页'
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
        setActual(`双端认证有效；固定测试凭证${proof.fileName}已通过本地格式和大小校验。`);
      }
    );

    await historyPage.goto(env.client.baseUrl);
    const clientIdsBefore = sortedIds(await historyPage.readRecords());

    const clientRecord = await business.step(
      {
        action: '2. 按业务指纹恢复唯一原Client TXN并核对当前余额',
        expected: '唯一待处理TXN尾号正确；香港账户USD余额仍等于原申请提交后的基线'
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

        await accountPage.goto(env.client.baseUrl!);
        const current = await accountPage.readAvailableBalance(config.accountType, config.currency);
        expect(current.availableBalance.equals(submittedBalance)).toBe(true);
        context.disallowSafeRerun();
        context.recordPrimaryOracle({
          id: 'WD003R-P1',
          name: '原Client TXN唯一存在且待处理余额稳定',
          expected: '唯一原TXN；当前余额等于提交后基线',
          actual: `${record.clientWithdrawalId}；余额=${current.availableBalance.toString()}`,
          status: 'passed'
        });
        context.setBusinessData({
          withdrawalOrderId: record.clientWithdrawalId,
          clientWithdrawalCandidateCount: diagnostics.candidates.length,
          clientCandidateStageCounts: diagnostics.counts,
          clientWithdrawalStatus: record.status,
          recordOccurredAt: record.occurredAt
        });
        context.setActual('原Client TXN候选数=1，且批准前余额仍为原提交后的已记录值。');
        return record;
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

    await business.step(
      {
        action: '3. 使用客户邮箱唯一定位Admin记录并二次核对详情',
        expected: '账户、USD、精确金额、待处理状态和时间窗口候选数=1；详情客户、收款人、用途和手续费一致'
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
        requireUniqueAdminWithdrawalCandidate(diagnostics.candidates);
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
        approval = detailPage.approvalForm();
        await approval.waitForOpen();

        context.recordPrimaryOracle({
          id: 'WD003R-P2',
          name: 'Admin候选唯一且详情匹配',
          expected: 'candidateCount=1且核心详情字段一致',
          actual: 'candidateCount=1且核心详情字段全部一致',
          status: 'passed'
        });
        context.setBusinessData({
          candidateCount: diagnostics.candidates.length,
          candidateStageCounts: diagnostics.counts,
          detailVerified: true,
          adminTransactionId: detail.adminTransactionId ?? '页面未提供独立Admin编号',
          adminStatusBefore: detail.status
        });
        context.setActual('Admin配置邮箱搜索和完整业务指纹唯一；收款人仅在详情中核对并通过。');
      }
    );

    await business.step(
      {
        action: '4. 复用WithdrawalApprovalPage填充全部批准必填项',
        expected: '调用fillApprovalForm后渠道、银行、固定凭证和审批备注全部满足，批准按钮可用'
      },
      async context => {
        await approval.fillApprovalForm({
          paymentChannel: approvalConfig.paymentChannel,
          paymentBank: approvalConfig.paymentBank,
          proof,
          approvalNote
        });
        await approval.assertRequiredFieldsSatisfied({
          paymentChannel: approvalConfig.paymentChannel,
          paymentBank: approvalConfig.paymentBank,
          proofFileName: proof.fileName,
          approvalNote
        });
        expect(approval.approvalClicks()).toBe(0);
        context.setBusinessData({
          paymentProofUploaded: true,
          approvalNoteFilled: true,
          requiredApprovalFieldsSatisfied: true,
          approvalButtonEnabled: true
        });
        context.setActual('fillApprovalForm已复用既有渠道、银行、上传和备注能力；四项必填通过，批准按钮可用。');
      }
    );

    try {
      await business.step(
        {
          action: '5. Admin单次批准现有唯一出金申请',
          expected: '最终批准按钮只点击一次；不重新提交Client，不创建第二笔Withdrawal'
        },
        async context => {
          guard.assertAdminMutationAllowed(
            env.exchange.allowMoneyTests,
            env.allowAdminMutationTests
          );
          context.markPotentiallySubmitted();
          context.disallowSafeRerun();
          await approval.confirmApprove();
          approvalClicks = approval.approvalClicks();
          expect(approvalClicks).toBe(1);
          context.setBusinessData({ approvalClicks, mutationPerformed: true });
          context.setActual('Admin最终批准点击1次；Client提交点击0次。');
        }
      );

      let approvedAdminRecord: AdminWithdrawalCandidate | undefined;
      await business.step(
        {
          action: '6. 等待Admin原记录进入成功终态',
          expected: '不再次点击批准，按同一业务指纹只读查询原记录并得到处理完成/已批准终态'
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
            approvedAdminRecord = matches.length === 1 ? matches[0] : undefined;
            return matches.length === 1 ? matches[0].status : `candidateCount=${matches.length}`;
          }, {
            message: 'Existing Admin Withdrawal did not reach a successful terminal state.',
            timeout: 90_000
          }).toMatch(ADMIN_SUCCESS_STATUS);
          context.recordPrimaryOracle({
            id: 'WD003R-P3',
            name: 'Admin批准成功且只执行一次',
            expected: '原Admin记录进入成功终态，点击次数=1',
            actual: `${approvedAdminRecord!.status}；点击次数=1`,
            status: 'passed'
          });
          context.setBusinessData({ adminStatusAfter: approvedAdminRecord!.status });
          context.setActual(`Admin原记录最终状态为${approvedAdminRecord!.status}。`);
        }
      );

      let completedClientRecord: WithdrawalTransactionRecord | undefined;
      await business.step(
        {
          action: '7. 按原TXN等待Client成功终态',
          expected: '原TXN编号不变，账户、USD和金额不变，并进入已完成终态'
        },
        async context => {
          await expect.poll(async () => {
            await historyPage.goto(env.client.baseUrl!);
            await historyPage.transactions.searchByBusinessId(clientRecord.clientWithdrawalId);
            completedClientRecord = await historyPage.recordById(clientRecord.clientWithdrawalId);
            return completedClientRecord?.status ?? 'missing';
          }, {
            message: 'Original Client Withdrawal TXN did not reach a successful terminal state.',
            timeout: 120_000
          }).toMatch(CLIENT_SUCCESS_STATUS);
          expect(completedClientRecord?.clientWithdrawalId).toBe(clientRecord.clientWithdrawalId);
          expect(completedClientRecord?.accountType).toBe(config.accountType);
          expect(completedClientRecord?.currency).toBe(config.currency);
          expect(new Decimal(completedClientRecord!.requestedAmount).equals(amount)).toBe(true);
          context.recordPrimaryOracle({
            id: 'WD003R-P4',
            name: '原Client TXN进入成功终态',
            expected: '原TXN不变且状态已完成',
            actual: completedClientRecord!.status,
            status: 'passed'
          });
          context.setBusinessData({
            clientWithdrawalStatus: completedClientRecord!.status,
            terminalState: true
          });
          context.setActual('Client按原TXN读取到成功终态。');
        }
      );

      await business.step(
        {
          action: '8. 验证最终余额且没有第二笔Withdrawal',
          expected: '批准后可用余额保持提交后基线，不发生二次扣减；Client TXN集合未新增'
        },
        async context => {
          await accountPage.goto(env.client.baseUrl!);
          const after = await accountPage.readAvailableBalance(config.accountType, config.currency);
          expect(after.availableBalance.equals(submittedBalance)).toBe(true);

          await historyPage.goto(env.client.baseUrl!);
          const recordsAfter = await historyPage.readRecords();
          expect(sortedIds(recordsAfter)).toEqual(clientIdsBefore);
          context.recordPrimaryOracle({
            id: 'WD003R-P5',
            name: '批准后余额无二次扣减',
            expected: submittedBalance.toString(),
            actual: after.availableBalance.toString(),
            status: 'passed'
          });
          context.recordPrimaryOracle({
            id: 'WD003R-P6',
            name: '没有创建第二笔出金申请',
            expected: 'Resume前后Client TXN集合一致',
            actual: 'Client TXN集合未新增',
            status: 'passed'
          });
          context.setBusinessData({
            afterApprovedAvailableBalance: after.availableBalance.toString(),
            actualDebitAmount: baselineBalance.minus(after.availableBalance).toString(),
            noNewWithdrawalCreated: true,
            finalStatus: completedClientRecord!.status,
            confirmed: true
          });
          context.setActual('最终余额等于原提交后余额，没有再次扣款；Client TXN集合未新增。');
        }
      );
    } catch (error) {
      if (approvalClicks === 1) {
        business.requireManualReview('现有Admin出金状态、原Client TXN和香港账户USD余额');
        business.disallowSafeRerun();
      }
      throw error;
    }

    expect(approvalClicks).toBe(1);
    testInfo.annotations.push({
      type: 'no-auto-rerun',
      description: `runId=${runId}；仅Resume原TXN，Client提交点击0次。`
    });
  }
);
