import { AdminFiatAccountReviewPage } from '../../../pages/admin/AdminFiatAccountReviewPage';
import { WithdrawalListPage } from '../../../pages/admin/WithdrawalListPage';
import { WithdrawalApprovalPage } from '../../../pages/admin/WithdrawalApprovalPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { WithdrawalHistoryPage } from '../../../pages/client/WithdrawalHistoryPage';
import { WithdrawalPage } from '../../../pages/client/WithdrawalPage';
import { expect, test } from '../../../fixtures/registration.fixture';
import { env } from '../../../src/config/env';
import { advanceFlowState, createPreparedFlowState, FlowStateStore, stageIndex } from '../../../src/flow-engine';
import { assertSandboxEnvironment } from '../../../src/flow-engine/mutation-guard';
import { PersonalPostRegistrationJourneyStore } from '../../../src/journey';
import { maskRegistrationEmail, openPersonalJourneyClientSession, PersonalJourneyContextStore } from '../../../src/registration';
import { matchesDepositCustomerIdentity } from '../../../src/deposit/deposit-e2e';
import { runWithdrawalAuthPreflight } from '../../../src/withdrawal/withdrawal-auth-preflight';
import { buildWithdrawalApprovalNote, deriveUnusedWithdrawalAmount, matchAdminWithdrawalRecordsIgnoringStatus, requireUniqueAdminWithdrawalCandidate, WithdrawalExecutionGuard, type WithdrawalFingerprint } from '../../../src/withdrawal/withdrawal-e2e';
import { withdrawalDebitFromSettlement } from '../../../src/withdrawal/withdrawal-balance-oracle';
import { validateWithdrawalProofAsset } from '../../../src/withdrawal/withdrawal-proof';
import { Decimal, decimalFromText } from '../../../src/utils/money';
import { getClientSecurityKey } from '../../../src/utils/security-key';
import { getWithdrawalApprovalConfig, getWithdrawalTestConfig } from '../../client/withdrawal/withdrawalTestSupport';

const FLOW_ID = 'personal-golden-journey-withdrawal';
const CLIENT_DONE = /^(已完成|完成|成功|completed|success)$/i;
const ADMIN_DONE = /^(处理完成|已完成|已批准|approved|completed)$/i;

