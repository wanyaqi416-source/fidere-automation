import { test, expect } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { MoneyMutationGuard, assertSandboxEnvironment, stageIndex } from '../../../src/flow-engine';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { WealthOrderListPage, type WealthAdminCandidate } from '../../../pages/admin/WealthOrderListPage';
import { FundTradingPage, type WealthHistoryRecord } from '../../../pages/client/FundTradingPage';
import { FundSubscribePage } from '../../../pages/client/FundSubscribePage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { RegistrationKycStatusPage } from '../../../pages/client/RegistrationKycStatusPage';
import { Decimal } from '../../../src/utils/money';
import { diagnoseWealthOrderCandidates } from '../../../src/wealth/wealth-e2e';
import { WealthJourneyStore, verifyWealthIdentity, uniqueSubscriptionAmount, matchingNewWealthOrders } from '../../../src/wealth/wealth-journey';
import { assertOriginalRejectedSubscription, compareRejectedHolding, rejectionFundsRestored,
  SUBSCRIPTION_REJECTION_STAGES } from '../../../src/wealth/wealth-subscription-rejection';
import { maskSensitiveText } from '../../../src/reporting/sensitive-data-mask';

test.describe.configure({ mode: 'serial', retries: 0 });
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test('WS-002 理财认购拒绝、资金恢复且无新增有效持仓', { tag: ['@wealth', '@money', '@mutation', '@L4'] },
async ({ clientPage, adminPage, browser, business }, testInfo) => {
  test.setTimeout(600_000);
  business.flow('wealth-subscribe-reject');
  const runId = process.env.WEALTH_RUN_ID, authorizedAmount = process.env.WEALTH_AUTHORIZED_AMOUNT;
  const authorizedProduct = process.env.WEALTH_AUTHORIZED_PRODUCT;
  if (!runId || !authorizedAmount || !authorizedProduct || process.env.WEALTH_AUTHORIZED_ACTION !== 'reject' ||
    !process.env.WEALTH_TEST_USERNAME || env.client.username !== process.env.WEALTH_TEST_USERNAME) {
    throw new Error('BLOCKED_AUTHORIZATION: Named Run, selected user/product, exact amount and reject authorization are required before subscription.');
  }
  const switches = { ALLOW_MONEY_TESTS: env.exchange.allowMoneyTests, ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests };
  const guard = new MoneyMutationGuard('wealth-subscribe-reject', true, true);
  guard.validateRuntime({ baseURL: env.client.baseUrl, workers: testInfo.config.workers,
    retries: testInfo.project.retries, repeatEach: testInfo.project.repeatEach, safetySwitches: switches });
  assertSandboxEnvironment(env.admin.baseUrl);
  if (!env.client.securityKey || !env.client.password || !env.client.otp) throw new Error('Configured Client credentials are required.');
  const store = new WealthJourneyStore('subscription', runId, env.client.username!, process.env.WEALTH_RESUME === 'true', { decision: 'reject' });
  const e = store.evidence;
  if (e.completed) throw new Error('This rejection Run is completed; never resubmit or reject again.');
  if (e.amount) expect(new Decimal(e.amount).eq(authorizedAmount), 'Resume amount must retain original authorization').toBe(true);
  if (e.productName) expect(e.productName, 'Resume product must retain original authorization').toBe(authorizedProduct);
  const funds = new FundTradingPage(clientPage), subscribe = new FundSubscribePage(clientPage);
  const admin = new WealthOrderListPage(adminPage), accounts = new AccountDetailPage(clientPage);
  let clean: Awaited<ReturnType<typeof RegistrationKycStatusPage.cleanLogin>> | undefined;
  let currentPrimary = 'WS002-PREFLIGHT';
  const report = () => {
    business.setResumeState(e.rejectionStage ?? store.state.stage);
    business.setBusinessData({ sourceRunId: runId, senderIdentity: maskSensitiveText(env.client.username!),
      selectedProduct: e.productName, wealthProductId: e.productId, purchaseAccount: e.purchaseAccount,
      sourceAmount: e.amount, fromCurrency: e.currency, feeAmount: e.fee, subscriptionOrderId: e.clientOrder?.orderId,
      candidateCount: e.candidateCount, wealthClientStatus: e.clientStatus, wealthAdminStatus: e.adminStatus,
      wealthRejectionReason: e.rejectionReason, beforeAvailableBalance: e.before?.available, beforeTotalBalance: e.before?.total,
      submittedAvailableBalance: e.submitted?.available, submittedTotalBalance: e.submitted?.total,
      afterRejectedAvailableBalance: e.after?.available, afterRejectedTotalBalance: e.after?.total,
      wealthBalanceSnapshots: JSON.stringify({ before: e.before, afterSubmit: e.submitted, afterReject: e.after }),
      wealthHoldingEvidence: JSON.stringify({ before: e.oldPositions, after: e.positionsAfter }),
      finalSubmissionClicks: e.confirmationClicks, securityVerificationClicks: e.securityVerificationClicks,
      adminMutationClicks: e.adminRejectionClicks ?? 0, approvalClicks: e.adminApprovalClicks, safeToRerun: false });
  };
  const advance = (stage: typeof SUBSCRIPTION_REJECTION_STAGES[number]) => {
    if (SUBSCRIPTION_REJECTION_STAGES.indexOf(stage) > SUBSCRIPTION_REJECTION_STAGES.indexOf(e.rejectionStage as typeof stage)) {
      e.rejectionStage = stage;
    }
    store.save(); report();
  };
  const passed = (name: string, actual: string) => business.recordPrimaryOracle({ id: currentPrimary, name, expected: name, actual, status: 'passed' });
  const readonlyAdmin = async () => {
    await admin.goto(env.admin.baseUrl!, 'subscription');
    const rows = await admin.findExactOrder(e.clientOrder!.orderId, 'subscription');
    e.candidateCount = rows.length;
    if (rows.length === 1) e.adminStatus = rows[0].status;
    store.save(); report();
    return rows;
  };
  try {
    await business.step({ action: '双端认证与原用户KYC预检', expected: '同一已有账号、Admin业务页可访问，资金和拒绝权限同时有效' }, async ({ setActual }) => {
      const shell = new AdminShellPage(adminPage); await shell.goto(env.admin.baseUrl!); await shell.expectSessionActive();
      await admin.goto(env.admin.baseUrl!, 'subscription'); await funds.goto(env.client.baseUrl!);
      const identity = await verifyWealthIdentity(clientPage, env.client.baseUrl!, env.client.username!);
      if (e.userId) expect(identity.userId).toBe(e.userId);
      e.userId = identity.userId; guard.markAuthenticationReady(true, true); store.save();
      setActual('认证和KYC有效；不注册、不入金、不访问赎回管理。');
    });
    if (store.state.stage === 'PREPARED') {
      await business.step({ action: '记录产品、账户、资金和原有持仓', expected: '运行时选择合法小额，保留原订单与完整持仓基线' }, async ({ setActual }) => {
        await funds.openPositions(); e.oldPositions = await funds.readCompletePositions();
        const history = await funds.readHistory('申购', 0, true); e.oldOrderIds = history.map(row => row.orderId);
        await funds.openCatalog();
        const eligible = (await funds.readProducts()).filter(p => p.name === authorizedProduct && p.currency === 'USD' && new Decimal(p.minimumInvestment).gt(0));
        expect(eligible, 'Only the explicitly authorized USD product may be subscribed').toHaveLength(1);
        const product = eligible[0];
        e.productName = product.name; e.currency = product.currency; e.amount = uniqueSubscriptionAmount(product.minimumInvestment, runId);
        expect(new Decimal(e.amount).eq(authorizedAmount), 'Named Run exact amount').toBe(true);
        expect(history.filter(row => row.productName === e.productName && row.currency === e.currency && new Decimal(row.amount).eq(e.amount!)), 'Do not reuse a historical test amount').toHaveLength(0);
        await funds.openSubscription(product.name); await subscribe.expectLoaded();
        e.productId = new URL(clientPage.url()).searchParams.get('id') ?? undefined;
        expect(e.productId, 'Product identity is required for no-active-holding oracle').toBeTruthy();
        const account = (await subscribe.readPaymentAccounts()).find(row => row.currency === e.currency && row.accountType === '香港账户' && new Decimal(row.balance).gt(e.amount!));
        if (!account) throw new Error('BLOCKED_TEST_DATA: Existing Hong Kong USD balance insufficient.');
        e.purchaseAccount = account.accountType;
        await accounts.goto(env.client.baseUrl!); e.before = await accounts.readSnapshot(e.purchaseAccount, e.currency);
        advance('INVESTMENT_READY'); setActual(`金额${e.amount} USD；可用${e.before.available}，冻结${e.before.frozen}，总额${e.before.total}。`);
      });
      await business.step({ action: '提交唯一认购并安全验证一次', expected: '真实摘要一致；确认1次、安全密钥验证1次，后续只查询原申请' }, async ({ setActual }) => {
        await funds.goto(env.client.baseUrl!); await funds.openCatalog(); await funds.openSubscription(e.productName!);
        expect(new URL(clientPage.url()).searchParams.get('id')).toBe(e.productId);
        await subscribe.selectPaymentAccount(e.purchaseAccount!); await subscribe.fillAmount(e.amount!); await subscribe.acceptTerms();
        const quote = await subscribe.readSnapshot();
        expect(quote.productName).toBe(e.productName); expect(quote.paymentAccount).toBe(e.purchaseAccount); expect(quote.currency).toBe(e.currency);
        expect(new Decimal(quote.amount).eq(e.amount!)).toBe(true); expect(new Decimal(e.before!.available).gt(quote.totalAmount)).toBe(true);
        expect(quote.submitEnabled && quote.termsAccepted).toBe(true); e.fee = quote.feeAmount; e.expectedDebit = quote.totalAmount;
        guard.assertClientMoneyConfirmationAllowed(switches); guard.recordClientMoneyConfirmation();
        e.confirmationClicks = 1; store.advance('CLIENT_SUBMIT_ATTEMPTED'); business.disallowSafeRerun(); report();
        const security = await subscribe.confirmOnce(); await security.fill(env.client.securityKey!);
        guard.assertSecurityKeyVerificationAllowed(switches); guard.recordSecurityKeyVerification();
        e.securityVerificationClicks = 1; e.createdAt = new Date().toISOString();
        store.advance('SECURITY_KEY_VERIFICATION_ATTEMPTED'); business.markPotentiallySubmitted(); report();
        try { await security.verifyOnce(); }
        catch { business.recordDiagnostic({ id: 'WS002-SECURITY-OBSERVATION', name: '验证后UI观察', status: 'unavailable',
          summary: '验证已尝试一次，仅查询业务记录，不再次验证。', affectsCoreBusiness: false }); }
        setActual('认购确认与安全验证各1次，接下来查询真实INV；不以Toast判成功。');
      });
    } else {
      if (e.confirmationClicks) guard.recordClientMoneyConfirmation();
      if (e.securityVerificationClicks) guard.recordSecurityKeyVerification();
    }
    currentPrimary = 'WS002-CLIENT-CREATED';
    await business.step({ action: '确认唯一真实INV申请并记录提交后的资金', expected: '产品、账户、金额、时间一致；申请已存在才允许Admin操作' }, async ({ setActual }) => {
      let matches: WealthHistoryRecord[] = [];
      await expect.poll(async () => {
        await funds.goto(env.client.baseUrl!); matches = matchingNewWealthOrders(await funds.readHistory('申购', 0, true), e);
        if (matches.length > 1) throw new Error('INVESTMENT_SUBSCRIPTION_UNCONFIRMED: Multiple matching new orders; no Admin mutation.');
        return matches.length;
      }, { timeout: 90_000, intervals: [1_000, 3_000], message: 'INVESTMENT_SUBSCRIPTION_UNCONFIRMED' }).toBe(1);
      if (e.clientOrder) expect(matches[0].orderId).toBe(e.clientOrder.orderId);
      e.clientOrder = matches[0]; e.clientStatus = matches[0].status;
      if (stageIndex(store.state.stage) < stageIndex('CLIENT_CREATED')) store.advance('CLIENT_CREATED', { clientReference: e.clientOrder.orderId, clientSubmittedAt: e.createdAt });
      guard.recordClientSubmission(); advance('SUBSCRIPTION_SUBMITTED');
      passed('Client真实创建且仅创建本次唯一认购', `${maskSensitiveText(e.clientOrder.orderId)}；${e.clientStatus}`);
      if (!e.submitted) {
        if (e.adminRejectionClicks) throw new Error('Original submitted balance snapshot missing; do not replace it with a post-reject value.');
        await accounts.goto(env.client.baseUrl!); e.submitted = await accounts.readSnapshot(e.purchaseAccount!, e.currency!);
      }
      advance('FUNDS_RESERVED_OR_DEDUCTED');
      setActual(`提交后可用${e.submitted.available}，冻结${e.submitted.frozen}，总额${e.submitted.total}；不预设扣款时点。`);
    });
    currentPrimary = 'WS002-ADMIN-MATCH';
    await business.step({ action: 'Admin按原INV唯一定位并二次核对', expected: '用户、产品、币种、精确金额、账户、手续费、时间与原申请一致' }, async ({ setActual }) => {
      let candidates: WealthAdminCandidate[] = [];
      await expect.poll(async () => {
        candidates = await readonlyAdmin();
        if (candidates.length > 1) throw new Error('Admin candidateCount > 1; reject forbidden.');
        return candidates.length;
      }, { timeout: 75_000, intervals: [1_000, 3_000] }).toBe(1);
      const detail = await admin.openDetails(candidates[0]);
      const match = diagnoseWealthOrderCandidates([detail.record], { orderId: e.clientOrder!.orderId, kind: 'subscription',
        customerIdentity: env.client.username!, productName: e.productName!, currency: e.currency!, amount: e.amount!,
        status: candidates[0].status, submittedAtMs: Date.parse(e.createdAt!), matchWindowMs: 300_000 });
      business.setBusinessData({ candidateStages: match.stages });
      expect(match.candidates).toHaveLength(1); expect(detail.account).toBe(e.purchaseAccount);
      expect(new Decimal(detail.fee).eq(e.fee!)).toBe(true);
      expect(candidates[0].status !== '已通过', 'Do not reject an approved historical subscription').toBe(true);
      guard.recordUniqueAdminCandidate(1);
      if (stageIndex(store.state.stage) < stageIndex('ADMIN_LOCATED')) store.advance('ADMIN_LOCATED', { adminReference: e.clientOrder!.orderId });
      advance('ADMIN_SUBSCRIPTION_FOUND'); passed('Admin候选唯一且详情全部匹配', 'candidateCount=1');
      setActual(`唯一原INV，状态${e.adminStatus}；未选择历史认购。`);
    });
    currentPrimary = 'WS002-ADMIN-REJECTED';
    await business.step({ action: '填写真实拒绝原因并拒绝原认购一次', expected: '拒绝最多1次；请求后只读取原订单终态，不重试' }, async ({ setActual }) => {
      if (!e.adminRejectionClicks) {
        expect(e.adminStatus).toBe('待审核');
        e.rejectionReason = `AUTOMATION INVESTMENT SUBSCRIPTION REJECTION TEST ${runId}`;
        await admin.fillRejectionForm(e.clientOrder!.orderId, e.rejectionReason);
        guard.assertAdminActionAllowed(switches);
        try {
          await admin.rejectOnce(e.clientOrder!.orderId, () => {
            store.reserveRejectionAttempt(); guard.recordAdminAction(); advance('ADMIN_REJECTION_ATTEMPTED');
            business.markMutationPerformed('仅拒绝本次原INV认购一次');
          });
        } catch (error) {
          if (!e.adminRejectionClicks) throw error;
          business.recordDiagnostic({ id: 'WS002-REJECT-OBSERVATION', name: '拒绝后UI观察', status: 'unavailable',
            summary: '最终拒绝已尝试一次，仅重新读取原INV状态，不再次点击。', affectsCoreBusiness: false });
        }
      }
      await expect.poll(async () => {
        const matches = await readonlyAdmin();
        return matches.length === 1 && matches[0].status === '已拒绝';
      }, { timeout: 90_000, intervals: [2_000, 5_000] }).toBe(true);
      expect(e.adminRejectionClicks).toBe(1); expect(e.adminApprovalClicks).toBe(0);
      if (stageIndex(store.state.stage) < stageIndex('ADMIN_ACTION_DONE')) store.advance('ADMIN_ACTION_DONE');
      advance('ADMIN_SUBSCRIPTION_REJECTED'); passed('Admin拒绝一次且原INV进入已拒绝', e.adminStatus!);
      setActual(`拒绝1次，批准0次；原INV在已拒绝Tab，原因${e.rejectionReason}。`);
    });
    currentPrimary = 'WS002-CLIENT-REJECTED';
    await business.step({ action: '干净登录Client核对同一认购拒绝终态', expected: '原INV、产品、金额、付款账户不变；可见拒绝原因一致，无重复认购' }, async ({ setActual }) => {
      clean = await RegistrationKycStatusPage.cleanLogin({ browser, baseURL: env.client.baseUrl!, email: env.client.username!, password: env.client.password!, otp: env.client.otp! });
      const current = new FundTradingPage(clean.statusPage.page);
      await verifyWealthIdentity(clean.statusPage.page, env.client.baseUrl!, env.client.username!);
      await expect.poll(async () => {
        await current.goto(env.client.baseUrl!);
        const history = await current.readHistory('申购', 0, true);
        const original = history.filter(row => row.orderId === e.clientOrder!.orderId);
        if (original.length !== 1) return false;
        e.clientStatus = original[0].status; store.save(); report();
        if (e.clientStatus !== '已拒绝') return false;
        assertOriginalRejectedSubscription(original[0], e);
        expect(matchingNewWealthOrders(history, e)).toHaveLength(1);
        return true;
      }, { timeout: 90_000, intervals: [2_000, 5_000] }).toBe(true);
      if (stageIndex(store.state.stage) < stageIndex('CLIENT_FINALIZED')) store.advance('CLIENT_FINALIZED');
      advance('CLIENT_SUBSCRIPTION_REJECTED'); passed('Client同一认购已拒绝且无重复申请', e.clientStatus!);
      setActual('干净登录后原INV已拒绝，订单核心字段与提交一致；未重新提交。');
    });
    currentPrimary = 'WS002-FUNDS-RESTORED';
    await business.step({ action: '验证认购资金完全恢复', expected: '可用余额、冻结金额和总额分别恢复提交前值，不误释放历史冻结' }, async ({ setActual }) => {
      const afterAccounts = new AccountDetailPage(clean!.statusPage.page);
      await expect.poll(async () => {
        await afterAccounts.goto(env.client.baseUrl!); e.after = await afterAccounts.readSnapshot(e.purchaseAccount!, e.currency!);
        store.save(); report(); return rejectionFundsRestored(e.before!, e.after);
      }, { timeout: 60_000, intervals: [2_000, 5_000] }).toBe(true);
      advance('FUNDS_RESTORED'); passed('认购拒绝后资金完全恢复', '可用、冻结、总余额均与提交前一致');
      setActual(`可用${e.before!.available}→${e.submitted!.available}→${e.after!.available}；冻结${e.before!.frozen}→${e.submitted!.frozen}→${e.after!.frozen}；总额${e.before!.total}→${e.submitted!.total}→${e.after!.total}。`);
    });
    currentPrimary = 'WS002-NO-ACTIVE-HOLDING';
    await business.step({ action: '验证拒绝认购没有生成有效持仓', expected: '完整持仓中该产品本金、有效持有本金和数量均与原基线一致' }, async ({ setActual }) => {
      const current = new FundTradingPage(clean!.statusPage.page); await current.goto(env.client.baseUrl!); await current.openPositions();
      e.positionsAfter = await current.readCompletePositions(); store.save(); report();
      const holding = compareRejectedHolding(e.oldPositions!, e.positionsAfter, e.productId!, e.currency!);
      business.setBusinessData({ wealthHoldingEvidence: JSON.stringify(holding) });
      expect(holding.passed, 'SEVERE: Rejected subscription must not create active holding/principal').toBe(true);
      advance('NO_ACTIVE_HOLDING_VERIFIED'); passed('被拒绝认购不生成有效持仓', JSON.stringify(holding));
      e.completed = true; e.failure = undefined; store.advance('COMPLETED'); report();
      setActual(`产品原本金${holding.before.principal}，最终本金${holding.after.principal}；有效持仓数${holding.before.activeCount}→${holding.after.activeCount}。`);
    });
  } catch (error) {
    e.failure = maskSensitiveText(error instanceof Error ? error.message : String(error)); store.save(); report();
    business.recordPrimaryOracle({ id: currentPrimary, name: '认购拒绝当前阶段', expected: '本阶段业务证据完整', actual: e.failure, status: 'failed' });
    if ((e.securityVerificationClicks && !e.clientOrder) || (e.adminRejectionClicks && !['已拒绝', '已通过'].includes(e.adminStatus ?? ''))) {
      business.requireManualReview('仅查询同一INV、购买账户和持仓；禁止再次认购或拒绝。');
    }
    if (/BLOCKED_/.test(e.failure)) testInfo.annotations.push({ type: 'blocker', description: e.failure });
    throw error;
  } finally {
    report(); if (clean) await clean.context.close();
  }
});
