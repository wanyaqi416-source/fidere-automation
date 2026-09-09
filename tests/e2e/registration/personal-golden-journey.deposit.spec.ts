import { AdminFiatAccountReviewPage } from '../../../pages/admin/AdminFiatAccountReviewPage';
import { DepositClaimDrawer } from '../../../pages/admin/DepositClaimDrawer';
import { DepositClaimListPage } from '../../../pages/admin/DepositClaimListPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { DepositPage } from '../../../pages/client/DepositPage';
import {
  TransactionsPage,
  type DepositTransactionDiagnostics,
  type DepositTransactionRecord
} from '../../../pages/client/TransactionsPage';
import { expect, test } from '../../../fixtures/registration.fixture';
import { env } from '../../../src/config/env';
import { runDepositAuthPreflight } from '../../../src/deposit/deposit-auth-preflight';
import {
  buildDepositApprovalRemark,
  DepositExecutionGuard,
  deriveUniqueDepositAmount,
  diagnoseAdminDepositCandidates,
  expectedDepositBalanceAfterClaim,
  matchAdminDepositCandidates,
  matchAdminDepositRecordsIgnoringStatus,
  matchesDepositCustomerIdentity,
  requireUniqueAdminDepositCandidate,
  type AdminDepositCandidate,
  type DepositFingerprint
} from '../../../src/deposit/deposit-e2e';
import {
  PersonalPostRegistrationJourneyStore,
  postRegistrationStageAtLeast
} from '../../../src/journey';
import {
  maskRegistrationEmail,
  openPersonalJourneyClientSession,
  PersonalJourneyContextStore
} from '../../../src/registration';
import { Decimal } from '../../../src/utils/money';
import {
  getDepositReconciliationConfig,
  getDepositTestConfig
} from '../../client/deposit/depositTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });
test.skip(
  !env.exchange.allowMoneyTests ||
    !env.allowAdminMutationTests ||
    !env.allowClientMutationTests,
  'Personal Golden Journey Deposit requires all three mutation switches.'
);

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for the Personal Golden Journey Deposit.`);
  return value;
}

function successfulStatus(value: string): boolean {
  return /处理完成|已完成|完成|成功|completed|success/i.test(value);
}

test(
  'Personal Golden Journey真实USD入金并由Admin认领',
  {
    tag: ['@journey', '@personal', '@deposit', '@resume', '@mutation', '@money', '@L4'],
    annotation: [
      { type: 'caseId', description: 'PERSONAL-GJ-DEPOSIT' },
      { type: 'changesData', description: 'true' },
      { type: 'affectsMoney', description: 'true' }
    ]
  },
  async ({ browser, adminPage, business }, testInfo) => {
    test.setTimeout(6 * 60 * 1000);
    const clientBaseUrl = required('CLIENT_BASE_URL', env.client.baseUrl);
    const adminBaseUrl = required('ADMIN_BASE_URL', env.admin.baseUrl);
    expect(new URL(clientBaseUrl).hostname.toLocaleLowerCase()).toMatch(/sandbox|staging|\.test$|localhost/);
    expect(new URL(adminBaseUrl).hostname.toLocaleLowerCase()).toMatch(/sandbox|staging|\.test$|localhost/);
    expect(testInfo.config.workers).toBe(1);
    expect(testInfo.project.retries).toBe(0);
    expect(testInfo.project.repeatEach).toBe(1);
    expect(testInfo.retry).toBe(0);
    expect(testInfo.repeatEachIndex).toBe(0);

    const sourceRunId = env.personalRegistration.adminApprovalSourceRunId ?? 'REGP-20260904020924';
    const source = new PersonalJourneyContextStore().load(sourceRunId);
    if (!source?.displayName || !source.sequence) {
      throw new Error('The approved Personal Journey source user is incomplete.');
    }

    const store = new PersonalPostRegistrationJourneyStore(sourceRunId);
    const initialState = store.load();
    if (!initialState || !postRegistrationStageAtLeast(initialState.stage, 'FIAT_ADDRESS_APPROVED')) {
      throw new Error('The source Personal user has not reached FIAT_ADDRESS_APPROVED.');
    }
    let state = initialState;

    const config = getDepositTestConfig();
    const pendingAdminStatus = getDepositReconciliationConfig().adminStatus;
    const depositChannel = config.channel === '电汇' ? 'SWIFT' : config.channel;
    const depositSourceOfFunds = config.sourceOfFunds === '工资'
      ? '工资及薪酬收入'
      : config.sourceOfFunds;
    const runId = `PGJ-DP-${sourceRunId}`;
    const amount = state.depositAmount
      ? new Decimal(state.depositAmount)
      : deriveUniqueDepositAmount(runId, config.uniqueAmountBase, config.amountPrecision);
    if (!amount.isFinite() || !amount.isPositive()) {
      throw new Error('Personal Golden Journey Deposit amount is invalid.');
    }
    const displayedAmount = amount.toFixed(config.amountPrecision);
    const reference = `AUTO_${runId}`;
    const claimRemark = buildDepositApprovalRemark(runId);
    const accountNumber = `88000000${String(source.sequence).padStart(4, '0')}`;
    const bankName = `FIDERE SANDBOX BANK ${source.displayName.split(' ').at(-1)}`;
    const guard = new DepositExecutionGuard();

    business.case({
      caseId: 'PERSONAL-GJ-DEPOSIT',
      module: 'Fresh Personal Golden Journey',
      name: '真实USD入金并由Admin认领',
      description: '同一已完成KYC及法币地址审核的Personal用户提交唯一11.xx USD入金，Admin唯一定位并认领，Client按原TXN和余额验证。',
      priority: 'P0',
      type: ['E2E', 'Mutation', 'Money', 'Resume'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'Fresh User balance-ready Deposit journey',
      preconditions: ['Personal KYC已通过', '法币银行地址Admin已通过', 'Client和Admin认证有效', 'Sandbox Mutation开关显式开启'],
      target: 'Deposit Submitted -> Admin Deposit Approved -> Balance Ready',
      expectedResult: 'Admin唯一确认并认领原申请，USD余额严格增加本次入金金额；Client流水如展示则读取真实TXN。',
      changesData: true,
      affectsMoney: true,
      dependsOnAdmin: true,
      dependsOnThirdParty: false,
      safetySwitches: ['ALLOW_CLIENT_MUTATION_TESTS', 'ALLOW_MONEY_TESTS', 'ALLOW_ADMIN_MUTATION_TESTS']
    });
    business.disallowSafeRerun();
    business.setBusinessData({
      journeyId: state.journeyId,
      sourceRunId,
      user: source.displayName,
      email: maskRegistrationEmail(source.email),
      accountType: config.accountType,
      currency: config.currency,
      depositAmount: displayedAmount,
      depositChannel,
      depositPurpose: config.purpose,
      depositSourceOfFunds,
      depositTransferMethod: config.transferMethod,
      bankAccountSuffix: `****${accountNumber.slice(-4)}`,
      resumeStartStage: state.stage,
      clientSubmitCount: state.depositSubmitCount,
      adminApproveCount: state.depositApproveCount,
      confirmed: false
    });

    const client = await openPersonalJourneyClientSession({
      browser,
      baseURL: clientBaseUrl,
      runId: sourceRunId,
      email: source.email,
      password: required('CLIENT_PASSWORD', env.client.password),
      otp: required('CLIENT_OTP', env.client.otp)
    });
    const accountPage = new AccountDetailPage(client.page);
    const depositPage = new DepositPage(client.page);
    const transactionsPage = new TransactionsPage(client.page);
    const adminList = new DepositClaimListPage(adminPage);
    const claimDrawer = new DepositClaimDrawer(adminPage);
    const adminFiatAccounts = new AdminFiatAccountReviewPage(adminPage);
    let previousIds = new Set<string>();
    let adminCandidateCount = 0;

    try {
      await business.step(
        {
          action: '1. 双端认证、Sandbox与法币地址前置检查',
          expected: 'Client/Admin认证有效；Admin按邮箱唯一找到已通过银行地址；全部Mutation约束满足。'
        },
        async context => {
          await runDepositAuthPreflight({
            clientPage: client.page,
            adminPage,
            clientBaseUrl,
            adminBaseUrl,
            guard
          });
          expect(env.allowClientMutationTests).toBe(true);
          const approved = await (async () => {
            await adminFiatAccounts.goto(adminBaseUrl, '已通过');
            return adminFiatAccounts.locateCandidate({
              email: source.email,
              displayName: source.displayName!,
              bankName,
              bankAccount: accountNumber
            });
          })();
          expect(approved.candidateCount).toBe(1);
          context.recordPrimaryOracle({
            id: 'PGJ-DP-P0',
            name: '法币银行地址Admin已通过',
            expected: 'candidateCount=1且状态为已通过',
            actual: 'candidateCount=1',
            status: 'passed'
          });
          context.setActual('双端认证有效，Admin按本次用户邮箱和银行账户唯一确认法币地址已通过；Client绿色标签不是阻塞条件。');
        }
      );

      const balanceBefore = await business.step(
        {
          action: '2. 读取香港账户USD入金前余额',
          expected: '唯一读取香港账户USD可用余额并固化为余额Oracle基线。'
        },
        async context => {
          const persisted = state.balanceBefore ? new Decimal(state.balanceBefore) : undefined;
          if (persisted) {
            context.setActual('Resume使用首次提交前已持久化的香港账户USD余额。');
            return persisted;
          }
          await accountPage.goto(clientBaseUrl);
          const balance = await accountPage.readBalance({
            accountType: config.accountType,
            currency: config.currency
          });
          context.setBusinessData({ depositBalanceBefore: balance.availableBalance.toString() });
          context.setActual('已读取香港账户USD入金前可用余额。');
          return balance.availableBalance;
        }
      );

      if (!postRegistrationStageAtLeast(state.stage, 'DEPOSIT_SUBMISSION_ATTEMPTED')) {
        await business.step(
          {
            action: '3. 检查唯一金额不与Client历史或Admin待处理记录冲突',
            expected: '同一用户、账户、USD和精确11.xx金额的历史/待处理冲突均为0。'
          },
          async context => {
            await transactionsPage.goto(clientBaseUrl);
            await transactionsPage.selectDepositType();
            const previousRecords = await transactionsPage.readVisibleDepositRecords();
            previousIds = new Set(previousRecords.map(record => record.ledgerTransactionId));
            expect(previousRecords.some(record =>
              record.currency.toUpperCase() === config.currency &&
              new Decimal(record.requestedAmount).equals(amount)
            )).toBe(false);

            await adminList.goto(adminBaseUrl);
            await adminList.applyFilters({ status: pendingAdminStatus, matchStatus: '已匹配' });
            const prospective: DepositFingerprint = {
              runId,
              userIdentity: source.displayName!,
              accountType: config.accountType,
              currency: config.currency,
              requestedAmount: displayedAmount,
              clientSubmittedAtMs: Date.now(),
              adminStatus: pendingAdminStatus,
              channel: depositChannel
            };
            const conflicts = matchAdminDepositCandidates(
              await adminList.readAllFilteredRecords(),
              prospective,
              config.matchWindowMs,
              { applyTimeWindow: false }
            );
            expect(conflicts).toHaveLength(0);
            context.setActual('Client历史同金额冲突=0；Admin同用户同金额待处理冲突=0。');
          }
        );
      }

      let submittedAtMs = state.depositSubmittedAt
        ? Date.parse(state.depositSubmittedAt)
        : Number.NaN;
      if (!postRegistrationStageAtLeast(state.stage, 'DEPOSIT_SUBMISSION_ATTEMPTED')) {
        await business.step(
          {
            action: '4. 填写并单次提交Client银行电汇入金',
            expected: '使用已批准银行地址、香港账户、USD及唯一金额；Submit只点击1次。'
          },
          async context => {
            await depositPage.goto(clientBaseUrl);
            await depositPage.selectAccount(config.accountType);
            await depositPage.selectCurrency(config.currencyLabel);
            const selectedBank = await depositPage.selectPayingBank(
              bankName,
              accountNumber.slice(-4)
            );
            await depositPage.fillAmount(displayedAmount);
            await depositPage.selectChannel(depositChannel);
            await depositPage.selectPurpose(config.purpose);
            await depositPage.selectSourceOfFunds(depositSourceOfFunds);
            await depositPage.selectTransferMethod(config.transferMethod);
            const supportingDocument = await depositPage.uploadSupportingDocument(
              config.supportingDocumentPath
            );
            await depositPage.fillReference(reference);
            const snapshot = await depositPage.readFormSnapshot();
            expect(new Decimal(snapshot.amount).equals(amount)).toBe(true);
            expect(snapshot.submitEnabled).toBe(true);

            guard.assertClientSubmissionAllowed(
              env.exchange.allowMoneyTests,
              env.allowAdminMutationTests
            );
            submittedAtMs = Date.now();
            state = store.recordDepositSubmissionAttempt(state, {
              amount: displayedAmount,
              balanceBefore: balanceBefore.toString(),
              submittedAt: new Date(submittedAtMs).toISOString()
            });
            context.markPotentiallySubmitted();
            context.disallowSafeRerun();
            business.markMutationPerformed('Client Deposit Submit');
            let submission;
            try {
              submission = await depositPage.submitOnce();
            } catch (error) {
              context.requireManualReview('DEPOSIT_SUBMISSION_UNCONFIRMED');
              throw error;
            }
            expect(depositPage.submissionClicks()).toBe(1);
            context.setBusinessData({
              selectedPayingBank: selectedBank,
              clientSubmitCount: state.depositSubmitCount,
              clientRequestPath: submission.requestPath,
              clientHttpStatus: submission.httpStatus,
              depositTransferMethod: config.transferMethod,
              supportingDocument,
              submittedAt: state.depositSubmittedAt,
              resumeStage: state.stage
            });
            context.setActual(`Client已选择${config.transferMethod}并上传Sandbox支持性文件；Submit点击1次；${submission.requestPath}返回HTTP ${submission.httpStatus}。`);
          }
        );
      }

      if (!Number.isFinite(submittedAtMs)) {
        throw new Error('Persisted Deposit submission time is invalid.');
      }

      let clientRecord = await business.step(
        {
          action: '5. 只读检查认领前Client入金流水',
          expected: '如Client已展示本次入金，则唯一定位并从详情读取TXN；待认领阶段尚未展示时记录Diagnostic并继续Admin业务确认。'
        },
        async context => {
          let record: DepositTransactionRecord | undefined;
          let diagnostics: DepositTransactionDiagnostics | undefined;
          let candidateCount = 0;
          const clientRecordVisible = await expect.poll(async () => {
            await transactionsPage.goto(clientBaseUrl);
            await transactionsPage.selectDepositType();
            if (state.depositTransactionId) {
              await transactionsPage.searchByBusinessId(state.depositTransactionId);
              record = await transactionsPage.depositRecordById(state.depositTransactionId);
              candidateCount = record ? 1 : 0;
              return candidateCount;
            }
            diagnostics = await transactionsPage.diagnoseDepositRecords({
              accountType: config.accountType,
              currency: config.currency,
              requestedAmount: displayedAmount,
              submittedFromMs: submittedAtMs - config.matchWindowMs,
              submittedToMs: Date.now() + config.matchWindowMs,
              status: /待处理|处理中|pending|processing/i,
              excludedLedgerTransactionIds: previousIds
            });
            record = diagnostics.candidates[0];
            candidateCount = diagnostics.candidates.length;
            return candidateCount;
          }, {
            timeout: 12_000,
            intervals: [1_000, 2_000, 3_000],
            message: 'Client has not exposed the pending Deposit in global transactions yet.'
          }).toBe(1).then(() => true, error => {
            if (candidateCount > 1) throw error;
            return false;
          });
          if (!clientRecordVisible || !record) {
            context.recordDiagnostic({
              id: 'PGJ-DP-D1',
              name: '认领前Client全局入金流水',
              status: 'info',
              summary: 'candidateCount=0；待认领阶段未展示，不作为创建失败结论。',
              reason: '由Admin唯一候选和详情确认原申请已创建。',
              affectsCoreBusiness: false
            });
            context.setBusinessData({
              clientPreClaimCandidateCount: candidateCount,
              clientPreClaimTransactionVisible: false
            });
            context.setActual('认领前Client全局交易流水未展示本次入金；已记录Diagnostic，未重新提交。');
            return undefined;
          }
          const detail = await (await transactionsPage.openDepositDetail(record)).readFiatDepositDetail();
          expect(detail.ledgerTransactionId).toBe(record.ledgerTransactionId);
          expect(detail.accountType).toBe(config.accountType);
          expect(detail.currency).toBe(config.currency);
          expect(new Decimal(detail.amount).equals(amount)).toBe(true);
          guard.recordClientSubmission(record.ledgerTransactionId);
          if (!postRegistrationStageAtLeast(state.stage, 'DEPOSIT_CREATED')) {
            state = store.advance(state, 'DEPOSIT_CREATED', {
              depositTransactionId: record.ledgerTransactionId,
              depositSubmittedAt: new Date(record.occurredAtMs).toISOString(),
              depositClientStatus: record.status
            });
          }
          context.recordPrimaryOracle({
            id: 'PGJ-DP-P1',
            name: 'Client入金申请真实创建',
            expected: '唯一入金记录且详情存在TXN-*',
            actual: record.ledgerTransactionId,
            status: 'passed'
          });
          context.setBusinessData({
            clientTransactionId: record.ledgerTransactionId,
            clientDepositStatus: record.status,
            clientCandidateCount: diagnostics?.candidates.length ?? 1,
            clientCandidateStageCounts: diagnostics?.counts,
            clientSubmitCount: state.depositSubmitCount,
            resumeStage: state.stage
          });
          context.setActual('Client认领前已展示唯一入金记录，交易详情已打开并读取真实TXN。');
          return record;
        }
      );

      if (clientRecord) submittedAtMs = clientRecord.occurredAtMs;
      const fingerprint: DepositFingerprint = {
        runId,
        userIdentity: source.displayName!,
        accountType: config.accountType,
        currency: config.currency,
        requestedAmount: displayedAmount,
        clientSubmittedAtMs: submittedAtMs,
        adminStatus: pendingAdminStatus,
        channel: depositChannel
      };

      let adminCandidate: AdminDepositCandidate | undefined;
      let actualDepositAmount = state.depositActualAmount
        ? new Decimal(state.depositActualAmount)
        : amount;

      if (!postRegistrationStageAtLeast(state.stage, 'DEPOSIT_APPROVAL_ATTEMPTED')) {
        await business.step(
          {
            action: '6. Admin按业务指纹唯一定位并二次核对入金',
            expected: '浏览器逐页扫描匹配客户列，以用户名、香港账户、USD、精确金额、渠道、待处理状态和时间窗口得到唯一候选。'
          },
          async context => {
            let records: AdminDepositCandidate[] = [];
            let candidates: AdminDepositCandidate[] = [];
            await expect.poll(async () => {
              await adminList.goto(adminBaseUrl);
              await adminList.applyFilters({ status: pendingAdminStatus, matchStatus: '已匹配' });
              records = await adminList.readAllFilteredRecords();
              candidates = matchAdminDepositCandidates(records, fingerprint, config.matchWindowMs);
              return candidates.length;
            }, {
              timeout: 60_000,
              intervals: [1_000, 2_000, 5_000],
              message: 'Admin Deposit candidateCount did not become exactly 1.'
            }).toBe(1);
            adminCandidateCount = candidates.length;
            const diagnostics = diagnoseAdminDepositCandidates(records, fingerprint, config.matchWindowMs);
            adminCandidate = requireUniqueAdminDepositCandidate(candidates);
            if (!clientRecord) {
              guard.recordClientSubmissionFromAdminCandidate();
            }
            guard.recordUniqueAdminCandidate(adminCandidateCount);
            await claimDrawer.open(adminList, adminCandidate);
            const detail = await claimDrawer.readDetail();
            actualDepositAmount = new Decimal(detail.claimAmount);
            expect(matchesDepositCustomerIdentity(
              detail.matchedCustomerText,
              source.displayName!
            )).toBe(true);
            expect(detail.accountType).toContain(config.accountType);
            expect(new Decimal(detail.originalAmount).equals(amount)).toBe(true);
            expect(actualDepositAmount.equals(amount)).toBe(true);
            expect(detail.channel).toContain(depositChannel);
            expect(detail.reference).toBe(adminCandidate.reference);
            await claimDrawer.expectRequiredRemark();
            await claimDrawer.fillRemark(claimRemark);
            if (!postRegistrationStageAtLeast(state.stage, 'DEPOSIT_CREATED')) {
              state = store.advance(state, 'DEPOSIT_CREATED', {
                depositAdminReference: adminCandidate.reference,
                depositActualAmount: actualDepositAmount.toString()
              });
            } else {
              state = {
                ...state,
                depositAdminReference: adminCandidate.reference,
                depositActualAmount: actualDepositAmount.toString(),
                updatedAt: new Date().toISOString()
              };
              store.save(state);
            }
            if (!clientRecord) {
              context.recordPrimaryOracle({
                id: 'PGJ-DP-P1',
                name: 'Client入金申请真实创建',
                expected: 'Client单次提交后Admin存在唯一匹配申请且详情一致',
                actual: 'Admin candidateCount=1；详情匹配；Admin页面不提供TXN',
                status: 'passed'
              });
            }
            context.recordPrimaryOracle({
              id: 'PGJ-DP-P2',
              name: 'Admin候选唯一且详情匹配',
              expected: 'candidateCount=1且用户名/账户/币种/金额/时间一致',
              actual: 'candidateCount=1；详情匹配',
              status: 'passed'
            });
            context.setBusinessData({
              adminCandidateCount,
              candidateStageCounts: diagnostics.counts,
              adminStatusBefore: adminCandidate.status,
              actualDepositAmount: actualDepositAmount.toString(),
              adminRecordReference: adminCandidate.reference,
              adminTransactionId: '不适用（入账认领页面无TXN）',
              resumeStage: state.stage
            });
            context.setActual('Admin未使用不支持用户名的搜索框；浏览器逐页扫描匹配客户列后得到唯一候选，详情二次核对通过，认领备注已填写。');
          }
        );

        await business.step(
          {
            action: '7. Admin单次确认认领',
            expected: '确认认领只点击1次，不拒绝、不处理其他候选。'
          },
          async context => {
            guard.assertAdminMutationAllowed(
              env.exchange.allowMoneyTests,
              env.allowAdminMutationTests
            );
            state = store.recordDepositApprovalAttempt(state, adminCandidate?.reference);
            context.disallowSafeRerun();
            business.markMutationPerformed('Admin Deposit Claim');
            try {
              await claimDrawer.confirmClaimOnce();
            } catch (error) {
              context.requireManualReview('Admin Deposit claim result is ambiguous.');
              throw error;
            }
            expect(claimDrawer.confirmationClickCount()).toBe(1);
            context.setBusinessData({
              adminApproveCount: state.depositApproveCount,
              adminConfirmationClicks: claimDrawer.confirmationClickCount(),
              resumeStage: state.stage
            });
            context.setActual('Admin确认认领点击1次；没有拒绝或第二次处理。');
          }
        );
      }

      const completedAdminRecord = await business.step(
        {
          action: '8. 等待Admin原申请进入成功终态',
          expected: '同一业务指纹仍唯一且状态为处理完成。'
        },
        async context => {
          let matching: AdminDepositCandidate[] = [];
          try {
            await expect.poll(async () => {
              await adminList.goto(adminBaseUrl);
              matching = matchAdminDepositRecordsIgnoringStatus(
                await adminList.readAllFilteredRecords(),
                fingerprint,
                config.matchWindowMs
              );
              if (matching.length !== 1) return `candidateCount=${matching.length}`;
              return matching[0].status;
            }, {
              timeout: 75_000,
              intervals: [1_000, 2_000, 5_000],
              message: 'Admin original Deposit did not reach a readable successful state.'
            }).toMatch(/处理完成|已完成|完成|completed/i);
          } catch (error) {
            if (postRegistrationStageAtLeast(state.stage, 'DEPOSIT_APPROVAL_ATTEMPTED')) {
              context.requireManualReview('Admin认领已经点击，但最终状态无法读取。');
            }
            throw error;
          }
          const completed = matching[0];
          if (!postRegistrationStageAtLeast(state.stage, 'DEPOSIT_APPROVED')) {
            state = store.advance(state, 'DEPOSIT_APPROVED', {
              depositAdminReference: completed.reference,
              depositActualAmount: actualDepositAmount.toString(),
              depositAdminStatus: completed.status
            });
          }
          context.recordPrimaryOracle({
            id: 'PGJ-DP-P3',
            name: 'Admin入金认领完成',
            expected: '处理完成',
            actual: completed.status,
            status: 'passed'
          });
          context.setBusinessData({ adminStatusAfter: completed.status, resumeStage: state.stage });
          context.setActual(`Admin原入金申请最终状态=${completed.status}。`);
          return completed;
        }
      );

      const completedClientRecord = await business.step(
        {
          action: '9. Client辅助诊断入金完成流水',
          expected: '如交易页面展示本次流水，则读取TXN和绿色已完成状态；该诊断不参与核心业务结果。'
        },
        async context => {
          let record: DepositTransactionRecord | undefined;
          let candidateCount = 0;
          const clientLedgerCompleted = await expect.poll(async () => {
            await transactionsPage.goto(clientBaseUrl);
            if (clientRecord?.ledgerTransactionId) {
              await transactionsPage.searchByBusinessId(clientRecord.ledgerTransactionId);
              record = await transactionsPage.depositRecordById(clientRecord.ledgerTransactionId);
              candidateCount = record ? 1 : 0;
              return record?.status ?? 'missing';
            }
            const diagnostics = await transactionsPage.diagnoseDepositRecords({
              accountType: config.accountType,
              currency: config.currency,
              requestedAmount: displayedAmount,
              submittedFromMs: submittedAtMs - config.matchWindowMs,
              submittedToMs: Date.now() + config.matchWindowMs,
              status: /处理完成|已完成|完成|成功|completed|success/i,
              excludedLedgerTransactionIds: previousIds
            });
            candidateCount = diagnostics.candidates.length;
            record = diagnostics.candidates[0];
            return record?.status ?? 'missing';
          }, {
            timeout: 75_000,
            intervals: [1_000, 2_000, 5_000],
            message: 'Client Deposit ledger did not expose a successful terminal record.'
          }).toMatch(/处理完成|已完成|完成|成功|completed|success/i).then(
            () => true,
            error => {
              if (candidateCount > 1) throw error;
              return false;
            }
          );
          if (!clientLedgerCompleted || !record || !successfulStatus(record.status)) {
            context.recordDiagnostic({
              id: 'PGJ-DP-D2',
              name: 'Client全局入金流水',
              status: 'unavailable',
              summary: `candidateCount=${candidateCount}；自动化未读取到对应流水。`,
              reason: '仅影响辅助可观测性；Admin处理完成及余额严格增加已经确认入金业务成功。',
              affectsCoreBusiness: false
            });
            context.setActual('Client全局入金流水自动读取暂不可用；作为非计分Diagnostic，不改变核心PASS结果。');
            return undefined;
          }
          if (clientRecord) {
            expect(record.ledgerTransactionId).toBe(clientRecord.ledgerTransactionId);
          }
          clientRecord = record;
          state = {
            ...state,
            depositTransactionId: record.ledgerTransactionId,
            depositClientStatus: record.status,
            updatedAt: new Date().toISOString()
          };
          store.save(state);
          context.recordDiagnostic({
            id: 'PGJ-DP-D2',
            name: 'Client全局入金流水',
            status: 'available',
            summary: `已唯一读取Client流水，状态=${record.status}。`,
            reason: '辅助展示核对通过；核心业务仍由Admin终态与余额增量判定。',
            affectsCoreBusiness: false
          });
          context.setBusinessData({ clientFinalStatus: record.status });
          context.setActual('Client按原TXN或完整业务指纹读取到唯一成功流水，没有依赖最新一条记录。');
          return record;
        }
      );

      await business.step(
        {
          action: '10. 验证香港账户USD余额准确增加',
          expected: 'afterBalance - beforeBalance严格等于本次实际入金金额。'
        },
        async context => {
          const expectedBalance = expectedDepositBalanceAfterClaim(balanceBefore, actualDepositAmount);
          let balanceAfter = balanceBefore;
          await expect.poll(async () => {
            await accountPage.goto(clientBaseUrl);
            balanceAfter = (await accountPage.readBalance({
              accountType: config.accountType,
              currency: config.currency
            })).availableBalance;
            return balanceAfter.toString();
          }, {
            timeout: 75_000,
            intervals: [1_000, 2_000, 5_000],
            message: 'Hong Kong USD balance did not increase by the Deposit amount.'
          }).toBe(expectedBalance.toString());
          const observedIncrease = balanceAfter.minus(balanceBefore);
          expect(observedIncrease.equals(actualDepositAmount)).toBe(true);
          if (!postRegistrationStageAtLeast(state.stage, 'BALANCE_READY')) {
            state = store.advance(state, 'BALANCE_READY', {
              balanceAfter: balanceAfter.toString(),
              depositClientStatus: completedClientRecord?.status ?? state.depositClientStatus,
              depositAdminStatus: completedAdminRecord.status
            });
          }
          if (!postRegistrationStageAtLeast(state.stage, 'COMPLETED')) {
            state = store.advance(state, 'COMPLETED');
          }
          context.recordPrimaryOracle({
            id: 'PGJ-DP-P5',
            name: 'USD余额Oracle',
            expected: expectedBalance.toString(),
            actual: balanceAfter.toString(),
            status: 'passed'
          });
          context.setBusinessData({
            depositBalanceBefore: balanceBefore.toString(),
            depositBalanceAfter: balanceAfter.toString(),
            observedBalanceIncrease: observedIncrease.toString(),
            clientTransactionId: completedClientRecord?.ledgerTransactionId ?? '未展示',
            clientSubmitCount: state.depositSubmitCount,
            adminApproveCount: state.depositApproveCount,
            resumeEndStage: state.stage,
            confirmed: true,
            noSecondDepositCreated: true
          });
          context.setActual('香港账户USD余额增量与本次实际入金金额严格相等；Personal Golden Journey达到Balance Ready。');
        }
      );

      testInfo.annotations.push({
        type: 'no-auto-rerun',
        description: `runId=${runId}; the original Deposit is terminal and must never be submitted again.`
      });
    } finally {
      await client.context.close();
    }
  }
);