test.describe.configure({ mode: 'serial', retries: 0 });
test('原Personal Golden Journey小额出金审核通过 @journey @withdrawal @money @mutation @resume @L4', async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(360_000);
  test.skip(!env.exchange.allowMoneyTests || !env.allowAdminMutationTests, 'Requires this Run money and Admin authorization.');
  const sourceRunId = env.personalRegistration.adminApprovalSourceRunId;
  if (!sourceRunId || !env.client.baseUrl || !env.admin.baseUrl) throw new Error('Explicit existing Journey source and URLs required.');
  assertSandboxEnvironment(env.client.baseUrl);
  assertSandboxEnvironment(env.admin.baseUrl);
  expect(testInfo.config.workers).toBe(1);
  expect(testInfo.project.retries).toBe(0);
  expect(testInfo.project.repeatEach).toBe(1);
  expect(testInfo.retry + testInfo.repeatEachIndex).toBe(0);
  const source = new PersonalJourneyContextStore().load(sourceRunId);
  const journeyStore = new PersonalPostRegistrationJourneyStore(sourceRunId);
  const journey = journeyStore.load();
  if (!source?.displayName || !source.sequence || !journey || journey.stage !== 'COMPLETED' || journey.depositApproveCount !== 1 || !journey.balanceAfter || !journey.fiatAddressAccountSuffix) {
    throw new Error('Original registered, KYC approved and funded Journey is required; no new user or deposit is permitted.');
  }
  const config = getWithdrawalTestConfig();
  const approvalConfig = getWithdrawalApprovalConfig();
  const runId = `PGJ-WD-${sourceRunId}`;
  const store = new FlowStateStore();
  let state = store.load(FLOW_ID, runId);
  if (state?.stage === 'COMPLETED') throw new Error('This Journey withdrawal is complete; creating another is forbidden.');
  if (state && state.stage !== 'PREPARED' && !state.clientReference) throw new Error('WITHDRAWAL_SUBMISSION_UNCONFIRMED: read-only reconciliation required; never resubmit.');
  const guard = new WithdrawalExecutionGuard();
  const adminList = new WithdrawalListPage(adminPage);
  const proof = await validateWithdrawalProofAsset();
  let approval: WithdrawalApprovalPage | undefined;
  let client = await openPersonalJourneyClientSession({ browser, baseURL: env.client.baseUrl, runId: sourceRunId, email: source.email, password: env.client.password!, otp: env.client.otp!, forceFreshLogin: true });
  let withdrawal = new WithdrawalPage(client.page);
  let history = new WithdrawalHistoryPage(client.page);
  const network: { path: string; status: number; time: string }[] = [];
  let observingSubmission = false;
  client.page.on('response', response => {
    const url = new URL(response.url());
    if (observingSubmission && response.request().method() === 'POST' && url.origin === new URL(env.client.baseUrl!).origin && /^\/api\/[a-z0-9/-]+$/i.test(url.pathname)) {
      network.push({ path: url.pathname, status: response.status(), time: new Date().toISOString() });
    }
  });
  const saveSnapshot = () => { journey.updatedAt = new Date().toISOString(); journeyStore.save(journey); };
  const reportSnapshot = () => business.setBusinessData({
    runId, sourceRunId, registrationTestName: source.displayName, maskedLogin: maskRegistrationEmail(source.email),
    accountType: config.accountType, withdrawalCurrency: config.currency,
    beforeAvailableBalance: journey.withdrawal?.balanceBefore, requestedAmount: journey.withdrawal?.requestedAmount,
    submittedAvailableBalance: journey.withdrawal?.submittedBalance, feeAmount: journey.withdrawal?.feeAmount,
    actualDebitAmount: journey.withdrawal?.balanceAfter ? new Decimal(journey.withdrawal.balanceBefore).minus(journey.withdrawal.balanceAfter).toString() : undefined, afterApprovedAvailableBalance: journey.withdrawal?.balanceAfter,
    withdrawalOrderId: state?.clientReference, clientWithdrawalStatus: journey.withdrawal?.clientStatus,
    adminStatusAfter: journey.withdrawal?.adminStatus, confirmationClicks: journey.withdrawal?.confirmationClicks ?? 0,
    securityVerificationClicks: journey.withdrawal?.securityVerificationClicks ?? 0, approvalClicks: journey.withdrawal?.approvalClicks ?? 0,
    beneficiaryAccountSuffix: `****${journey.fiatAddressAccountSuffix}`, resumeStage: state?.stage ?? 'PREPARED'
  });
  business.flow(FLOW_ID, { preconditions: ['同一Journey已完成KYC、银行地址审核和真实入金', '双端有效认证及Sandbox资金授权'], expectedResult: '仅一笔原用户出金，Admin唯一定位、详情核对、审核通过并进入终态，原TXN完成；余额只作非计分诊断。' });
  reportSnapshot();
  try {
    await business.step({ action: '1. 原用户干净登录、双端认证与原银行地址预检', expected: '不创建用户、入金或地址；两端认证有效，原银行地址已通过。' }, async context => {
      await runWithdrawalAuthPreflight({ clientPage: client.page, adminPage, clientBaseUrl: env.client.baseUrl!, adminBaseUrl: env.admin.baseUrl!, guard });
      guard.assertClientSubmissionAllowed(env.exchange.allowMoneyTests, env.allowAdminMutationTests);
      getClientSecurityKey();
      const banks = new AdminFiatAccountReviewPage(adminPage);
      await banks.goto(env.admin.baseUrl!, '已通过');
      const result = await banks.locateCandidate({ email: source.email, displayName: source.displayName!, bankName: `FIDERE SANDBOX BANK ${source.displayName!.split(' ').at(-1)}`, bankAccount: `88000000${String(source.sequence).padStart(4, '0')}` });
      expect(result.candidateCount).toBe(1);
      expect(result.candidates[0].accountId === journey.fiatAddressReference).toBe(true);
      context.setActual(`原用户${source.displayName}干净登录；Admin与已通过银行地址有效。`);
    });

    if (!state || state.stage === 'PREPARED') {
      await business.step({ action: '2. 保存实时余额与唯一金额，排除既有待处理冲突', expected: '金额小于原用户实时余额，历史金额未复用，Admin无同指纹待处理记录。' }, async context => {
        await history.goto(env.client.baseUrl!);
        const previous = await history.readRecords();
        const amount = deriveUnusedWithdrawalAmount(runId, config.uniqueAmountBase, config.amountPrecision, previous.map(record => record.requestedAmount));
        const accounts = new AccountDetailPage(client.page);
        await accounts.goto(env.client.baseUrl!);
        const balance = await accounts.readAvailableBalance(config.accountType, config.currency);
        expect(amount.isPositive() && amount.lessThan(balance.availableBalance)).toBe(true);
        state = createPreparedFlowState({ runId, flowId: FLOW_ID, amount: amount.toFixed(config.amountPrecision), currency: config.currency });
        journey.withdrawal = { runId, accountType: config.accountType, currency: config.currency, requestedAmount: state.amount!, balanceBefore: balance.availableBalance.toString(), previousTransactionIds: previous.map(record => record.clientWithdrawalId), confirmationClicks: 0, securityVerificationClicks: 0, approvalClicks: 0 };
        store.save(state); saveSnapshot();
        await adminList.goto(env.admin.baseUrl!);
        await adminList.selectStatus('待处理');
        await adminList.searchCustomerEmail(source.email);
        const diagnostic = await adminList.diagnoseCandidates({ runId, userIdentity: source.email, accountType: config.accountType, currency: config.currency, requestedAmount: state.amount!, clientSubmittedAtMs: Date.now(), adminStatus: '待处理' }, config.matchWindowMs, { applyTimeWindow: false });
        expect(diagnostic.candidates).toHaveLength(0);
        context.setBusinessData({ preSubmitAdminCandidateCount: 0, preSubmitAdminCandidateStages: diagnostic.counts });
        reportSnapshot();
        context.setActual(`可用余额=${balance.availableBalance}；本笔金额=${amount} ${config.currency}；待处理冲突=0。总余额/冻结余额页面未独立提供。`);
      });
      await business.step({ action: '3. 填写原收款账户、用途、转账方式及支持文件，核对确认页', expected: '真实确认页的原用户、香港账户、USD及精确金额一致；不把缺失费用当免费。' }, async context => {
        await withdrawal.goto(env.client.baseUrl!);
        await withdrawal.selectAccount(config.accountType);
        await withdrawal.selectCurrency(config.currencyLabel);
        const current = await withdrawal.readBalanceSnapshot();
        expect(current.availableBalance.equals(journey.withdrawal!.balanceBefore)).toBe(true);
        await withdrawal.selectBeneficiary({ name: source.displayName!, accountSuffix: journey.fiatAddressAccountSuffix!, currency: config.currency });
        await withdrawal.selectPurpose(config.purpose);
        await withdrawal.selectTransferMethod(config.transferMethod);
        await withdrawal.uploadSupportingDocument(config.supportingDocumentPath);
        await withdrawal.fillAmount(state!.amount!);
        const quote = await withdrawal.continueToConfirmation();
        expect(quote.accountType).toBe(config.accountType);
        expect(quote.beneficiary === source.displayName).toBe(true);
        expect(decimalFromText(quote.requestedAmountText, 'requested amount').equals(state!.amount!)).toBe(true);
        await testInfo.attach('pre-submit-quote', { body: JSON.stringify({ amount: state!.amount, currency: config.currency, fee: quote.feeText, debit: quote.actualDebitText, beforeBalance: journey.withdrawal!.balanceBefore }), contentType: 'application/json' });
        context.setActual(`确认页金额=${state!.amount}；手续费=${quote.feeText}；实际扣款=${quote.actualDebitText}。订单生成后读取真实费用，不将缺失值视为0。`);
      });
      await business.step({ action: '4. 确认一次出金并验证一次安全密钥', expected: '每次最终点击前持久化尝试状态；不重试或重建申请。' }, async context => {
        guard.assertClientSubmissionAllowed(env.exchange.allowMoneyTests, env.allowAdminMutationTests);
        state = advanceFlowState(state!, 'CLIENT_SUBMIT_ATTEMPTED', { clientSubmittedAt: new Date().toISOString() });
        store.save(state);
        context.disallowSafeRerun();
        try { await withdrawal.openSecurityKeyDialogOnce(); }
        finally { journey.withdrawal!.confirmationClicks = withdrawal.confirmationClicks() as 0 | 1; saveSnapshot(); reportSnapshot(); }
        state = advanceFlowState(state, 'SECURITY_KEY_VERIFICATION_ATTEMPTED'); store.save(state);
        context.markPotentiallySubmitted(); observingSubmission = true;
        try { await withdrawal.verifySecurityKeyOnce(getClientSecurityKey(), env.exchange.allowMoneyTests, env.allowAdminMutationTests); }
        finally { journey.withdrawal!.securityVerificationClicks = withdrawal.securityVerificationClicks() as 0 | 1; saveSnapshot(); reportSnapshot(); await testInfo.attach('safe-submission-network', { body: JSON.stringify(network), contentType: 'application/json' }); }
        business.markMutationPerformed('同一Journey客户端出金申请');
        context.setActual('确认转账1次，安全密钥验证1次，后续仅核对本笔申请。');
      });
      await business.step({ action: '5. 确认新出金申请落库，读取真实TXN和费用', expected: '新候选=1，详情TXN、金额、币种、账户一致。不能只凭HTTP 200。' }, async context => {
        let diagnostic: Awaited<ReturnType<WithdrawalHistoryPage['diagnose']>> | undefined;
        try {
          await expect.poll(async () => {
            await history.goto(env.client.baseUrl!);
            diagnostic = await history.diagnose({ accountType: config.accountType, currency: config.currency, requestedAmount: state!.amount!, beneficiaryAccountSuffix: journey.fiatAddressAccountSuffix!, occurredFromMs: Date.parse(state!.clientSubmittedAt!) - config.matchWindowMs, occurredToMs: Date.now() + config.matchWindowMs, excludedLedgerTransactionIds: new Set(journey.withdrawal!.previousTransactionIds) });
            context.setBusinessData({ clientCandidateStageCounts: diagnostic.counts });
            if (diagnostic.candidates.length > 1) throw new Error('Multiple new Withdrawal candidates; no Admin action permitted.');
            return diagnostic.candidates.length;
          }, { timeout: 45_000, message: 'WITHDRAWAL_SUBMISSION_UNCONFIRMED' }).toBe(1);
        } catch (error) {
          context.setBusinessData({ finalStatus: 'WITHDRAWAL_SUBMISSION_UNCONFIRMED' });
          context.requireManualReview('仅查询原用户出金记录和余额，不再提交');
          throw error;
        }
        const record = diagnostic!.candidates[0];
        state = advanceFlowState(state!, 'CLIENT_CREATED', { clientReference: record.clientWithdrawalId }); store.save(state);
        const detail = await (await history.openDetail(record)).readFiatWithdrawalDetail();
        expect(detail.clientWithdrawalId === state.clientReference).toBe(true);
        expect(detail.currency).toBe(config.currency); expect(detail.accountType).toBe(config.accountType);
        expect(new Decimal(detail.requestedAmount).equals(state.amount!)).toBe(true);
        journey.withdrawal!.feeAmount = detail.feeAmount; journey.withdrawal!.clientStatus = detail.status;
        const accounts = new AccountDetailPage(client.page); await accounts.goto(env.client.baseUrl!);
        journey.withdrawal!.submittedBalance = (await accounts.readAvailableBalance(config.accountType, config.currency)).availableBalance.toString();
        saveSnapshot(); reportSnapshot();
        context.recordPrimaryOracle({ id: 'PGJWD-CREATED', name: '原用户唯一出金申请真实存在', expected: '一笔新的TXN详情', actual: '新增候选=1，TXN、币种、金额及账户一致', status: 'passed' });
        context.setActual(`已取得本笔TXN；真实手续费=${detail.feeAmount}；提交后可用余额=${journey.withdrawal!.submittedBalance}。此差额不擅自命名为冻结额。`);
      });
    }
    if (!state?.clientReference || !journey.withdrawal?.feeAmount) throw new Error('Existing withdrawal reference and fee evidence are required.');
    guard.recordClientSubmission(state.clientReference);
    business.disallowSafeRerun();
    const fingerprint: WithdrawalFingerprint = { runId, userIdentity: source.email, accountType: config.accountType, currency: config.currency, requestedAmount: state.amount!, clientSubmittedAtMs: Date.parse(state.clientSubmittedAt!), adminStatus: '待处理' };
    const snapshot = journey.withdrawal;
    if (stageIndex(state.stage) < stageIndex('FIDERE_APPROVAL_ATTEMPTED')) {
      await business.step({ action: '6. Admin邮箱和业务指纹唯一定位，详情二次核对', expected: '候选严格=1；客户、USD、金额、手续费、收款人、时间及待处理状态均匹配。' }, async context => {
        await adminList.goto(env.admin.baseUrl!); await adminList.selectStatus('待处理'); await adminList.searchCustomerEmail(source.email);
        const diagnostic = await adminList.diagnoseCandidates(fingerprint, config.matchWindowMs);
        context.setBusinessData({ candidateCount: diagnostic.candidates.length, candidateStageCounts: diagnostic.counts });
        requireUniqueAdminWithdrawalCandidate(diagnostic.candidates); guard.recordUniqueAdminCandidate(diagnostic.candidates.length);
        const live = await adminList.locateFingerprintCandidate(fingerprint, config.matchWindowMs);
        const detailPage = await adminList.openDetail(live); const detail = await detailPage.readDetail();
        expect(matchesDepositCustomerIdentity(detail.customerText, source.email)).toBe(true);
        expect(live.currency).toBe(config.currency); expect(detail.accountType).toBe(config.accountType);
        expect(new Decimal(detail.requestedAmount).equals(snapshot.requestedAmount)).toBe(true);
        expect(new Decimal(detail.feeAmount).equals(snapshot.feeAmount!)).toBe(true);
        expect(detail.beneficiaryText.includes(source.displayName!)).toBe(true);
        expect(detail.purpose).toBe(config.purpose); expect(detail.status).toBe('待处理');
        expect(detail.submittedAt).toContain(live.submittedAtText);
        const bank = await detailPage.readBeneficiaryBankIfPresent();
        if (bank) expect(bank.includes(`FIDERE SANDBOX BANK ${source.displayName!.split(' ').at(-1)}`)).toBe(true);
        const settlement = withdrawalDebitFromSettlement(new Decimal(detail.requestedAmount), new Decimal(detail.feeAmount), new Decimal(detail.netAmount));
        expect(settlement.debit.lessThan(new Decimal(snapshot.balanceBefore))).toBe(true);
        snapshot.netAmount = detail.netAmount; snapshot.expectedDebit = settlement.debit.toString(); saveSnapshot();
        if (state!.stage !== 'ADMIN_LOCATED') { state = advanceFlowState(state!, 'ADMIN_LOCATED', { adminReference: detail.adminTransactionId ?? live.recordKey }); store.save(state); }
        approval = detailPage.approvalForm();
        context.setBusinessData({ detailVerified: true, adminStatusBefore: detail.status });
        context.recordPrimaryOracle({ id: 'PGJWD-ADMIN-UNIQUE', name: 'Admin候选唯一且核心详情一致', expected: 'candidateCount=1，二次核对通过', actual: 'candidateCount=1，详情一致', status: 'passed' });
        context.setActual(`Admin唯一候选，详情匹配。订单金额=${detail.requestedAmount}，费用=${detail.feeAmount}，实际到账=${detail.netAmount}，扣款规则=${settlement.rule}，预期扣款=${settlement.debit}。`);
      });
      await business.step({ action: '7. 复用既有批准表单，最终批准仅一次', expected: '渠道、银行、凭证、备注均满足后单次批准；不创建其他资金申请。' }, async context => {
        const note = buildWithdrawalApprovalNote(runId, approvalConfig.approvalNotePrefix);
        const channels = await approval!.readPaymentChannelOptions();
        const channel = [snapshot.paymentChannel, approvalConfig.paymentChannel, config.transferMethod]
          .find(value => value && channels.includes(value));
        if (!channel) throw new Error('No current payout channel matches the configured channel or Client transfer method.');
        snapshot.paymentChannel = channel; snapshot.paymentBank = approvalConfig.paymentBank; saveSnapshot();
        context.setBusinessData({ selectedPaymentChannel: channel, selectedPaymentBank: approvalConfig.paymentBank });
        await approval!.fillApprovalForm({ paymentChannel: channel, paymentBank: approvalConfig.paymentBank, proof, approvalNote: note });
        await approval!.assertRequiredFieldsSatisfied({ paymentChannel: channel, paymentBank: approvalConfig.paymentBank, proofFileName: proof.fileName, approvalNote: note });
        guard.assertAdminMutationAllowed(env.exchange.allowMoneyTests, env.allowAdminMutationTests);
        state = advanceFlowState(state!, 'FIDERE_APPROVAL_ATTEMPTED'); store.save(state);
        context.markPotentiallySubmitted();
        try { await approval!.confirmApprove(); }
        finally { snapshot.approvalClicks = approval!.approvalClicks() as 0 | 1; saveSnapshot(); reportSnapshot(); }
        context.setActual('既有批准表单完整填写；Admin批准点击1次。');
      });
    }
    await business.step({ action: '8. 只读等待原Admin出金进入成功终态', expected: '同一业务指纹候选唯一且状态成功，绝不再次批准。' }, async context => {
      await expect.poll(async () => {
        await adminList.goto(env.admin.baseUrl!); await adminList.searchCustomerEmail(source.email);
        const matches = matchAdminWithdrawalRecordsIgnoringStatus(await adminList.readAllFilteredRecords(), fingerprint, config.matchWindowMs);
        snapshot.adminStatus = matches.length === 1 ? matches[0].status : `candidateCount=${matches.length}`;
        saveSnapshot(); return snapshot.adminStatus;
      }, { timeout: 90_000 }).toMatch(ADMIN_DONE);
      if (stageIndex(state!.stage) < stageIndex('ADMIN_ACTION_DONE')) { state = advanceFlowState(state!, 'ADMIN_ACTION_DONE'); store.save(state); }
      context.recordPrimaryOracle({ id: 'PGJWD-ADMIN-DONE', name: 'Admin成功终态', expected: '原申请批准成功', actual: snapshot.adminStatus!, status: 'passed' });
      context.setActual(`Admin状态=${snapshot.adminStatus}；批准次数=${snapshot.approvalClicks}。`);
    });
    await business.step({ action: '9. 原用户重新干净登录，验证同一TXN完成和无重复出金', expected: '原TXN、金额、币种、账户不变，已完成；新增出金仅这一笔。' }, async context => {
      await client.context.close();
      client = await openPersonalJourneyClientSession({ browser, baseURL: env.client.baseUrl!, runId: sourceRunId, email: source.email, password: env.client.password!, otp: env.client.otp!, forceFreshLogin: true });
      history = new WithdrawalHistoryPage(client.page);
      await expect.poll(async () => {
        await history.goto(env.client.baseUrl!); await history.transactions.searchByBusinessId(state!.clientReference!);
        const record = await history.recordById(state!.clientReference!);
        if (record) {
          expect(record.accountType).toBe(config.accountType); expect(record.currency).toBe(config.currency);
          expect(new Decimal(record.requestedAmount).equals(snapshot.requestedAmount)).toBe(true);
        }
        snapshot.clientStatus = record?.status ?? 'missing'; saveSnapshot(); return snapshot.clientStatus;
      }, { timeout: 90_000 }).toMatch(CLIENT_DONE);
      await history.goto(env.client.baseUrl!);
      const extra = (await history.readRecords()).filter(record => !snapshot.previousTransactionIds.includes(record.clientWithdrawalId));
      expect(extra.length).toBe(1); expect(extra[0].clientWithdrawalId === state!.clientReference).toBe(true);
      if (stageIndex(state!.stage) < stageIndex('CLIENT_FINALIZED')) { state = advanceFlowState(state!, 'CLIENT_FINALIZED'); store.save(state); }
      context.recordPrimaryOracle({ id: 'PGJWD-CLIENT-DONE', name: '同一原TXN完成且无重复申请', expected: '原TXN已完成、新增仅1笔', actual: snapshot.clientStatus!, status: 'passed' });
      context.setActual(`原用户干净登录后，原TXN=${snapshot.clientStatus}，新增出金仅1笔。`);
    });
    // The approved acceptance criteria treat balances as non-scoring diagnostics.
    try {
      const accounts = new AccountDetailPage(client.page); await accounts.goto(env.client.baseUrl!);
      const after = await accounts.readAvailableBalance(config.accountType, config.currency);
      snapshot.balanceAfter = after.availableBalance.toString(); saveSnapshot(); reportSnapshot();
      business.recordDiagnostic({ id: 'PGJWD-BALANCE', name: '出金余额快照（非计分）', status: 'info', summary: `提交前=${snapshot.balanceBefore}；提交后=${snapshot.submittedBalance}；批准后=${snapshot.balanceAfter} ${config.currency}；订单金额=${snapshot.requestedAmount}；手续费=${snapshot.feeAmount}。`, reason: '余额公式按最新验收要求不参与PASS/FAIL、Warning或人工核查判定。', affectsCoreBusiness: false });
    } catch {
      business.recordDiagnostic({ id: 'PGJWD-BALANCE', name: '出金余额快照（非计分）', status: 'unavailable', summary: '辅助余额快照未取得；Admin批准和原TXN完成已经确认。', affectsCoreBusiness: false });
    }
    state = advanceFlowState(state!, 'COMPLETED'); store.save(state); reportSnapshot();
    business.setBusinessData({ confirmed: true, finalStatus: 'WITHDRAWAL_COMPLETED', safeToRerun: false });
  } catch (error) {
    reportSnapshot();
    if (journey.withdrawal?.securityVerificationClicks) {
      business.disallowSafeRerun();
      if (!state?.clientReference || journey.withdrawal.approvalClicks) business.requireManualReview('仅查询原TXN、Admin状态和余额，禁止新建或重复审核');
    }
    throw error;
  } finally {
    await testInfo.attach('safe-withdrawal-network-final', { body: JSON.stringify(network), contentType: 'application/json' });
    reportSnapshot();
    await client.context.close();
  }
});
