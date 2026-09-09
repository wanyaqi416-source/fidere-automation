import { test, expect } from '../../../fixtures/client.fixture';
import { UserToUserTransferPage } from '../../../pages/client/UserToUserTransferPage';
import { env } from '../../../src/config/env';
import { decodeClientKycStatus } from '../../../src/registration/registration-kyc-contract';
import { LoginPage } from '../../../pages/client/LoginPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { formatU2uBalance } from '../../../src/user-transfer/u2u-summary';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.skip(!process.env.U2U_RECIPIENT_EMAIL, 'U2U_RECIPIENT_EMAIL must be explicitly configured.');

test('U2U-001 用户间转账只读预检', { tag: ['@client', '@readonly', '@u2u'] }, async ({ page, browser, baseURL, business }) => {
  test.setTimeout(180_000);
  business.flow('user-to-user-transfer-preflight');
  const transfer = new UserToUserTransferPage(page);
  await business.step({ action: '确认指定Sender认证及KYC', expected: '使用ENV指定用户，KYC通过；禁止自动换Sender' }, async ({ setActual }) => {
    const session = await page.request.get(new URL('/server/auth/session', baseURL).toString());
    expect(session.ok()).toBe(true);
    const data = await session.json();
    expect(data.user?.email?.toLowerCase() === env.client.username?.toLowerCase(), 'Authenticated Sender matches config').toBe(true);
    expect(['1', '2']).toContain(String(data.entityType));
    const accountType = String(data.entityType) === '2' ? 'BUSINESS' : 'PERSONAL';
    const kyc = decodeClientKycStatus(data, { accountType, email: env.client.username! });
    expect(kyc.approved).toBe(true);
    setActual(`指定Sender身份匹配；类型=${accountType}；对应KYC/KYB通过。`);
  });
  if (process.env.U2U_RECIPIENT_USE_CLIENT_CREDENTIALS === 'true') {
    await business.step({ action: '收款方干净登录并读取账户余额', expected: '独立认证收款用户，确认对应KYC及目标账户余额；不执行转账' }, async ({ setActual, setBusinessData }) => {
      const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      try {
        const recipientPage = await context.newPage();
        const login = new LoginPage(recipientPage);
        await login.goto(baseURL!);
        await login.login({ username: process.env.U2U_RECIPIENT_EMAIL!, password: env.client.password!, otp: env.client.otp! });
        await login.expectLoggedIn();
        const response = await context.request.get(new URL('/server/auth/session', baseURL).toString());
        expect(response.ok()).toBe(true);
        const data = await response.json();
        const recipientEmail = process.env.U2U_RECIPIENT_EMAIL!;
        expect(data.user?.email?.toLowerCase() === recipientEmail.toLowerCase(), 'Recipient session identity matches').toBe(true);
        expect(['1', '2']).toContain(String(data.entityType));
        const accountType = String(data.entityType) === '2' ? 'BUSINESS' : 'PERSONAL';
        const kyc = decodeClientKycStatus(data, { accountType, email: recipientEmail });
        expect(kyc.approved, 'Recipient KYC/KYB approved').toBe(true);
        const accounts = new AccountDetailPage(recipientPage);
        await accounts.goto(baseURL!);
        const balance = await accounts.readAvailableBalance(process.env.U2U_SOURCE_ACCOUNT_TYPE!, process.env.U2U_CURRENCY!);
        setBusinessData({ targetAccountType: balance.accountType, targetBalanceBefore: formatU2uBalance(balance.availableBalance.toFixed()) });
        setActual(`收款方认证匹配；${accountType}审核通过；${balance.accountType}/${balance.currency}可用余额=${formatU2uBalance(balance.availableBalance.toFixed())}。未提交资金操作。`);
      } finally {
        await context.close();
      }
    });
  }
  await business.step({ action: '读取用户间转账表单', expected: '独立U2U入口，记录费用及收款资格校验时机，不提交' }, async ({ setActual }) => {
    await transfer.goto(baseURL!);
    const inspection = await transfer.inspectForm();
    expect(inspection.route).toBe('/zh-CN/account/p2p-transfer');
    expect(inspection.submitEnabled).toBe(false);
    setActual(`表单已加载；手续费从金额内扣=${inspection.feeDeductedFromAmount}；收款资格仅在提交时校验=${inspection.eligibilityCheckedAtSubmission}。不把按钮可用或无报错当成收款资格证明。`);
  });
  await business.step({ action: '填写收款邮箱并读取资产选项', expected: '仅填写指定邮箱及读取选项，不确认转账、不进行密钥验证' }, async ({ setActual, setBusinessData }) => {
    await transfer.fillRecipient(env.client.username!, process.env.U2U_RECIPIENT_EMAIL!);
    const assets = await transfer.readAssetOptions();
    expect(assets.length).toBeGreaterThan(0);
    setBusinessData({ supportedCurrencies: assets });
    setActual(`收款邮箱已填写；可见资产选项=${assets.length}；本次资金确认0次，密钥验证0次。收款资格仍待独立证据确认。`);
  });
  if (process.env.U2U_CURRENCY && process.env.U2U_TEST_AMOUNT) {
    await business.step({ action: '读取小额转账摘要', expected: '按页面读取余额、手续费和预计到账，不点击确认' }, async ({ setActual, setBusinessData }) => {
      const summary = await transfer.previewUniqueAsset(process.env.U2U_CURRENCY!, process.env.U2U_TEST_AMOUNT!, process.env.U2U_SOURCE_ACCOUNT_TYPE);
      setBusinessData(summary);
      setActual(`转账摘要已读取；确认按钮可用=${summary.submitEnabled}；金额高于手续费且预计到账一致=${summary.quote.transferable}。仅预览，资金提交0次。`);
    });
  }
});
