import { AdminFiatAccountReviewPage } from '../../../pages/admin/AdminFiatAccountReviewPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { WithdrawalPage } from '../../../pages/client/WithdrawalPage';
import { WithdrawalHistoryPage } from '../../../pages/client/WithdrawalHistoryPage';
import { expect, test } from '../../../fixtures/registration.fixture';
import { env } from '../../../src/config/env';
import { PersonalPostRegistrationJourneyStore } from '../../../src/journey';
import { maskRegistrationEmail, openPersonalJourneyClientSession, PersonalJourneyContextStore } from '../../../src/registration';
import { runWithdrawalAuthPreflight } from '../../../src/withdrawal/withdrawal-auth-preflight';
import { deriveUnusedWithdrawalAmount, WithdrawalExecutionGuard } from '../../../src/withdrawal/withdrawal-e2e';
import { validateWithdrawalProofAsset } from '../../../src/withdrawal/withdrawal-proof';
import { assertSandboxEnvironment } from '../../../src/flow-engine/mutation-guard';
import { getWithdrawalApprovalConfig, getWithdrawalTestConfig } from '../../client/withdrawal/withdrawalTestSupport';

test.skip(!env.personalRegistration.adminApprovalSourceRunId, 'Requires an explicitly selected existing Journey.');
test('Personal Golden Journey Withdrawal preflight @journey @withdrawal @readonly @dry-run @L3', async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(180_000);
  const sourceRunId = env.personalRegistration.adminApprovalSourceRunId;
  if (!sourceRunId || !env.client.baseUrl || !env.admin.baseUrl) throw new Error('Journey source and Client/Admin URLs are required.');
  assertSandboxEnvironment(env.client.baseUrl);
  assertSandboxEnvironment(env.admin.baseUrl);
  const source = new PersonalJourneyContextStore().load(sourceRunId);
  const state = new PersonalPostRegistrationJourneyStore(sourceRunId).load();
  if (!source?.displayName || !source.sequence || !state || state.stage !== 'COMPLETED' || state.depositApproveCount !== 1 || !state.balanceAfter) {
    throw new Error('The existing Journey must already have completed its real deposit.');
  }
  const config = getWithdrawalTestConfig();
  const approval = getWithdrawalApprovalConfig();
  const runId = `PGJ-WD-${sourceRunId}`;
  const suffix = state.fiatAddressAccountSuffix!;
  business.case({
    caseId: 'PERSONAL-GJ-WD-PREFLIGHT', module: 'Fresh Personal Golden Journey',
    name: '同一已入金用户出金前置检查', priority: 'P0', type: ['Dry Run', 'Read-only'],
    scope: 'Client + Admin', changesData: false, affectsMoney: false,
    preconditions: ['原Journey真实入金已完成'], dependsOnAdmin: true, dependsOnThirdParty: false,
    expectedResult: '原用户干净登录，已通过地址可用，余额和出金确认费用可读；不提交出金或审核。'
  });
  business.setBusinessData({ sourceRunId, user: source.displayName, email: maskRegistrationEmail(source.email), accountType: config.accountType, currency: config.currency, beneficiaryAccountSuffix: `****${suffix}`, confirmationClicks: 0, securityVerificationClicks: 0, adminMutationClicks: 0 });
  const client = await openPersonalJourneyClientSession({ browser, baseURL: env.client.baseUrl, runId: sourceRunId, email: source.email, password: env.client.password!, otp: env.client.otp!, forceFreshLogin: true });
  const feeResponses: Promise<unknown>[] = [];
  client.page.on('response', response => {
    if (!new URL(response.url()).pathname.includes('get-out-cash-fee')) return;
    feeResponses.push((async () => {
      const value: unknown = await response.json();
      const fields: Record<string, string | number | null> = {};
      function inspect(input: unknown, prefix = ''): void {
        if (input && typeof input === 'object') {
          for (const [key, child] of Object.entries(input)) inspect(child, `${prefix}.${key}`);
        } else if (/fee|amount|debit|net|code|^\.data$/i.test(prefix) &&
          !/token|cookie|key|authorization|user|account|phone|email/i.test(prefix) &&
          (input === null || typeof input === 'number' || (typeof input === 'string' && /^-?\d+(\.\d+)?$/.test(input)))) {
          fields[prefix] = input;
        }
      }
      inspect(value);
      return { path: new URL(response.url()).pathname, status: response.status(), fields };
    })().catch(() => ({ path: new URL(response.url()).pathname, status: response.status(), unreadable: true })));
  });
  try {
    const withdrawal = new WithdrawalPage(client.page);
    await business.step({ action: '0. 原Journey干净登录并读取实时余额', expected: '只读取原用户账户，不创建用户、入金或出金。' }, async context => {
      const account = new AccountDetailPage(client.page);
      await account.goto(env.client.baseUrl!);
      const balance = await account.readAvailableBalance(config.accountType, config.currency);
      context.setBusinessData({ beforeAvailableBalance: balance.availableBalance.toString(), availableBalance: balance.availableBalance.toString() });
      context.setActual(`原用户${source.displayName}干净登录成功；${config.accountType}${config.currency}实时可用余额=${balance.availableBalance}。`);
    });
    await business.step({ action: '1. 双端认证和原银行地址审核证据', expected: '原用户可正常使用Client；Admin认证有效；原法币地址仍在已通过列表。' }, async context => {
      try {
        await runWithdrawalAuthPreflight({ clientPage: client.page, adminPage, clientBaseUrl: env.client.baseUrl!, adminBaseUrl: env.admin.baseUrl!, guard: new WithdrawalExecutionGuard() });
      } catch (error) {
        if (error instanceof Error && /auth:admin/.test(error.message)) {
          testInfo.annotations.push({ type: 'blocker', description: 'ADMIN_AUTH_EXPIRED: run npm run auth:admin before creating any Withdrawal.' });
          context.setActual('Admin出金业务页重定向到登录页；需要运行npm run auth:admin。未提交出金，未执行Admin审核。');
          context.setBusinessData({ finalStatus: 'ADMIN_AUTH_EXPIRED', confirmed: false, createdOrderCount: 0, confirmationClicks: 0, securityVerificationClicks: 0, adminMutationClicks: 0 });
        }
        throw error;
      }
      const banks = new AdminFiatAccountReviewPage(adminPage);
      await banks.goto(env.admin.baseUrl!, '已通过');
      const result = await banks.locateCandidate({ email: source.email, displayName: source.displayName!, bankName: `FIDERE SANDBOX BANK ${source.displayName!.split(' ').at(-1)}`, bankAccount: `88000000${String(source.sequence).padStart(4, '0')}` });
      expect(result.candidateCount).toBe(1);
      expect(result.candidates[0].accountId).toBe(state.fiatAddressReference);
      await validateWithdrawalProofAsset();
      context.setActual('原用户干净登录成功；Client首页正常；Admin业务页和原已通过银行地址可读取。');
    });
    const history = new WithdrawalHistoryPage(client.page);
    await history.goto(env.client.baseUrl);
    const previous = await history.readRecords();
    const amount = deriveUnusedWithdrawalAmount(runId, config.uniqueAmountBase, config.amountPrecision, previous.map(record => record.requestedAmount));
    await business.step({ action: '2. 读取实时余额并选择原银行地址', expected: '原法域账户有余额，选择本次Journey收款地址，金额小于可用余额。' }, async context => {
      const account = new AccountDetailPage(client.page);
      await account.goto(env.client.baseUrl!);
      const balance = await account.readAvailableBalance(config.accountType, config.currency);
      context.setBusinessData({ beforeAvailableBalance: balance.availableBalance.toString(), requestedAmount: amount.toString(), previousWithdrawalCount: previous.length });
      await withdrawal.goto(env.client.baseUrl!);
      await withdrawal.selectAccount(config.accountType);
      await withdrawal.selectCurrency(config.currencyLabel);
      const snapshot = await withdrawal.readBalanceSnapshot();
      expect(snapshot.availableBalance.equals(balance.availableBalance)).toBe(true);
      expect(amount.isPositive() && amount.lessThan(snapshot.availableBalance)).toBe(true);
      await withdrawal.selectBeneficiary({ name: source.displayName!, accountSuffix: suffix, currency: config.currency });
      context.setActual(`当前余额=${snapshot.availableBalance} ${config.currency}；拟出金=${amount}；原收款账户已选中。`);
    });
    await business.step({ action: '3. 只读核对出金表单与确认报价', expected: '用途、转账方式、支持性文件与费用可读；不点击确认转账或安全密钥。' }, async context => {
      const purposes = await withdrawal.readPurposeOptions();
      const methods = await withdrawal.readTransferMethodOptions();
      context.setBusinessData({ withdrawalPurposeOptions: purposes, withdrawalTransferMethodOptions: methods });
      await testInfo.attach('withdrawal-form-options', { body: JSON.stringify({ purposes, methods }), contentType: 'application/json' });
      await withdrawal.selectPurpose(config.purpose);
      await withdrawal.selectTransferMethod(config.transferMethod);
      await withdrawal.uploadSupportingDocument(config.supportingDocumentPath);
      await withdrawal.fillAmount(amount.toFixed(config.amountPrecision));
      const quote = await withdrawal.continueToConfirmation();
      const limits = await withdrawal.readDisplayedLimits();
      context.setBusinessData({ requestedAmount: amount.toString(), feeAmount: quote.feeText, actualDebitAmount: quote.actualDebitText, selectedPaymentChannel: approval.paymentChannel, selectedPaymentBank: approval.paymentBank });
      await testInfo.attach('withdrawal-preflight-quote', { body: JSON.stringify({ requestedAmount: amount.toString(), feeText: quote.feeText, actualDebitText: quote.actualDebitText, limits }), contentType: 'application/json' });
      const feeEvidence: unknown[] = [];
      for (const response of feeResponses) feeEvidence.push(await response);
      await testInfo.attach('withdrawal-safe-fee-response', { body: JSON.stringify(feeEvidence), contentType: 'application/json' });
      console.log('Withdrawal fee-only evidence:', JSON.stringify(feeEvidence));
      expect(withdrawal.confirmationClicks()).toBe(0);
      expect(withdrawal.securityVerificationClicks()).toBe(0);
      context.setActual(`确认页金额=${quote.requestedAmountText}；手续费=${quote.feeText}；实际扣款=${quote.actualDebitText}；未提交。`);
    });
  } finally {
    await client.context.close();
  }
});
