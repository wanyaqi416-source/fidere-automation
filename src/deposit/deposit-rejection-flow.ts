import { expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { AdminFiatAccountReviewPage } from '../../pages/admin/AdminFiatAccountReviewPage';
import { DepositClaimListPage } from '../../pages/admin/DepositClaimListPage';
import { DepositClaimDrawer } from '../../pages/admin/DepositClaimDrawer';
import { DepositRejectDrawer } from '../../pages/admin/DepositRejectDrawer';
import { AccountDetailPage } from '../../pages/client/AccountDetailPage';
import { DepositPage } from '../../pages/client/DepositPage';
import { DepositHistoryPage, type ClientDepositHistoryRecord } from '../../pages/client/DepositHistoryPage';
import { RegistrationKycStatusPage } from '../../pages/client/RegistrationKycStatusPage';
import { TransactionsPage, type DepositTransactionRecord } from '../../pages/client/TransactionsPage';
import { env } from '../config/env';
import { MoneyMutationGuard } from '../flow-engine';
import { PersonalPostRegistrationJourneyStore } from '../journey';
import { PersonalJourneyContextStore, maskRegistrationEmail, openPersonalJourneyClientSession } from '../registration';
import type { BusinessReportApi } from '../reporting/business-report.types';
import { Decimal } from '../utils/money';
import { assertClientTestEnvironment } from '../utils/clientSafety';
import { runDepositAuthPreflight } from './deposit-auth-preflight';
import {
  clientDepositIdPattern, DepositExecutionGuard, deriveUniqueDepositAmount, diagnoseAdminDepositCandidates,
  matchAdminDepositCandidates, matchAdminDepositRecordsIgnoringStatus, matchesDepositCustomerIdentity,
  requireUniqueAdminDepositCandidate, type AdminDepositCandidate, type DepositFingerprint
} from './deposit-e2e';
import { assertDepositRejectionAuthorization, DepositRejectionRun } from './deposit-rejection-run';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Deposit rejection.`);
  return value;
}
const rejectedStatus = /^(?:已拒绝|拒绝|驳回|已驳回|rejected)$/i;
const adminRejectedStatus = /^(?:已拒绝|拒绝|处理失败|rejected|failed)$/i;

export async function runDepositRejection(input: {
  browser: Browser; adminPage: Page; business: BusinessReportApi; testInfo: TestInfo;
  mode: 'preflight' | 'fresh' | 'resume' | 'readonly';
}): Promise<void> {
  const { browser, adminPage, business, testInfo, mode } = input;
  const runId = required('DEPOSIT_REJECT_RUN_ID');
  const sourceRunId = required('DEPOSIT_REJECT_SOURCE_RUN_ID');
  const source = new PersonalPostRegistrationJourneyStore(sourceRunId).load();
  const registration = new PersonalJourneyContextStore().load(sourceRunId);
  if (!source || source.stage !== 'COMPLETED' || !source.fiatAddressReference || !registration?.sequence) {
    throw new Error('An existing KYC-approved Journey with approved bank address is required; no new user/address is allowed.');
  }
  const account = env.deposit.accountType!;
  const currency = env.deposit.currency!;
  const currencyLabel = env.deposit.currencyLabel!;
  if (!account || !currency || !currencyLabel) throw new Error('Deposit account/currency configuration is missing.');
  const amount = deriveUniqueDepositAmount(runId, env.deposit.uniqueAmountBase ?? '11', 2).toFixed(2);
  const clientBase = env.client.baseUrl!;
  const adminBase = env.admin.baseUrl!;
  assertClientTestEnvironment(clientBase);
  assertClientTestEnvironment(adminBase);
  new MoneyMutationGuard('Deposit rejection').validateRuntime({
    baseURL: clientBase, safetySwitches: {},
    workers: testInfo.config.workers, retries: testInfo.project.retries, repeatEach: testInfo.project.repeatEach,
  });
  expect(testInfo.retry).toBe(0);
  expect(testInfo.repeatEachIndex).toBe(0);
  const mutating = mode === 'fresh' || mode === 'resume';
  if (mutating) {
    assertDepositRejectionAuthorization(runId, process.env.DEPOSIT_REJECT_AUTHORIZED_RUN_ID);
    if ((mode === 'fresh' && !env.allowClientMutationTests) || !env.allowAdminMutationTests || !env.exchange.allowMoneyTests) {
      throw new Error('Deposit requires money/Admin switches; only a fresh Client submission requires the Client switch.');
    }
  } else if (env.allowClientMutationTests || env.allowAdminMutationTests || env.exchange.allowMoneyTests) {
    throw new Error('Deposit preflight/readonly requires all mutation switches closed.');
  }
  const run = mode === 'preflight' ? undefined : new DepositRejectionRun(runId, sourceRunId, account, currency, amount);
  if (mode === 'fresh' && run!.submitted()) throw new Error('Original Deposit already attempted; explicit Resume/readonly only.');
  if ((mode === 'resume' || mode === 'readonly') && !run!.submitted()) throw new Error('There is no original Deposit to resume.');
  if (mode === 'resume' && run!.state().stage === 'COMPLETED') throw new Error('Completed Deposit allows readonly only.');
  const reason = `AUTOMATION DEPOSIT REJECTION TEST ${runId}`;
  const reference = `AUTO_${runId}`;
  const bankName = `FIDERE SANDBOX BANK ${source.displayName.split(' ').at(-1)}`;
  const bankAccount = `88000000${String(registration.sequence).padStart(4, '0')}`;
  const windowMs = env.deposit.matchWindowMs;
  const guard = new DepositExecutionGuard();
  const list = new DepositClaimListPage(adminPage);
  business.flow(mode === 'preflight' ? 'deposit-rejection-preflight' : 'deposit-rejection-journey',
    mode === 'readonly' ? { caseId: 'DP-004-READONLY', name: '原入金申请只读调查（非拒绝闭环结果）',
      level: 'L2', changesData: false, affectsMoney: false, type: ['Readonly', 'Reconciliation'] } : {});
  business.setBusinessData({ runId, sourceRunId, registrationTestName: source.displayName, registrationLoginIdentity: maskRegistrationEmail(source.email),
    accountType: account, depositCurrency: currency, depositAmount: amount, rejectReason: reason,
    beneficiaryAccountSuffix: `****${bankAccount.slice(-4)}`, bankName, resumeStartStage: run?.state().stage ?? 'PREPARED',
    confirmationClicks: run?.submitted() ? 1 : 0, rejectConfirmationClicks: run?.rejected() ? 1 : 0, confirmed: false });
  let client: Awaited<ReturnType<typeof openPersonalJourneyClientSession>> | undefined;
  let coreRejected = false;
  let adminRejectionConfirmed = false;
  try {
    client = await openPersonalJourneyClientSession({ browser, baseURL: clientBase, runId: sourceRunId,
      email: source.email, password: env.client.password!, otp: env.client.otp!, forceFreshLogin: true });
    const page = client.page;
    const balance = new AccountDetailPage(page);
    const form = new DepositPage(page);
    let transactions = new TransactionsPage(page);
    await business.step({ action: '1. 双端认证、原用户KYC和已批准银行地址预检', expected: '同一用户KYC通过，已有银行地址审核通过；不创建用户或地址。' }, async step => {
      await runDepositAuthPreflight({ clientPage: page, adminPage, clientBaseUrl: clientBase, adminBaseUrl: adminBase, guard });
      await new RegistrationKycStatusPage(page).expectApproved({ ...source, runId: sourceRunId }, clientBase);
      const banks = new AdminFiatAccountReviewPage(adminPage);
      await banks.goto(adminBase, '已通过');
      const result = await banks.locateCandidate({ email: source.email, displayName: source.displayName, bankName, bankAccount });
      expect(result.candidateCount, 'Approved original bank address must be unique.').toBe(1);
      expect(result.candidates[0].accountId === source.fiatAddressReference).toBe(true);
      step.setActual('Client/Admin认证有效；原用户KYC和原银行地址已通过。');
    });
    let previousIds = new Set<string>();
    let before = '';
    let channel = '';
    if (!run?.submitted()) {
      await business.step({ action: '2. 读取余额并填写本次唯一金额入金表单', expected: '使用现有已批准银行地址，页面选项有效，保存本次余额及历史TXN；不提交。' }, async step => {
        await balance.goto(clientBase);
        before = (await balance.readBalance({ accountType: account, currency })).availableBalance.toString();
        await transactions.goto(clientBase);
        previousIds = new Set((await transactions.readVisibleDepositRecords()).map(record => record.ledgerTransactionId));
        await form.goto(clientBase);
        await form.selectAccount(account);
        await form.selectCurrency(currencyLabel);
        await form.selectPayingBank(bankName, bankAccount.slice(-4));
        await form.fillAmount(amount);
        const channels = await form.readChannelOptions();
        channel = env.deposit.channel === '电汇' ? 'SWIFT' : env.deposit.channel!;
        expect(channels.includes(channel), 'Configured channel must exist in the real dropdown.').toBe(true);
        await form.selectChannel(channel);
        await form.selectPurpose(env.deposit.purpose!);
        await form.selectSourceOfFunds(env.deposit.sourceOfFunds === '工资' ? '工资及薪酬收入' : env.deposit.sourceOfFunds!);
        if (env.deposit.transferMethod) await form.selectTransferMethod(env.deposit.transferMethod);
        await form.fillReference(reference);
        const snapshot = await form.readFormSnapshot();
        expect(snapshot.accountType.includes(account) && snapshot.currencyLabel.includes(currencyLabel)).toBe(true);
        expect(new Decimal(snapshot.amount).equals(amount)).toBe(true);
        expect(snapshot.submitEnabled).toBe(true);
        step.setBusinessData({ depositBalanceBefore: before, depositChannel: channel, confirmationClicks: 0 });
        step.setActual(`原账户余额=${before} ${currency}；本次金额=${amount}，表单已校验，未提交。`);
      });
      await business.step({ action: '3. Admin待处理冲突检查', expected: '完整扫描筛选结果，当前用户/账户/币种/精确金额不得存在待处理冲突。' }, async step => {
        await list.goto(adminBase);
        await list.applyFilters({ status: env.deposit.reconciliationAdminStatus ?? '待处理', matchStatus: '已匹配' });
        const records = await list.readAllFilteredRecords();
        const conflicts = matchAdminDepositCandidates(records, {
          runId, userIdentity: source.displayName, accountType: account, currency, requestedAmount: amount,
          clientSubmittedAtMs: Date.now(), adminStatus: env.deposit.reconciliationAdminStatus ?? '待处理'
        }, windowMs, { applyTimeWindow: false });
        expect(conflicts.length, 'Existing pending Deposit conflict; do not submit.').toBe(0);
        step.setBusinessData({ candidateCount: conflicts.length });
        step.setActual('相同用户、账户、币种及金额的待处理冲突数=0；不依赖Admin TXN或用户名搜索。');
      });
      if (mode === 'preflight') {
        business.setBusinessData({ resumeEndStage: 'DEPOSIT_READY', confirmed: false, noNewDepositCreated: true });
        return;
      }
      await business.step({ action: '4. Client单次提交入金申请', expected: '持久化原始余额、时间和提交标记，再点击一次；HTTP成功不是业务创建证据。' }, async step => {
        guard.assertClientSubmissionAllowed(env.exchange.allowMoneyTests, env.allowAdminMutationTests);
        run!.attemptSubmit({ balanceBefore: before, previousTransactionIds: [...previousIds], channel, submittedAt: new Date().toISOString() });
        step.markPotentiallySubmitted(); step.disallowSafeRerun();
        const result = await form.submitOnce();
        step.setBusinessData({ confirmationClicks: form.submissionClicks(), networkObservations: [{ path: result.requestPath, status: result.httpStatus }] });
        step.setActual('Client提交1次；接下来必须读取唯一原TXN，不因Admin暂时无记录而重提。');
      });
    }
    business.disallowSafeRerun();
    const baseline = run!.baseline();
    const submittedAtMs = Date.parse(baseline.submittedAt);
    const criteria = { accountType: account, currency, requestedAmount: amount,
      submittedFromMs: submittedAtMs - windowMs, submittedToMs: submittedAtMs + windowMs,
      excludedLedgerTransactionIds: new Set(baseline.previousTransactionIds) };
    business.setBusinessData({ depositBalanceBefore: baseline.balanceBefore, confirmationClicks: 1 });
    const fingerprint: DepositFingerprint = { runId, userIdentity: source.displayName, accountType: account, currency,
      requestedAmount: amount, clientSubmittedAtMs: submittedAtMs, adminStatus: env.deposit.reconciliationAdminStatus ?? '待处理',
      channel: baseline.channel };
    const adminRecords = async () => {
      await list.goto(adminBase);
      return matchAdminDepositRecordsIgnoringStatus(await list.readAllFilteredRecords(), fingerprint, windowMs);
    };
    if (mode === 'readonly') {
      await business.step({ action: '2. 无需Client TXN，Admin按原提交业务指纹独立只读定位',
        expected: '使用原用户、账户、币种、金额、渠道、时间和状态；Admin页面没有TXN，不搜索TXN，不执行审核。' }, async step => {
        await list.goto(adminBase);
        const records = await list.readAllFilteredRecords();
        const diagnostics = diagnoseAdminDepositCandidates(records, fingerprint, windowMs);
        const matches = matchAdminDepositRecordsIgnoringStatus(records, fingerprint, windowMs);
        step.setBusinessData({ candidateCount: matches.length, candidateStageCounts: diagnostics.counts,
          fingerprintFields: ['匹配客户', '账户类型', '币种', '精确金额', '渠道', '原提交时间窗口', '当前状态'],
          customerMatchStrategy: '页面匹配客户文本，不要求Admin存在TXN', timeWindowApplied: true });
        if (matches.length !== 1) {
          step.recordPrimaryOracle({ id: 'DP004-READONLY-ADMIN', name: '原Admin记录当前可读',
            expected: '原业务指纹候选=1', actual: `候选=${matches.length}`, status: 'failed' });
          step.setActual(`当前Admin只读候选=${matches.length}；继续独立读取Client证据，不执行任何审核。`);
          return;
        }
        const candidate = requireUniqueAdminDepositCandidate(matches);
        if (candidate.status === fingerprint.adminStatus) {
          const drawer = new DepositClaimDrawer(adminPage);
          await drawer.open(list, candidate);
          try {
            const detail = await drawer.readDetail();
            expect(matchesDepositCustomerIdentity(detail.matchedCustomerText, source.displayName)).toBe(true);
            expect(detail.accountType === account && new Decimal(detail.originalAmount).equals(amount)).toBe(true);
            expect(detail.channel === baseline.channel && detail.reference === candidate.reference &&
              detail.submittedAtText === candidate.submittedAtText).toBe(true);
            step.setBusinessData({ detailVerified: true });
          } finally { await drawer.closeWithoutConfirming(); }
        }
        step.setBusinessData({ adminReference: candidate.reference, adminDepositStatus: candidate.status,
          recordOccurredAt: candidate.submittedAtText, existingDepositResume: true, noNewDepositCreated: true });
        step.recordPrimaryOracle({ id: 'DP004-READONLY-ADMIN', name: '原Admin入金记录唯一且可读',
          expected: '完整业务指纹候选=1；不依赖TXN', actual: `候选=1；状态=${candidate.status}`, status: 'passed' });
        step.setActual(`原金额${amount} ${currency}的Admin候选=1，状态=${candidate.status}；${candidate.status === fingerprint.adminStatus ? '仅打开详情后取消' : '只读核对终态记录'}，审核操作0次。`);
      });
      await business.step({ action: '3. Client原入金记录及当前余额只读诊断',
        expected: '记录Client可见数据；不把Admin可定位误报成拒绝闭环已完成，不更改原提交状态。' }, async step => {
        await transactions.goto(clientBase);
        await transactions.selectDepositType();
        const result = await transactions.diagnoseDepositRecords(criteria);
        step.setBusinessData({ clientDepositHistoryCandidateCount: result.candidates.length });
        expect(result.candidates.length, 'Multiple Client records require investigation, never resubmission.').toBeLessThanOrEqual(1);
        if (result.candidates.length === 1) {
          const detail = await (await transactions.openDepositDetail(result.candidates[0])).readFiatDepositDetail();
          expect(clientDepositIdPattern.test(detail.displayedTransactionNumber)).toBe(true);
          expect(detail.accountType === account && detail.currency === currency && new Decimal(detail.amount).equals(amount)).toBe(true);
          step.setBusinessData({ depositOrderId: detail.displayedTransactionNumber, clientDepositStatus: detail.status });
        }
        await form.goto(clientBase);
        const history = new DepositHistoryPage(page);
        let historyRecords: ClientDepositHistoryRecord[] = [];
        // Poll the same loaded page so an in-flight history response is not cancelled by repeated navigation.
        try {
          await expect.poll(async () => {
            historyRecords = await history.readRecords();
            return historyRecords.length;
          }, { timeout: 15_000, message: 'Client deposit history cards not observed.' }).toBeGreaterThan(0);
        } catch {
          step.recordDiagnostic({ id: 'DP004-HISTORY-LOAD', name: '入金历史加载', status: 'unavailable',
            summary: '等待当前页面历史记录后仍未读取到卡片', affectsCoreBusiness: false });
        }
        const sameAmount = historyRecords.filter(record => record.currency === currency && new Decimal(record.requestedAmount).equals(amount));
        step.recordDiagnostic({ id: 'DP004-HISTORY-FIELDS', name: '入金历史原金额与时间字段', status: 'info',
          summary: `历史共${historyRecords.length}条；同币种金额${sameAmount.length}条；${sameAmount.map(record =>
            `页面时间=${record.submittedAtText}, 状态=${record.status}, 与原提交相差秒数=${(record.submittedAtMs - submittedAtMs) / 1000}`).join('；')}`,
          affectsCoreBusiness: false });
        await balance.goto(clientBase);
        const current = (await balance.readBalance({ accountType: account, currency })).availableBalance.toString();
        step.setBusinessData({ depositBalanceCurrent: current, resumeEndStage: run!.state().stage,
          noNewDepositCreated: true, confirmed: false });
        step.recordDiagnostic({ id: 'DP004-READONLY-CLIENT', name: 'Client展示与余额快照',
          status: result.candidates.length === 1 ? 'available' : 'unavailable',
          summary: `Client候选=${result.candidates.length}；当前余额=${current} ${currency}`,
          reason: '这是只读调查，不是原DP-004拒绝终态通过证据；未重写历史报告或推进原Run。', affectsCoreBusiness: false });
        step.setActual(`Client候选=${result.candidates.length}；当前余额=${current} ${currency}。未再次提交或拒绝。`);
      });
      return;
    }
    const original = mode === 'resume' ? undefined : await business.step({ action: '5. Client唯一入金记录及详情确认真实TXN', expected: '按账户、币种、金额和提交窗口定位唯一新记录，详情存在真实TXN；否则DEPOSIT_SUBMISSION_UNCONFIRMED。' }, async step => {
      let records: DepositTransactionRecord[] = [];
      await expect.poll(async () => {
        await transactions.goto(clientBase);
        const result = await transactions.diagnoseDepositRecords(criteria);
        records = result.candidates;
        step.setBusinessData({ candidateStageCounts: result.counts, clientDepositHistoryCandidateCount: records.length });
        if (records.length > 1) throw new Error('DEPOSIT_SUBMISSION_UNCONFIRMED: multiple new Client records.');
        return records.length;
      }, { timeout: 60_000, message: 'DEPOSIT_SUBMISSION_UNCONFIRMED: unique new Client Deposit record not observed.' }).toBe(1);
      const record = records[0];
      const detail = await (await transactions.openDepositDetail(record)).readFiatDepositDetail();
      expect(clientDepositIdPattern.test(detail.displayedTransactionNumber)).toBe(true);
      expect(detail.currency === currency && detail.accountType === account && new Decimal(detail.amount).equals(amount)).toBe(true);
      run!.created(detail.displayedTransactionNumber);
      guard.recordClientSubmission(detail.displayedTransactionNumber);
      step.recordPrimaryOracle({ id: 'DP004-CREATED', name: '原Client申请真实创建', expected: '唯一入金记录及详情TXN', actual: '唯一记录和真实TXN已保存', status: 'passed' });
      step.setBusinessData({ depositOrderId: detail.displayedTransactionNumber, clientTransactionId: record.ledgerTransactionId,
        clientDepositStatus: detail.status, recordOccurredAt: detail.createdAt });
      step.setActual(`Client新记录数=1，详情TXN已读取；状态=${detail.status}。`);
      return { record, detail };
    });
    await business.step({ action: '6. Admin唯一定位并二次核对原申请', expected: '用户、账户、币种、精确金额、渠道、时间和待处理状态全部匹配，候选严格为1。' }, async step => {
      const records = await adminRecords();
      const diagnostics = diagnoseAdminDepositCandidates(records, fingerprint, windowMs);
      step.setBusinessData({ candidateStageCounts: diagnostics.counts, candidateCount: records.length });
      const candidate = requireUniqueAdminDepositCandidate(records);
      if (!run!.rejected()) {
        expect(candidate.status).toBe(fingerprint.adminStatus);
        const detailDrawer = new DepositClaimDrawer(adminPage);
        await detailDrawer.open(list, candidate);
        const detail = await detailDrawer.readDetail();
        expect(matchesDepositCustomerIdentity(detail.matchedCustomerText, source.displayName)).toBe(true);
        expect(detail.accountType === account && new Decimal(detail.originalAmount).equals(amount)).toBe(true);
        expect(detail.channel === baseline.channel && detail.reference === candidate.reference && detail.submittedAtText === candidate.submittedAtText).toBe(true);
        await detailDrawer.closeWithoutConfirming();
      }
      if (mode === 'resume') {
        run!.createdFromVerifiedAdmin(candidate, records.length, fingerprint, windowMs);
        guard.recordClientSubmissionFromAdminCandidate();
        step.recordPrimaryOracle({ id: 'DP004-CREATED', name: '原提交已形成真实业务申请',
          expected: '原提交标记、完整Admin业务指纹及详情唯一一致', actual: '原Admin申请存在；没有新建或推导TXN', status: 'passed' });
        step.setBusinessData({ existingDepositResume: true, noNewDepositCreated: true });
      }
      run!.located(candidate.reference, records.length);
      guard.recordUniqueAdminCandidate(records.length);
      step.recordPrimaryOracle({ id: 'DP004-UNIQUE', name: 'Admin原申请唯一且一致', expected: 'candidateCount=1，字段全部匹配', actual: 'candidateCount=1', status: 'passed' });
      step.setBusinessData({ candidateCount: 1, adminReference: candidate.reference, detailVerified: true, adminStatusBefore: candidate.status });
      step.setActual('Admin唯一定位原申请并核对真实字段，未选择第一条/最新一条。');
      if (!run!.rejected()) {
        if (!mutating) throw new Error('Original Deposit is pending; readonly mode cannot reject.');
        guard.assertAdminMutationAllowed(env.exchange.allowMoneyTests, env.allowAdminMutationTests);
        const reject = new DepositRejectDrawer(adminPage);
        await reject.open(list, candidate);
        await reject.confirmRejectOnce(reason, () => { run!.attemptReject(); step.markPotentiallySubmitted(); step.disallowSafeRerun(); });
        step.setBusinessData({ rejectConfirmationClicks: reject.confirmationClickCount() });
        step.setActual('唯一原申请确认拒绝1次；没有执行认领或审核通过。');
      }
    });
    await business.step({ action: '7. Admin拒绝终态与再次审核入口诊断', expected: '原申请唯一且已拒绝；仅记录终态是否仍有可操作按钮，不再点击。' }, async step => {
      let records: AdminDepositCandidate[] = [];
      await expect.poll(async () => {
        records = await adminRecords();
        return records.length === 1 ? records[0].status : `candidateCount=${records.length}`;
      }, { timeout: 60_000, message: 'Original Admin Deposit rejected status not observed.' }).toMatch(adminRejectedStatus);
      run!.adminRejected();
      adminRejectionConfirmed = true;
      step.recordPrimaryOracle({ id: 'DP004-ADMIN', name: 'Admin拒绝成功', expected: '原申请拒绝终态', actual: records[0].status, status: 'passed' });
      step.setBusinessData({ adminDepositStatus: records[0].status, rejectConfirmationClicks: 1 });
      try {
        const actions = await list.readAvailableActions(records[0]);
        step.recordDiagnostic({ id: 'DP004-ACTIONS', name: '拒绝后可操作入口', status: 'info', summary: actions.join(' / ') || '无可操作入口',
          reason: '只读记录产品行为，没有再次认领/拒绝。', affectsCoreBusiness: false });
      } catch {
        step.recordDiagnostic({ id: 'DP004-ACTIONS', name: '拒绝后可操作入口', status: 'unavailable', summary: '辅助按钮检查暂不可用',
          reason: '原Admin拒绝状态已读取，继续核心Client终态和余额验证。', affectsCoreBusiness: false });
      }
      step.setActual(`Admin状态=${records[0].status}；原申请拒绝完成。`);
    });
    await client.context.close();
    client = await openPersonalJourneyClientSession({ browser, baseURL: clientBase, runId: sourceRunId,
      email: source.email, password: env.client.password!, otp: env.client.otp!, forceFreshLogin: true });
    transactions = new TransactionsPage(client.page);
    let clientVerificationError: unknown;
    try { await business.step({ action: '8. 干净登录Client验证原申请拒绝终态及拒绝原因', expected: '同一原申请、同金额币种与提交窗口；如展示TXN或原因必须一致。' }, async step => {
      if (!original) {
        const history = new DepositHistoryPage(client!.page);
        const deposit = new DepositPage(client!.page);
        let records: ClientDepositHistoryRecord[] = [];
        await expect.poll(async () => {
          await deposit.goto(clientBase);
          records = (await history.readRecords()).filter(record => record.currency === currency &&
            new Decimal(record.requestedAmount).equals(amount) && record.submittedAtMs >= criteria.submittedFromMs &&
            record.submittedAtMs <= criteria.submittedToMs);
          if (records.length > 1) throw new Error('Multiple original Client Deposit history records.');
          return records[0]?.status ?? 'missing';
        }, { timeout: 60_000, message: 'Original Client deposit history did not reach rejection.' }).toMatch(/^(?:failed|rejected|已拒绝|拒绝|处理失败)$/i);
        const record = records[0];
        if (run!.state().clientReference && record.clientDepositId) expect(record.clientDepositId).toBe(run!.state().clientReference);
        if (record.rejectionReason) expect(record.rejectionReason).toBe(reason);
        run!.clientRejected(); coreRejected = true;
        step.recordPrimaryOracle({ id: 'DP004-CLIENT', name: 'Client原入金申请已拒绝',
          expected: '原用户入金历史中金额、币种、提交窗口唯一，状态拒绝', actual: record.status, status: 'passed' });
        step.setBusinessData({ clientDepositStatus: record.status, clientFinalStatus: record.status,
          depositOrderId: record.clientDepositId, clientDepositHistoryCandidateCount: records.length,
          rejectReasonDisplayed: Boolean(record.rejectionReason), repeatedClientSubmission: false });
        step.setActual(`原入金历史候选=1，状态=${record.status}；未再次提交。`);
        return;
      }
      let record: DepositTransactionRecord | undefined;
      await expect.poll(async () => {
        await transactions.goto(clientBase);
        const result = await transactions.diagnoseDepositRecords(criteria);
        if (result.candidates.length > 1) throw new Error('Duplicate Client Deposit evidence.');
        record = result.candidates.length === 1 ? result.candidates[0] : undefined;
        return record?.status ?? 'missing';
      }, { timeout: 75_000, message: 'Client original Deposit did not reach rejected terminal state.' }).toMatch(rejectedStatus);
      expect(record!.ledgerTransactionId === original.record.ledgerTransactionId).toBe(true);
      const detail = await (await transactions.openDepositDetail(record!)).readFiatDepositDetail();
      expect(detail.displayedTransactionNumber === run!.state().clientReference).toBe(true);
      expect(detail.currency === currency && detail.accountType === account && new Decimal(detail.amount).equals(amount)).toBe(true);
      expect(detail.status).toMatch(rejectedStatus);
      if (detail.rejectionReason) expect(detail.rejectionReason).toBe(reason);
      run!.clientRejected(); coreRejected = true;
      step.recordPrimaryOracle({ id: 'DP004-CLIENT', name: 'Client同一TXN拒绝终态', expected: '原申请唯一、已拒绝且原因一致（如展示）', actual: detail.status, status: 'passed' });
      step.setBusinessData({ clientDepositStatus: detail.status, clientFinalStatus: detail.status, repeatedClientSubmission: false, recordIdsUnchanged: true,
        rejectReasonDisplayed: Boolean(detail.rejectionReason) });
      step.setActual(`原Client TXN状态=${detail.status}；唯一新申请，无重复；${detail.rejectionReason ? '拒绝原因匹配' : '页面未展示拒绝原因'}。`);
    }); } catch (error) { clientVerificationError = error; }
    await business.step({ action: '9. 验证最终余额与原始提交前余额完全相同', expected: 'afterBalance = beforeBalance，使用Decimal，不允许本次拒绝入金增加余额。' }, async step => {
      const accountPage = new AccountDetailPage(client!.page);
      let after = '';
      await expect.poll(async () => {
        await accountPage.goto(clientBase);
        after = (await accountPage.readBalance({ accountType: account, currency })).availableBalance.toString();
        step.setBusinessData({ depositBalanceAfter: after });
        return new Decimal(after).equals(baseline.balanceBefore);
      }, { timeout: 60_000, message: 'DEPOSIT_REJECTION_BALANCE_MISMATCH' }).toBe(true);
      if (coreRejected) run!.complete(after);
      step.recordPrimaryOracle({ id: 'DP004-BALANCE', name: '拒绝后余额不变', expected: baseline.balanceBefore, actual: after, status: 'passed' });
      step.setBusinessData({ depositBalanceAfter: after, confirmed: coreRejected, resumeEndStage: coreRejected ? 'BALANCE_UNCHANGED_VERIFIED' : run!.state().stage,
        resumeStage: run!.state().stage, confirmationClicks: 1, rejectConfirmationClicks: 1, repeatedClientSubmission: false });
      step.setActual(`${after} = ${baseline.balanceBefore} ${currency}；余额未增加；${coreRejected ? '拒绝闭环完成' : 'Client终态尚未确认，不再次执行拒绝'}。`);
    });
    if (clientVerificationError) throw clientVerificationError;
  } catch (error) {
    business.setBusinessData({ resumeStage: run?.state().stage ?? 'PREPARED', confirmationClicks: run?.submitted() ? 1 : 0,
      rejectConfirmationClicks: run?.rejected() ? 1 : 0 });
    if (run?.submitted()) {
      business.disallowSafeRerun();
      if ((!run.state().clientReference && !run.hasAdminCreationEvidence()) || (run.rejected() && !adminRejectionConfirmed)) {
        business.requireManualReview('Client创建或Admin拒绝已尝试但结果证据不完整；只允许查询原申请，禁止重提。');
      }
    }
    throw error;
  } finally { if (client) await client.context.close(); }
}
