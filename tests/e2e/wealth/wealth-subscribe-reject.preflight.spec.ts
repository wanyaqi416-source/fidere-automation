import { test, expect } from '../../../fixtures/workflow.fixture';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { WealthOrderListPage } from '../../../pages/admin/WealthOrderListPage';
import { FundTradingPage } from '../../../pages/client/FundTradingPage';
import { FundSubscribePage } from '../../../pages/client/FundSubscribePage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment } from '../../../src/flow-engine';
import { uniqueSubscriptionAmount, verifyWealthIdentity } from '../../../src/wealth/wealth-journey';
import { Decimal } from '../../../src/utils/money';
import { maskSensitiveText } from '../../../src/reporting/sensitive-data-mask';

test.describe.configure({ mode: 'serial', retries: 0 });
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test('WS-002-PREFLIGHT 认购拒绝表单与资金持仓基线只读检查', { tag: ['@wealth', '@readonly', '@L2'] },
async ({ clientPage, adminPage, business }) => {
  test.setTimeout(240_000);
  business.flow('wealth-subscribe-dry-run', { caseId: 'WS-002-PREFLIGHT', name: '理财认购拒绝只读预检' });
  assertSandboxEnvironment(env.client.baseUrl); assertSandboxEnvironment(env.admin.baseUrl);
  expect(env.exchange.allowMoneyTests).toBe(false); expect(env.allowAdminMutationTests).toBe(false);
  const runId = process.env.WEALTH_RUN_ID;
  if (!runId || !process.env.WEALTH_TEST_USERNAME || env.client.username !== process.env.WEALTH_TEST_USERNAME) {
    throw new Error('Named Run and selected Wealth user required for preflight.');
  }
  const admin = new WealthOrderListPage(adminPage);
  await business.step({ action: '只读检查Admin认购拒绝表单', expected: '认证有效，历史样本仅打开详情，不点击拒绝或批准' }, async ({ setActual }) => {
    const shell = new AdminShellPage(adminPage); await shell.goto(env.admin.baseUrl!); await shell.expectSessionActive();
    await admin.goto(env.admin.baseUrl!, 'subscription');
    const ids = await admin.pendingOrderIdsForInspection();
    if (!ids.length) {
      business.recordDiagnostic({ id: 'WS002-NO-PENDING-SAMPLE', name: '拒绝表单现场样本', status: 'unavailable',
        summary: '当前无待审核样本；未点击拒绝入口或最终确认，真实表单交互仍待本次新订单。', affectsCoreBusiness: false });
      setActual('待审核列表没有可只读检查的样本；不创建测试订单。');
      return;
    }
    // This is a read-only form sample, never a mutation candidate or a future Run reference.
    const matches = await admin.findExactOrder(ids[0], 'subscription');
    expect(matches).toHaveLength(1);
    const detail = await admin.openDetails(matches[0]);
    expect(detail.rejectActionVisible).toBe(true);
    const form = await admin.rejectionFormState(detail.orderId);
    console.log('WS002_REJECT_FORM ' + maskSensitiveText(JSON.stringify(form)));
    setActual(`真实表单：${JSON.stringify(form)}；审核点击0次。`);
  });
  await business.step({ action: '读取KYC、真实余额、原持仓并填写认购摘要', expected: '金额合法且留有余额；业务确认和安全验证均0次' }, async ({ setActual, setBusinessData }) => {
    const funds = new FundTradingPage(clientPage), subscribe = new FundSubscribePage(clientPage);
    await funds.goto(env.client.baseUrl!);
    await verifyWealthIdentity(clientPage, env.client.baseUrl!, env.client.username!);
    await funds.openPositions(); const positions = await funds.readCompletePositions();
    const history = await funds.readHistory('申购', 0, true);
    await funds.openCatalog();
    const products = (await funds.readProducts()).filter(p => p.currency === 'USD' && new Decimal(p.minimumInvestment).gt(0))
      .sort((a, b) => new Decimal(a.minimumInvestment).comparedTo(b.minimumInvestment) || a.name.localeCompare(b.name));
    const product = products[0];
    if (!product) throw new Error('BLOCKED_TEST_DATA: No purchasable USD product.');
    const amount = uniqueSubscriptionAmount(product.minimumInvestment, runId);
    expect(history.filter(row => row.productName === product.name && row.currency === product.currency && new Decimal(row.amount).eq(amount))).toHaveLength(0);
    await funds.openSubscription(product.name); await subscribe.expectLoaded();
    const productId = new URL(clientPage.url()).searchParams.get('id');
    const account = (await subscribe.readPaymentAccounts()).find(a => a.accountType === '香港账户' && a.currency === 'USD' && new Decimal(a.balance).gt(amount));
    if (!account) throw new Error('BLOCKED_TEST_DATA: Hong Kong USD funds insufficient.');
    await subscribe.selectPaymentAccount(account.accountType); await subscribe.fillAmount(amount); await subscribe.acceptTerms();
    const quote = await subscribe.readSnapshot(); expect(quote.submitEnabled).toBe(true);
    expect(new Decimal(quote.amount).eq(amount)).toBe(true);
    expect(new Decimal(account.balance).gt(quote.totalAmount)).toBe(true);
    const balances = new AccountDetailPage(clientPage); await balances.goto(env.client.baseUrl!);
    const before = await balances.readSnapshot(account.accountType, product.currency);
    setBusinessData({ sourceRunId: runId, selectedProduct: product.name, wealthProductId: productId,
      purchaseAccount: account.accountType, sourceAmount: amount, feeAmount: quote.feeAmount,
      wealthBalanceSnapshots: JSON.stringify({ before }), positionRecordCount: positions.length,
      finalSubmissionClicks: 0, securityVerificationClicks: 0, adminMutationClicks: 0 });
    const plan = { runId, product: product.name, productId, amount, currency: product.currency, fee: quote.feeAmount,
      account: account.accountType, before, positions: positions.filter(p => p.productId === productId), historyCount: history.length };
    console.log('WS002_PREFLIGHT ' + JSON.stringify(plan));
    setActual(`产品${product.name}；${amount} USD，手续费${quote.feeAmount}；可用${before.available}、冻结${before.frozen}、总额${before.total}；未提交。`);
    expect(subscribe.submissionClickCount()).toBe(0); expect(admin.mutationClickCount()).toBe(0);
  });
});
