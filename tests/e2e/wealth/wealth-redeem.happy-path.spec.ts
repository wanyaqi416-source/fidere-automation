import { test, expect } from '../../../fixtures/workflow.fixture';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { WealthOrderListPage, type WealthAdminCandidate } from '../../../pages/admin/WealthOrderListPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { FundRedeemPage } from '../../../pages/client/FundRedeemPage';
import { FundTradingPage, type WealthHistoryRecord } from '../../../pages/client/FundTradingPage';
import { RegistrationKycStatusPage } from '../../../pages/client/RegistrationKycStatusPage';
import { env } from '../../../src/config/env';
import { MoneyMutationGuard, assertSandboxEnvironment, stageIndex } from '../../../src/flow-engine';
import { maskSensitiveText } from '../../../src/reporting/sensitive-data-mask';
import { Decimal } from '../../../src/utils/money';
import { diagnoseWealthOrderCandidates } from '../../../src/wealth/wealth-e2e';
import { WealthJourneyStore, matchingNewWealthOrders, observeWealthNetwork, verifyWealthIdentity } from '../../../src/wealth/wealth-journey';
import { chooseUniqueRedeemablePosition, redeemedPrincipalDelta, verifyRedemptionSettlement } from '../../../src/wealth/wealth-redemption';

