import { test, expect } from '../../../fixtures/workflow.fixture';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { WealthOrderListPage } from '../../../pages/admin/WealthOrderListPage';
import { FundTradingPage } from '../../../pages/client/FundTradingPage';
import { FundSubscribePage } from '../../../pages/client/FundSubscribePage';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment } from '../../../src/flow-engine';
import { Decimal } from '../../../src/utils/money';
import { maskSensitiveText } from '../../../src/reporting/sensitive-data-mask';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';

test.describe.configure({ mode: 'serial', retries: 0 });
test('WEALTH-PREFLIGHT 指定用户认购与原有持仓只读预检', {
  tag: ['@wealth', '@readonly', '@L2']
}, async ({ clientPage, adminPage, business }) => {
  test.setTimeout(180_000);
  assertSandboxEnvironment(env.client.baseUrl);
  assertSandboxEnvironment(env.admin.baseUrl);
  expect(env.exchange.allowMoneyTests).toBe(false);
  expect(env.allowAdminMutationTests).toBe(false);
  if (!process.env.WEALTH_TEST_USERNAME || env.client.username !== process.env.WEALTH_TEST_USERNAME) {
    throw new Error('Wealth preflight requires the explicitly selected Client identity.');
  }
  business.flow('wealth-subscribe-dry-run', {
    caseId: 'WEALTH-PREFLIGHT', name: '指定用户认购只读预检',
    expectedResult: '双端认证有效，读取实际可购买产品、账户余额和原有持仓；不提交，不访问Admin赎回Tab。'
  });
  const admin = new WealthOrderListPage(adminPage);
  adminPage.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === new URL(env.admin.baseUrl!).origin && url.pathname.startsWith('/admin-api/operation/invest/subscription/')) {
      console.log(`WEALTH_ADMIN_PATH ${response.request().method()} ${url.pathname} HTTP ${response.status()}`);
    }
  });
  await business.step({ action: '验证Admin认证及认购入口', expected: '业务页面可以访问，审批点击0次' }, async ({ setActual }) => {
    const shell = new AdminShellPage(adminPage);
    await shell.goto(env.admin.baseUrl!);
    await shell.expectSessionActive();
    for (const kind of ['subscription'] as const) {
      await admin.goto(env.admin.baseUrl!, kind);
      console.log(`WEALTH_ADMIN_HEADERS ${kind}: ${JSON.stringify(await admin.tableHeaders())}`);
    }
    setActual('Admin认证有效；认购管理可打开；赎回Journey按用户要求暂停。');
  });
  const funds = new FundTradingPage(clientPage);
  const networkPaths = new Set<string>();
  clientPage.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === new URL(env.client.baseUrl!).origin && url.pathname.startsWith('/api/')) {
      networkPaths.add(`${response.request().method()} ${url.pathname} HTTP ${response.status()}`);
    }
  });
  await business.step({ action: '读取原有持仓及交易历史', expected: '原有持仓与未来新认购使用独立上下文' }, async ({ setActual, setBusinessData }) => {
    await funds.goto(env.client.baseUrl!);
    const positions = await funds.openPositions();
    console.log('WEALTH_POSITIONS ' + await funds.readSafeVisibleState());
    console.log('WEALTH_POSITION_RESPONSE_SHAPE ' + await funds.readPositionResponseShape());
    console.log('WEALTH_SETTLED_POSITIONS ' + await funds.readSafeVisibleState());
    const oldPositions = await funds.readPositions();
    const usdPosition = oldPositions.filter(row => row.currency === 'USD' && new Decimal(row.principal).gt(0));
    if (usdPosition.length === 1) {
      await funds.openPositionDetails(usdPosition[0].productId);
      console.log('WEALTH_ORIGINAL_POSITION_DETAIL ' + await funds.readSafeVisibleState());
      console.log('WEALTH_ORIGINAL_POSITION_ARIA ' + maskSensitiveText(await clientPage.locator('main').ariaSnapshot()));
      await funds.openHeldProduct(usdPosition[0].productId);
      console.log('WEALTH_REDEEM_ELIGIBILITY_UI ' + maskSensitiveText(await clientPage.locator('body').ariaSnapshot()));
      await funds.goto(env.client.baseUrl!);
    }
    const history = await funds.readHistory('申购');
    console.log('WEALTH_SUBSCRIPTION_HISTORY ' + await funds.readSafeVisibleState());
    const original = history.find(row => row.currency === 'USD' && row.status === '持有中');
    if (original) {
      await admin.goto(env.admin.baseUrl!, 'subscription');
      const candidates = await admin.findExactOrder(original.orderId, 'subscription');
      console.log('WEALTH_HISTORICAL_ADMIN_CANDIDATES ' + candidates.length);
      if (candidates.length === 1) {
        const detail = await admin.openDetails(candidates[0]);
        console.log('WEALTH_HISTORICAL_ADMIN_DETAIL ' + maskSensitiveText(detail.text));
      }
    }
    setBusinessData({ positionRecordCount: positions.renderedPositionRows,
      redeemablePositionCount: positions.redeemActionCount, wealthHistoryCount: history.length });
    setActual(`读取原有持仓与认购历史；不执行赎回。`);
  });
  await business.step({ action: '选择低门槛产品并读取合法付款余额', expected: '只形成认购摘要，确认和安全验证均0次' }, async ({ setActual, setBusinessData }) => {
    await funds.openCatalog();
    const products = await funds.readProducts();
    console.log('WEALTH_PRODUCTS ' + JSON.stringify(products));
    const product = products.filter(p => p.currency === 'USD' && new Decimal(p.minimumInvestment).gt(0))
      .sort((a, b) => new Decimal(a.minimumInvestment).comparedTo(b.minimumInvestment) || a.name.localeCompare(b.name))[0];
    if (!product) throw new Error('BLOCKED_TEST_DATA: No purchasable USD product.');
    await funds.openSubscription(product.name);
    const subscribe = new FundSubscribePage(clientPage);
    await subscribe.expectLoaded();
    const accounts = await subscribe.readPaymentAccounts();
    console.log('WEALTH_PAYMENT_ACCOUNTS ' + JSON.stringify(accounts));
    console.log('WEALTH_SUBSCRIBE_FORM ' + await funds.readSafeVisibleState());
    const eligible = accounts.filter(a => a.currency === product.currency && new Decimal(a.balance).gt(product.minimumInvestment));
    if (!eligible.length) throw new Error('BLOCKED_TEST_DATA: Existing balances cannot fund the minimum subscription with a remainder.');
    const account = eligible.find(a => a.accountType === '香港账户') ?? eligible[0];
    await subscribe.selectPaymentAccount(account.accountType);
    await subscribe.fillAmount(product.minimumInvestment);
    await subscribe.acceptTerms();
    const snapshot = await subscribe.readSnapshot();
    console.log('WEALTH_SUBSCRIBE_SUMMARY ' + JSON.stringify(snapshot));
    console.log('WEALTH_READONLY_PATHS ' + JSON.stringify([...networkPaths]));
    expect(await subscribe.submitEnabled()).toBe(true);
    setBusinessData({ selectedProduct: product.name, paymentAccount: account.accountType,
      paymentBalance: account.balance, minimumInvestment: product.minimumInvestment, feeAmount: snapshot.feeAmount });
    setActual(`产品${product.name}；${account.accountType}/${product.currency}余额${account.balance}；最低${product.minimumInvestment}。`);
    const balancePage = new AccountDetailPage(clientPage);
    await balancePage.goto(env.client.baseUrl!);
    await balancePage.readAvailableBalance(account.accountType, product.currency);
    console.log('WEALTH_BALANCE_PAGE ' + await funds.readSafeVisibleState());
  });
});
