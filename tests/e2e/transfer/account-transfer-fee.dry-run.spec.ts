import { test, expect } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment } from '../../../src/flow-engine';
import { AccountTypeConfigurationPage } from '../../../pages/admin/AccountTypeConfigurationPage';
import { AccountInternalTransferPage } from '../../../pages/client/AccountInternalTransferPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { RegistrationKycStatusPage } from '../../../pages/client/RegistrationKycStatusPage';
import { fixedUsdFee, sameAccountTypeConfiguration, verifyTransferFeeQuote, snapshotUsdFeeRule, calculateExactTransferFee, TRANSFER_FEE_LABELS } from '../../../src/transfer/account-transfer-fee';
import { Decimal } from '../../../src/utils/money';

test.describe.configure({ retries: 0 });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('ATF-001 巴林USD当前互转手续费编辑与Client试算 @dry-run @L3', async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(180_000);
  business.flow('account-transfer-fee-dry-run');
  assertSandboxEnvironment(env.admin.baseUrl); assertSandboxEnvironment(env.client.baseUrl);
  expect(env.allowAdminMutationTests || env.allowClientMutationTests || env.exchange.allowMoneyTests).toBe(false);
  expect(testInfo.config.workers).toBe(1); expect(testInfo.project.retries).toBe(0); expect(testInfo.project.repeatEach).toBe(1);
  if (!env.client.username || !env.client.password || !env.client.otp) throw new Error('Default Client credentials are required.');
  const admin = new AccountTypeConfigurationPage(adminPage);
  const blocked: string[] = [];
  // Only the observed read-only queries use POST; all other writes are forbidden in this Dry Run.
  const readonlyPaths = new Set(['/api/transfer/fee-preview', '/api/transfer/records', '/api/assets-overview',
    '/admin-api/operation/account-domain/list', '/admin-api/operation/account-domain/detail',
    '/api/asset-change-trend', '/api/get-activitys-table', '/api/invest/positions-list', '/api/asset-distribution',
    '/api/get-account-info', '/api/account/list-all', '/api/get-fiat-info', '/api/get-digital-info']);
  const blockWrites: Parameters<typeof adminPage.route>[1] = async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && !readonlyPaths.has(path)) {
      blocked.push(path); await route.abort('blockedbyclient');
    } else await route.continue();
  };
  await adminPage.route('**/*', blockWrites);
  let clean: Awaited<ReturnType<typeof RegistrationKycStatusPage.cleanLogin>> | undefined;
  try {
    await admin.goto(env.admin.baseUrl!); await admin.openBahrainEditor();
    const original = await admin.readFeeConfiguration();
    const testFee = fixedUsdFee(process.env.ACCOUNT_TRANSFER_FIXED_FEE ?? '0.37');
    const currentFee = snapshotUsdFeeRule(original);
    business.setBusinessData({ transferFeeType: TRANSFER_FEE_LABELS[currentFee.type], originalTransferFee: currentFee.type === 'percent' ? `${currentFee.value}%` : currentFee.value,
      configuredTransferFee: testFee.amount, fromCurrency: 'USD', sourceAccountType: '巴林账户',
      targetAccountType: '香港账户', configurationSaveClicks: 0, configurationRestoreClicks: 0, finalSubmissionClicks: 0, securityVerificationClicks: 0 });
    await business.step({ action: '1. 唯一定位巴林配置，只编辑USD固定手续费并取消', expected: 'USD字段可编辑，其他费用/币种/开户设置不变，保存0次' }, async step => {
      await admin.fillUsdTransferFee(testFee.amount, original); await admin.cancelFeeEdit();
      await admin.goto(env.admin.baseUrl!); await admin.openBahrainEditor();
      expect(sameAccountTypeConfiguration(await admin.readFeeConfiguration(), original)).toBe(true);
      await admin.cancelFeeEdit();
      step.recordPrimaryOracle({ id: 'ATF-EDITOR', name: '编辑字段与取消隔离', expected: '仅USD固定费可改，取消后配置不变', actual: '通过', status: 'passed' });
      step.setActual('真实编辑弹窗已验证，未保存配置。');
    });
    clean = await RegistrationKycStatusPage.cleanLogin({ browser, baseURL: env.client.baseUrl!, email: env.client.username,
      password: env.client.password, otp: env.client.otp });
    const page = clean.statusPage.page;
    await page.route('**/*', blockWrites);
    const client = new AccountInternalTransferPage(page);
    await client.verifyIdentity(env.client.baseUrl!, env.client.username);
    const accounts = new AccountDetailPage(page); await accounts.goto(env.client.baseUrl!);
    const balance = await accounts.readSnapshot('巴林账户', 'USD');
    const amount = process.env.ACCOUNT_TRANSFER_AMOUNT ?? (currentFee.type === 'percent' ? '100.00' : new Decimal(currentFee.value).plus('1.13').toFixed(2));
    const secondAmount = currentFee.type === 'percent' ? new Decimal(amount).mul(2).toFixed(2) : new Decimal(amount).plus('0.17').toFixed(2);
    expect(new Decimal(balance.available).gt(secondAmount), 'Existing Bahrain USD balance must cover both previews without using all funds').toBe(true);
    await business.step({ action: '2. 默认Client账户按当前费用类型试算两个金额', expected: '巴林到香港USD，免手续费为零/固定费不变/百分比随金额变化，净额=金额-手续费；不提交' }, async step => {
      await client.goto(env.client.baseUrl!); await client.selectAccounts('巴林账户', '香港账户');
      const quotes = [];
      for (const value of [amount, secondAmount]) {
        const expectedFee = calculateExactTransferFee(currentFee, value);
        await client.preview(value);
        await expect.poll(async () => {
          const quote = await client.readQuote();
          return new Decimal(quote.fee).eq(expectedFee) && new Decimal(quote.received).eq(new Decimal(value).minus(expectedFee));
        }).toBe(true);
        const quote = await client.readQuote();
        verifyTransferFeeQuote(quote, currentFee, { sourceAccount: '巴林账户', targetAccount: '香港账户', amount: value });
        quotes.push(quote);
      }
      await client.expectNoSubmission();
      const records = await client.readRecords(env.client.baseUrl!);
      await admin.goto(env.admin.baseUrl!); await admin.openBahrainEditor();
      expect(sameAccountTypeConfiguration(await admin.readFeeConfiguration(), original), 'Current fee must not drift during Client preview').toBe(true);
      await admin.cancelFeeEdit();
      expect(blocked).toEqual([]);
      step.setBusinessData({ accountTransferFeeEvidence: JSON.stringify(quotes), configurationRestored: true });
      step.recordPrimaryOracle({ id: 'ATF-QUOTE', name: '当前类型与两个金额试算', expected: '费用按当前类型计算、金额与净额精确正确、无写操作', actual: '通过', status: 'passed' });
      step.setActual(`当前${TRANSFER_FEE_LABELS[currentFee.type]}${currentFee.value}${currentFee.type === 'percent' ? '%' : ' USD'}；试算${amount}/${secondAmount} USD，手续费${quotes.map(q=>q.fee).join('/')}，净额${quotes.map(q=>q.received).join('/')}。完整历史${records.length}条。未保存配置或提交。`);
    });
  } finally {
    if (blocked.length) console.log('ATF_DRY_RUN_BLOCKED_WRITE_PATHS', [...new Set(blocked)]);
    await adminPage.unroute('**/*', blockWrites);
    if (clean) await clean.context.close();
  }
});