test.describe.configure({ mode: 'serial', retries: 0 });
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('WR-003 独立理财赎回审核通过Golden Journey', {
  tag: ['@wealth', '@redeem', '@money', '@mutation', '@L4']
}, async ({ clientPage, adminPage, browser, business }, testInfo) => {
  test.setTimeout(600_000);
  business.flow('wealth-redeem');
  const runId = process.env.WEALTH_REDEEM_RUN_ID;
  const selectedUser = process.env.WEALTH_REDEEM_USERNAME;
  if (!runId || !selectedUser || env.client.username?.toLowerCase() !== selectedUser.toLowerCase()) {
    throw new Error('A named Redemption Run and the explicitly selected Client identity are required.');
  }
  if (!env.client.password || !env.client.otp || !env.client.securityKey) {
    throw new Error('Configured Client password, OTP and Security Key are required.');
  }
  assertSandboxEnvironment(env.client.baseUrl);
  assertSandboxEnvironment(env.admin.baseUrl);
  const switches = {
    ALLOW_MONEY_TESTS: env.exchange.allowMoneyTests,
    ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests
  };
  const guard = new MoneyMutationGuard('wealth-redemption', true, true);
  guard.validateRuntime({ baseURL: env.client.baseUrl, workers: testInfo.config.workers,
    retries: testInfo.project.retries, repeatEach: testInfo.project.repeatEach, safetySwitches: switches });

  const store = new WealthJourneyStore('redemption', runId, selectedUser, process.env.WEALTH_REDEEM_RESUME === 'true');
  const e = store.evidence;
  if (e.completed) throw new Error('This redemption Journey is already completed; do not rerun it.');
  const funds = new FundTradingPage(clientPage);
  const redeem = new FundRedeemPage(clientPage);
  const admin = new WealthOrderListPage(adminPage);
  const accounts = new AccountDetailPage(clientPage);
  let clean: Awaited<ReturnType<typeof RegistrationKycStatusPage.cleanLogin>> | undefined;
  const stopClient = observeWealthNetwork(clientPage, entries => business.setBusinessData({ safePostSubmitNetworkMetadata: entries.join('\n') }));
  const stopAdmin = observeWealthNetwork(adminPage, entries => business.setBusinessData({ safeRequestEvidence: entries.join('\n') }));
  const report = () => {
    business.setResumeState(store.state.stage);
    business.setBusinessData({ selectedProduct: e.productName, wealthProductId: e.productId,
      holdingOrderId: e.holdingOrderId, settlementAccount: e.settlementAccount,
      sourceAmount: e.amount, fromCurrency: e.currency, feeAmount: e.fee,
      redemptionOrderId: e.clientOrder?.orderId, candidateCount: e.candidateCount,
      wealthClientStatus: e.clientStatus, wealthAdminStatus: e.adminStatus,
      beforeAvailableBalance: e.before?.available, beforeTotalBalance: e.before?.total,
      afterApprovedAvailableBalance: e.after?.available, afterApprovedTotalBalance: e.after?.total,
      wealthBalanceSnapshots: JSON.stringify({ settlementBefore: e.before, settlementAfter: e.after }),
      finalSubmissionClicks: e.confirmationClicks, securityVerificationClicks: e.securityVerificationClicks,
      approvalClicks: e.adminApprovalClicks, safeToRerun: false });
  };
  const primary = (id: string, name: string, actual: string) => business.recordPrimaryOracle({ id, name,
    expected: name, actual, status: 'passed' });

  try {
    await business.step({ action: '登录客户端并检查Admin赎回入口',
      expected: '指定用户KYC已通过，Admin认证有效，单次Mutation开关有效' }, async ({ setActual }) => {
      const shell = new AdminShellPage(adminPage);
      await shell.goto(env.admin.baseUrl!);
      await shell.expectSessionActive();
      await admin.goto(env.admin.baseUrl!, 'redemption');
      await funds.goto(env.client.baseUrl!);
      const identity = await verifyWealthIdentity(clientPage, env.client.baseUrl!, selectedUser);
      e.userId = identity.userId;
      guard.markAuthenticationReady(true, true);
      store.save();
      setActual('测试用户KYC已通过；Admin赎回管理可访问；workers=1、retries=0、repeatEach=1。');
    });

    if (store.state.stage === 'PREPARED') {
      await business.step({ action: '查询并唯一确定可赎回持仓',
        expected: '只使用页面真实启用赎回按钮的唯一持仓；零笔或多笔均不提交' }, async ({ setActual }) => {
        await funds.goto(env.client.baseUrl!);
        const positionState = await funds.openPositions();
        const candidates = await funds.readRedeemablePositions();
        business.setBusinessData({ positionRecordCount: positionState.renderedPositionRows,
          redeemablePositionCount: candidates.length });
        let selected;
        try {
          selected = chooseUniqueRedeemablePosition(candidates);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          testInfo.annotations.push({ type: 'blocker', description: reason });
          throw error;
        }
        e.oldPositions = await funds.readPositions();
        e.oldOrderIds = (await funds.readHistory('赎回', 0, true)).map(row => row.orderId);
        e.productId = selected.productId;
        e.holdingOrderId = selected.holdingId;
        e.productName = selected.productName;
        e.currency = selected.currency;
        e.amount = selected.principal;
        store.save();
        setActual(`唯一可赎回持仓：${selected.productName}，${selected.principal} ${selected.currency}。`);
      });

      await business.step({ action: '核对赎回金额、结算账户和预计到账',
        expected: '使用页面合法默认结算账户；金额、手续费和预计结算金额均来自页面' }, async ({ setActual }) => {
        await funds.goto(env.client.baseUrl!);
        await funds.openPositions();
        const selected = chooseUniqueRedeemablePosition(await funds.readRedeemablePositions());
        await funds.openRedemption(selected);
        await redeem.expectLoaded();
        await redeem.prepareDefaultRedemption(selected.principal);
        const snapshot = await redeem.readSnapshot();
        expect(snapshot.productName).toBe(e.productName);
        expect(snapshot.currency).toBe(e.currency);
        expect(new Decimal(snapshot.redemptionAmount).isPositive()).toBe(true);
        expect(new Decimal(snapshot.expectedSettlementAmount).isPositive()).toBe(true);
        e.amount = snapshot.redemptionAmount;
        e.settlementAccount = snapshot.settlementAccount;
        e.fee = snapshot.feeAmount;
        e.expectedCredit = snapshot.expectedSettlementAmount;
        await accounts.goto(env.client.baseUrl!);
        e.before = await accounts.readSnapshot(e.settlementAccount!, e.currency!);
        store.save();
        report();
        setActual(`赎回${e.amount} ${e.currency}；结算账户${e.settlementAccount}；页面预计到账${e.expectedCredit}。`);
      });

      await business.step({ action: '提交一次赎回并完成安全验证',
        expected: '业务确认和Security Key验证各一次，之后只查询原申请' }, async ({ setActual }) => {
        await funds.goto(env.client.baseUrl!);
        await funds.openPositions();
        const selected = chooseUniqueRedeemablePosition(await funds.readRedeemablePositions());
        await funds.openRedemption(selected);
        await redeem.expectLoaded();
        await redeem.prepareDefaultRedemption(selected.principal);
        const snapshot = await redeem.readSnapshot();
        expect(snapshot.productName).toBe(e.productName);
        expect(snapshot.settlementAccount).toBe(e.settlementAccount);
        expect(new Decimal(snapshot.redemptionAmount).eq(e.amount!)).toBe(true);
        expect(new Decimal(snapshot.expectedSettlementAmount).eq(e.expectedCredit!)).toBe(true);
        guard.assertClientMoneyConfirmationAllowed(switches);
        guard.recordClientMoneyConfirmation();
        e.confirmationClicks = 1;
        store.advance('CLIENT_SUBMIT_ATTEMPTED');
        business.disallowSafeRerun();
        const security = await redeem.confirmOnce();
        await security.fill(env.client.securityKey!);
        guard.assertSecurityKeyVerificationAllowed(switches);
        guard.recordSecurityKeyVerification();
        e.securityVerificationClicks = 1;
        e.createdAt = new Date().toISOString();
        store.advance('SECURITY_KEY_VERIFICATION_ATTEMPTED');
        business.markPotentiallySubmitted();
        report();
        try {
          await security.verifyOnce();
        } catch {
          business.recordDiagnostic({ id: 'WR-SECURITY-OBSERVATION', name: '安全验证后的UI观察',
            status: 'unavailable', summary: '验证已点击一次；后续仅查询赎回历史，不会再次提交。', affectsCoreBusiness: false });
        }
        setActual('赎回确认1次，安全验证1次；后续仅以真实INV确认创建。');
      });
    } else {
      if (e.confirmationClicks) guard.recordClientMoneyConfirmation();
      if (e.securityVerificationClicks) guard.recordSecurityKeyVerification();
    }

    if (!e.clientOrder) {
      await business.step({ action: '确认真实生成唯一赎回申请',
        expected: 'Client赎回历史新增唯一产品、金额、币种、结算账户和时间均匹配的INV' }, async ({ setActual }) => {
        let matches: WealthHistoryRecord[] = [];
        await expect.poll(async () => {
          await funds.goto(env.client.baseUrl!);
          matches = matchingNewWealthOrders(await funds.readHistory('赎回', 0, true), e);
          if (matches.length > 1) throw new Error('Multiple new matching redemptions; never submit or approve again.');
          return matches.length;
        }, { timeout: 100_000, intervals: [1_000, 3_000], message: 'INVESTMENT_REDEMPTION_UNCONFIRMED' }).toBe(1);
        e.clientOrder = matches[0];
        e.clientStatus = matches[0].status;
        store.advance('CLIENT_CREATED', { clientReference: e.clientOrder.orderId, clientSubmittedAt: e.createdAt });
        primary('WR-CREATED', '唯一赎回申请真实存在', e.clientOrder.orderId);
        report();
        setActual(`真实赎回INV已读取，状态${e.clientStatus}，未重复提交。`);
      });
    }
    guard.recordClientSubmission();

    await business.step({ action: 'Admin唯一定位并核对本次赎回',
      expected: 'INV唯一，产品、赎回金额、币种、结算账户、费用和时间与Client一致' }, async ({ setActual }) => {
      await admin.goto(env.admin.baseUrl!, 'redemption');
      let candidates: WealthAdminCandidate[] = [];
      await expect.poll(async () => {
        candidates = await admin.findExactOrder(e.clientOrder!.orderId, 'redemption');
        e.candidateCount = candidates.length;
        report();
        if (candidates.length > 1) throw new Error('Admin redemption candidateCount > 1; approval forbidden.');
        return candidates.length;
      }, { timeout: 75_000, intervals: [1_000, 2_000] }).toBe(1);
      const detail = await admin.openDetails(candidates[0]);
      const matched = diagnoseWealthOrderCandidates([detail.record], {
        orderId: e.clientOrder!.orderId, kind: 'redemption', customerIdentity: selectedUser,
        customerMatchMode: 'display-only', productName: e.productName!, currency: e.currency!, amount: e.amount!,
        status: candidates[0].status, submittedAtMs: Date.parse(e.createdAt!), matchWindowMs: 300_000
      });
      business.setBusinessData({ candidateStages: matched.stages });
      expect(matched.candidates, 'Admin redemption detail fingerprint').toHaveLength(1);
      expect(detail.account).toBe(e.settlementAccount);
      expect(new Decimal(detail.fee).eq(e.fee!)).toBe(true);
      e.adminStatus = candidates[0].status;
      guard.recordUniqueAdminCandidate(1);
      if (stageIndex(store.state.stage) < stageIndex('ADMIN_LOCATED')) {
        store.advance('ADMIN_LOCATED', { adminReference: e.clientOrder!.orderId });
      }
      primary('WR-ADMIN-MATCH', 'Admin唯一匹配本次赎回申请', `candidateCount=1；${e.clientOrder!.orderId}`);
      if (e.adminStatus === '待审核' && !e.adminApprovalClicks) {
        expect(detail.approveActionVisible).toBe(true);
        guard.assertAdminActionAllowed(switches);
        e.adminApprovalClicks = 1;
        store.advance('FIDERE_APPROVAL_ATTEMPTED');
        guard.recordAdminAction();
        report();
        await admin.approveOnce(e.clientOrder!.orderId);
        business.markMutationPerformed('Admin批准本次唯一理财赎回一次');
      }
      setActual(`Admin候选1条，详情一致；累计批准${e.adminApprovalClicks}次。`);
    });

    await business.step({ action: '等待Admin赎回审核终态',
      expected: '原INV唯一进入已通过状态，不以按钮点击或列表消失代替终态' }, async ({ setActual }) => {
      await expect.poll(async () => {
        await admin.goto(env.admin.baseUrl!, 'redemption');
        const matches = await admin.findExactOrder(e.clientOrder!.orderId, 'redemption');
        if (matches.length === 1) e.adminStatus = matches[0].status;
        report();
        return matches.length === 1 && matches[0].status === '已通过';
      }, { timeout: 90_000, intervals: [2_000, 5_000] }).toBe(true);
      if (stageIndex(store.state.stage) < stageIndex('ADMIN_ACTION_DONE')) store.advance('ADMIN_ACTION_DONE');
      primary('WR-ADMIN', 'Admin原赎回申请审核通过', e.adminStatus!);
      setActual('原赎回INV在已通过Tab唯一存在。');
    });

    await business.step({ action: '重新登录Client验证原赎回记录和持仓',
      expected: '同一INV进入完成终态且持仓本金按本次赎回金额减少' }, async ({ setActual }) => {
      clean = await RegistrationKycStatusPage.cleanLogin({ browser, baseURL: env.client.baseUrl!, email: selectedUser,
        password: env.client.password!, otp: env.client.otp! });
      const page = clean.statusPage.page;
      const current = new FundTradingPage(page);
      await verifyWealthIdentity(page, env.client.baseUrl!, selectedUser);
      await expect.poll(async () => {
        await current.goto(env.client.baseUrl!);
        const records = await current.readHistory('赎回', 0, true);
        const same = records.filter(row => row.orderId === e.clientOrder!.orderId);
        if (same.length !== 1) return false;
        e.clientStatus = same[0].status;
        expect(same[0].productName).toBe(e.productName);
        expect(same[0].currency).toBe(e.currency);
        expect(new Decimal(same[0].amount).eq(e.amount!)).toBe(true);
        expect(same[0].purchaseAccount).toBe(e.settlementAccount);
        return /^(已通过|已完成|已赎回|成功)$/.test(e.clientStatus);
      }, { timeout: 90_000, intervals: [2_000, 5_000] }).toBe(true);
      await current.goto(env.client.baseUrl!);
      await current.openPositions();
      e.positionsAfter = await current.readPositions();
      expect(new Decimal(redeemedPrincipalDelta(e.oldPositions ?? [], e.positionsAfter, e.productId!, e.currency!))
        .eq(e.amount!)).toBe(true);
      if (stageIndex(store.state.stage) < stageIndex('CLIENT_FINALIZED')) store.advance('CLIENT_FINALIZED');
      primary('WR-CLIENT', 'Client原赎回订单完成且持仓正确减少', `${e.clientStatus}；减少${e.amount} ${e.currency}`);
      report();
      setActual(`原INV=${e.clientStatus}；持仓本金减少${e.amount} ${e.currency}。`);
    });

    await business.step({ action: '验证结算账户资金到账',
      expected: '实际可用余额增加值等于页面本次预计结算金额' }, async ({ setActual }) => {
      const afterAccounts = new AccountDetailPage(clean!.statusPage.page);
      let settlement = verifyRedemptionSettlement(e.before!, e.before!, e.expectedCredit!);
      await expect.poll(async () => {
        await afterAccounts.goto(env.client.baseUrl!);
        e.after = await afterAccounts.readSnapshot(e.settlementAccount!, e.currency!);
        settlement = verifyRedemptionSettlement(e.before!, e.after, e.expectedCredit!);
        store.save();
        report();
        return settlement.passed;
      }, { timeout: 90_000, intervals: [2_000, 5_000] }).toBe(true);
      primary('WR-SETTLEMENT', '赎回结算资金正确到账', `${e.before!.available}→${e.after!.available}；实际到账${settlement.actualCredit} ${e.currency}`);
      delete e.failure;
      e.completed = true;
      store.advance('COMPLETED');
      report();
      setActual(`结算前${e.before!.available}，页面预计${settlement.expectedSettlementAmount}，结算后${e.after!.available}，实际到账${settlement.actualCredit} ${e.currency}。`);
    });
  } catch (error) {
    e.failure = maskSensitiveText(error instanceof Error ? error.message : String(error));
    store.save();
    report();
    if ((e.securityVerificationClicks && !e.clientOrder) || (e.adminApprovalClicks && e.adminStatus !== '已通过')) {
      business.requireManualReview('只读查询当前赎回INV、持仓和结算账户；禁止再次赎回或批准。');
    }
    throw error;
  } finally {
    report();
    await testInfo.attach('wealth-redemption-safe-network', {
      body: JSON.stringify({ client: stopClient(), admin: stopAdmin() }), contentType: 'application/json'
    });
    if (clean) await clean.context.close();
    console.log('WEALTH_REDEMPTION_RESULT ' + maskSensitiveText(JSON.stringify(e)));
  }
});
