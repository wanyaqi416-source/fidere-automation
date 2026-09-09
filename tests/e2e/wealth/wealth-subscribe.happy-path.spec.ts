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
import { WealthJourneyStore, verifyWealthIdentity, uniqueSubscriptionAmount, matchingNewWealthOrders, observeWealthNetwork } from '../../../src/wealth/wealth-journey';
import { maskSensitiveText } from '../../../src/reporting/sensitive-data-mask';

test.describe.configure({ mode: 'serial', retries: 0 });
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test('WS-003 独立理财认购审核通过Golden Journey', { tag: ['@wealth', '@money', '@mutation', '@L4'] },
async ({ clientPage, adminPage, browser, business }, testInfo) => {
  test.setTimeout(600_000);
  business.flow('wealth-subscribe-approve');
  const runId = process.env.WEALTH_RUN_ID;
  const authorizedAmount = process.env.WEALTH_AUTHORIZED_AMOUNT;
  if (!runId || !process.env.WEALTH_TEST_USERNAME || env.client.username !== process.env.WEALTH_TEST_USERNAME) {
    throw new Error('A named Wealth Run and the explicitly selected Client identity are required.');
  }
  if (!authorizedAmount || !new Decimal(authorizedAmount).isPositive()) {
    throw new Error('The explicitly authorized subscription amount is required.');
  }
  const switches = { ALLOW_MONEY_TESTS: env.exchange.allowMoneyTests, ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests };
  const guard = new MoneyMutationGuard('wealth-subscription', true, true);
  guard.validateRuntime({ baseURL: env.client.baseUrl, workers: testInfo.config.workers,
    retries: testInfo.project.retries, repeatEach: testInfo.project.repeatEach, safetySwitches: switches });
  assertSandboxEnvironment(env.admin.baseUrl);
  if (!env.client.securityKey || !env.client.password || !env.client.otp) throw new Error('Configured Client credentials and Security Key are required.');
  const store = new WealthJourneyStore('subscription', runId, env.client.username!, process.env.WEALTH_RESUME === 'true');
  const e = store.evidence;
  if (e.completed) throw new Error('This subscription Journey is already completed; do not rerun it.');
  const funds = new FundTradingPage(clientPage), subscribe = new FundSubscribePage(clientPage);
  const admin = new WealthOrderListPage(adminPage), accounts = new AccountDetailPage(clientPage);
  let clean: Awaited<ReturnType<typeof RegistrationKycStatusPage.cleanLogin>> | undefined;
  const stopClient = observeWealthNetwork(clientPage, entries => business.setBusinessData({ safePostSubmitNetworkMetadata: entries.join('\n') }));
  const stopAdmin = observeWealthNetwork(adminPage, entries => business.setBusinessData({ safeRequestEvidence: entries.join('\n') }));
  const report = () => {
    business.setResumeState(store.state.stage);
    business.setBusinessData({ selectedProduct: e.productName, wealthProductId: e.productId, purchaseAccount: e.purchaseAccount,
      sourceAmount: e.amount, fromCurrency: e.currency, feeAmount: e.fee, investmentOrderId: e.clientOrder?.orderId,
      subscriptionOrderId: e.clientOrder?.orderId, candidateCount: e.candidateCount,
      wealthClientStatus: e.clientStatus, wealthAdminStatus: e.adminStatus,
      beforeAvailableBalance: e.before?.available, beforeTotalBalance: e.before?.total,
      submittedAvailableBalance: e.submitted?.available, submittedTotalBalance: e.submitted?.total,
      afterApprovedAvailableBalance: e.after?.available, afterApprovedTotalBalance: e.after?.total,
      wealthBalanceSnapshots: JSON.stringify({ before: e.before, submitted: e.submitted, after: e.after }),
      finalSubmissionClicks: e.confirmationClicks, securityVerificationClicks: e.securityVerificationClicks,
      approvalClicks: e.adminApprovalClicks, safeToRerun: false });
  };
  const primary = (id: string, name: string, actual: string) => business.recordPrimaryOracle({ id, name,
    expected: name, actual, status: 'passed' });
  try {
    await business.step({ action: '双端认证及Sandbox预检', expected: '指定现有账号KYC已通过，Admin业务页有效，单次执行开关有效' }, async ({ setActual }) => {
      const shell = new AdminShellPage(adminPage); await shell.goto(env.admin.baseUrl!); await shell.expectSessionActive();
      await admin.goto(env.admin.baseUrl!, 'subscription');
      await funds.goto(env.client.baseUrl!);
      const identity = await verifyWealthIdentity(clientPage, env.client.baseUrl!, env.client.username!);
      e.userId = identity.userId; guard.markAuthenticationReady(true, true); store.save();
      setActual('同一测试用户KYC已通过；Admin认证有效；workers=1、retries=0、repeatEach=1。');
    });
    if (store.state.stage === 'PREPARED') {
      await business.step({ action: '记录原有持仓、订单和认购前余额', expected: '运行时选择小额合法产品，保留现有余额且不入金' }, async ({ setActual }) => {
        await funds.openPositions(); e.oldPositions = await funds.readPositions();
        e.oldOrderIds = (await funds.readHistory('申购', 0, true)).map(row => row.orderId);
        await funds.openCatalog();
        const products = (await funds.readProducts()).filter(row => row.currency === 'USD' && new Decimal(row.minimumInvestment).gt(0))
          .sort((a, b) => new Decimal(a.minimumInvestment).comparedTo(b.minimumInvestment) || a.name.localeCompare(b.name));
        if (!products.length) throw new Error('BLOCKED_TEST_DATA: No eligible positive-minimum USD product.');
        const product = products[0]; e.productName = product.name; e.currency = product.currency;
        e.amount = uniqueSubscriptionAmount(product.minimumInvestment, runId);
        expect(new Decimal(e.amount).eq(authorizedAmount), 'Subscription amount matches this Run authorization').toBe(true);
        await funds.openSubscription(product.name);
        e.productId = new URL(clientPage.url()).searchParams.get('id') ?? undefined;
        await subscribe.expectLoaded();
        const available = (await subscribe.readPaymentAccounts()).filter(row => row.currency === e.currency && new Decimal(row.balance).gt(e.amount!));
        const account = available.find(row => row.accountType === '香港账户') ?? available[0];
        if (!account) throw new Error('BLOCKED_TEST_DATA: Existing balances cannot safely fund subscription.');
        e.purchaseAccount = account.accountType;
        await accounts.goto(env.client.baseUrl!); e.before = await accounts.readSnapshot(e.purchaseAccount, e.currency);
        store.save(); report(); setActual(`${e.productName}；${e.purchaseAccount}；金额${e.amount} ${e.currency}；可用余额${e.before.available}。`);
      });
      await business.step({ action: '核对认购摘要并完成一次安全验证', expected: '金额/付款账户/手续费来自页面，业务确认和密钥验证各一次' }, async ({ setActual }) => {
        await funds.goto(env.client.baseUrl!); await funds.openCatalog(); await funds.openSubscription(e.productName!);
        await subscribe.selectPaymentAccount(e.purchaseAccount!); await subscribe.fillAmount(e.amount!); await subscribe.acceptTerms();
        const quote = await subscribe.readSnapshot();
        expect(quote.amount).toBe(new Decimal(e.amount!).toFixed());
        expect(quote.currency).toBe(e.currency); expect(quote.paymentAccount).toBe(e.purchaseAccount);
        expect(new Decimal(quote.totalAmount).eq(new Decimal(quote.amount).plus(quote.feeAmount))).toBe(true);
        expect(new Decimal(e.before!.available).gt(quote.totalAmount)).toBe(true);
        e.fee = quote.feeAmount; e.expectedDebit = quote.totalAmount;
        guard.assertClientMoneyConfirmationAllowed(switches); guard.recordClientMoneyConfirmation();
        e.confirmationClicks = 1; store.advance('CLIENT_SUBMIT_ATTEMPTED'); business.disallowSafeRerun();
        const security = await subscribe.confirmOnce();
        await security.fill(env.client.securityKey!);
        guard.assertSecurityKeyVerificationAllowed(switches); guard.recordSecurityKeyVerification();
        e.securityVerificationClicks = 1; e.createdAt = new Date().toISOString();
        store.advance('SECURITY_KEY_VERIFICATION_ATTEMPTED'); business.markPotentiallySubmitted(); report();
        try { await security.verifyOnce(); }
        catch { business.recordDiagnostic({ id: 'WS-SECURITY-OBSERVATION', name: '验证后的UI观察', status: 'unavailable',
          summary: '验证已点击一次，接下来只读取历史确认订单，不再提交。', affectsCoreBusiness: false }); }
        setActual('业务确认1次，安全验证1次；已保存请求元信息，下一步以真实订单确认创建。');
      });
    } else {
      if (e.confirmationClicks) guard.recordClientMoneyConfirmation();
      if (e.securityVerificationClicks) guard.recordSecurityKeyVerification();
    }
    if (!e.clientOrder) {
      await business.step({ action: '确认真实生成唯一INV认购申请', expected: '当前用户完整历史中新增唯一产品/金额/币种/账户/时间匹配记录' }, async ({ setActual }) => {
        let matches: WealthHistoryRecord[] = [];
        await expect.poll(async () => {
          await funds.goto(env.client.baseUrl!);
          matches = matchingNewWealthOrders(await funds.readHistory('申购', 0, true), e);
          if (matches.length > 1) throw new Error('Multiple new matching subscriptions; never submit or approve again.');
          return matches.length;
        }, { timeout: 100_000, intervals: [1_000, 3_000], message: 'INVESTMENT_SUBSCRIPTION_UNCONFIRMED' }).toBe(1);
        e.clientOrder = matches[0]; e.clientStatus = matches[0].status;
        store.advance('CLIENT_CREATED', { clientReference: e.clientOrder.orderId, clientSubmittedAt: e.createdAt });
        primary('WS-CREATED', '唯一认购订单真实存在', e.clientOrder.orderId); report(); setActual(`真实INV已读取，状态${e.clientStatus}，未重复提交。`);
      });
    }
    guard.recordClientSubmission();
    if (!e.submitted) {
      await accounts.goto(env.client.baseUrl!); e.submitted = await accounts.readSnapshot(e.purchaseAccount!, e.currency!); store.save(); report();
    }
    await business.step({ action: 'Admin唯一定位并二次核对原认购', expected: 'INV、用户、产品、金额、币种、付款账户、费用及时间匹配' }, async ({ setActual }) => {
      await admin.goto(env.admin.baseUrl!, 'subscription');
      let candidates: WealthAdminCandidate[] = [];
      await expect.poll(async () => {
        candidates = await admin.findExactOrder(e.clientOrder!.orderId, 'subscription'); e.candidateCount = candidates.length; report();
        if (candidates.length > 1) throw new Error('Admin candidateCount > 1; approval forbidden.');
        return candidates.length;
      }, { timeout: 75_000, intervals: [1_000, 2_000] }).toBe(1);
      const detail = await admin.openDetails(candidates[0]);
      const matched = diagnoseWealthOrderCandidates([detail.record], { orderId: e.clientOrder!.orderId, kind: 'subscription',
        customerIdentity: env.client.username!, productName: e.productName!, currency: e.currency!, amount: e.amount!,
        status: candidates[0].status, submittedAtMs: Date.parse(e.createdAt!), matchWindowMs: 300_000 });
      business.setBusinessData({ candidateStages: matched.stages });
      expect(matched.candidates.length, 'Admin detail fingerprint').toBe(1);
      expect(detail.account).toBe(e.purchaseAccount); expect(new Decimal(detail.fee).eq(e.fee!)).toBe(true);
      e.adminStatus = candidates[0].status; guard.recordUniqueAdminCandidate(1);
      if (stageIndex(store.state.stage) < stageIndex('ADMIN_LOCATED')) store.advance('ADMIN_LOCATED', { adminReference: e.clientOrder!.orderId });
      primary('WS-ADMIN-MATCH', 'Admin候选唯一且详情全部匹配', 'candidateCount=1；真实INV、用户、金额、付款账户与Client一致');
      if (e.adminStatus === '待审核' && !e.adminApprovalClicks) {
        expect(detail.approveActionVisible, 'Actual approval action').toBe(true);
        guard.assertAdminActionAllowed(switches);
        e.adminApprovalClicks = 1; store.advance('FIDERE_APPROVAL_ATTEMPTED'); guard.recordAdminAction(); report();
        await admin.approveOnce(e.clientOrder!.orderId); business.markMutationPerformed('Admin批准本次唯一理财认购一次');
      }
      setActual(`候选1条、详情匹配；批准累计${e.adminApprovalClicks}次。`);
    });
    await business.step({ action: '等待Admin批准终态', expected: '原INV进入已通过Tab，不以按钮点击或列表消失判成功' }, async ({ setActual }) => {
      await expect.poll(async () => {
        await admin.goto(env.admin.baseUrl!, 'subscription');
        const matches = await admin.findExactOrder(e.clientOrder!.orderId, 'subscription');
        if (matches.length === 1) e.adminStatus = matches[0].status;
        report(); return matches.length === 1 && matches[0].status === '已通过';
      }, { timeout: 90_000, intervals: [2_000, 5_000] }).toBe(true);
      if (stageIndex(store.state.stage) < stageIndex('ADMIN_ACTION_DONE')) store.advance('ADMIN_ACTION_DONE');
      primary('WS-ADMIN', 'Admin原订单审核通过', e.adminStatus!); setActual('原INV在已通过Tab唯一存在。');
    });
    await business.step({ action: '干净登录Client核对认购结果、原订单及持仓', expected: '原INV成功，产品金额付款账户一致，新增持仓可观察' }, async ({ setActual }) => {
      clean = await RegistrationKycStatusPage.cleanLogin({ browser, baseURL: env.client.baseUrl!, email: env.client.username!, password: env.client.password!, otp: env.client.otp! });
      const page = clean.statusPage.page, current = new FundTradingPage(page);
      await verifyWealthIdentity(page, env.client.baseUrl!, env.client.username!);
      await expect.poll(async () => {
        await current.goto(env.client.baseUrl!);
        const records = await current.readHistory('申购', 0, true);
        const same = records.filter(row => row.orderId === e.clientOrder!.orderId);
        if (same.length !== 1) return false;
        e.clientStatus = same[0].status;
        expect(same[0].productName).toBe(e.productName); expect(same[0].currency).toBe(e.currency);
        expect(new Decimal(same[0].amount).eq(e.amount!)).toBe(true); expect(same[0].purchaseAccount).toBe(e.purchaseAccount);
        return /^(持有中|已通过|已完成)$/.test(e.clientStatus);
      }, { timeout: 90_000, intervals: [2_000, 5_000] }).toBe(true);
      await current.openPositions();
      const position = (await current.readPositions()).filter(row => row.productId === e.productId && row.currency === e.currency);
      expect(position.length).toBe(1);
      const old = e.oldPositions?.find(row => row.productId === e.productId && row.currency === e.currency);
      expect(new Decimal(position[0].principal).minus(old?.principal ?? '0').eq(e.amount!)).toBe(true);
      primary('WS-CLIENT', 'Client原INV成功且持仓本金正确增加', `${e.clientStatus}；新增${e.amount} ${e.currency}`);
      if (stageIndex(store.state.stage) < stageIndex('CLIENT_FINALIZED')) store.advance('CLIENT_FINALIZED');
      report(); setActual(`干净登录后原INV=${e.clientStatus}；持仓本金按本次认购金额增加。`);
    });
    await business.step({ action: '核对付款账户可用、冻结及总余额实际变化', expected: '最终总扣减=页面应付总额；本次冻结释放，不影响历史冻结' }, async ({ setActual }) => {
      const afterAccounts = new AccountDetailPage(clean!.statusPage.page);
      await expect.poll(async () => {
        await afterAccounts.goto(env.client.baseUrl!); e.after = await afterAccounts.readSnapshot(e.purchaseAccount!, e.currency!); store.save(); report();
        return new Decimal(e.before!.total).minus(e.after.total).eq(e.expectedDebit!) &&
          new Decimal(e.before!.available).minus(e.after.available).eq(e.expectedDebit!) && new Decimal(e.after.frozen).eq(e.before!.frozen);
      }, { timeout: 60_000, intervals: [2_000, 5_000] }).toBe(true);
      primary('WS-BALANCE', '认购付款账户余额与页面金额及费用一致', `${e.before!.available} - ${e.after!.available} = ${e.expectedDebit} ${e.currency}`);
      e.completed = true; store.advance('COMPLETED'); report();
      setActual(`总余额${e.before!.total}→${e.after!.total}；可用${e.before!.available}→${e.after!.available}；冻结${e.before!.frozen}→${e.submitted!.frozen}→${e.after!.frozen}。`);
    });
  } catch (error) {
    e.failure = maskSensitiveText(error instanceof Error ? error.message : String(error)); store.save(); report();
    if ((e.securityVerificationClicks && !e.clientOrder) || (e.adminApprovalClicks && e.adminStatus !== '已通过')) {
      business.requireManualReview('只读查询当前理财INV和余额；禁止再次认购或批准。');
    }
    if (/BLOCKED_TEST_DATA/.test(e.failure)) testInfo.annotations.push({ type: 'blocker', description: e.failure });
    throw error;
  } finally {
    report();
    await testInfo.attach('wealth-safe-network', { body: JSON.stringify({ client: stopClient(), admin: stopAdmin() }), contentType: 'application/json' });
    if (clean) await clean.context.close();
    console.log('WEALTH_SUBSCRIPTION_RESULT ' + maskSensitiveText(JSON.stringify(e)));
  }
});
