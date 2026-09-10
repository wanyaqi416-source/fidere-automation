import { test, expect } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment } from '../../../src/flow-engine';
import { AccountTypeConfigurationPage } from '../../../pages/admin/AccountTypeConfigurationPage';
import { AccountInternalTransferPage } from '../../../pages/client/AccountInternalTransferPage';
import { UserToUserTransferPage } from '../../../pages/client/UserToUserTransferPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { loginU2uParticipant } from '../../../src/user-transfer/u2u-participant';
import { parseU2uAmount } from '../../../src/user-transfer/u2u-summary';
import { TRANSFER_FEE_MATRIX, describeTransferFeeMatrixRow } from '../../../src/transfer/transfer-fee-matrix';
import { snapshotFeeRule, sameAccountTypeConfiguration, verifyTransferFeeQuote, calculateExactTransferFee } from '../../../src/transfer/account-transfer-fee';
import { Decimal } from '../../../src/utils/money';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
for (const row of TRANSFER_FEE_MATRIX) test(`${row.currency} 三模式两类转账实际准备检查 @dry-run @L3`, async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(180_000);
  business.flow(`transfer-fee-matrix-${row.currency.toLowerCase()}-preflight`);
  assertSandboxEnvironment(env.admin.baseUrl); assertSandboxEnvironment(env.client.baseUrl);
  expect(env.allowAdminMutationTests || env.allowClientMutationTests || env.exchange.allowMoneyTests).toBe(false);
  expect(testInfo.config.workers).toBe(1); expect(testInfo.project.retries).toBe(0); expect(testInfo.project.repeatEach).toBe(1);
  const sender = env.client.username, recipient = process.env.U2U_RECIPIENT_EMAIL;
  if (!sender || !recipient || sender.toLowerCase() === recipient.toLowerCase()) throw new Error('Distinct configured Sender and Recipient required.');
  business.setBusinessData({ senderIdentity: sender, recipientIdentity: recipient, transferCurrency: row.currency,
    sourceAccountType: '巴林账户', configurationSaveClicks: 0, finalSubmissionClicks: 0, securityVerificationClicks: 0, adminMutationClicks: 0 });
  const blocked: string[] = [];
  const readonlyPaths = new Set(['/api/transfer/fee-preview', '/api/transfer/records', '/api/assets-overview',
    '/admin-api/operation/account-domain/list', '/admin-api/operation/account-domain/detail',
    '/api/asset-change-trend', '/api/get-activitys-table', '/api/invest/positions-list', '/api/asset-distribution',
    '/api/get-account-info', '/api/account/list-all', '/api/get-fiat-info', '/api/get-digital-info', '/api/coin/get-info']);
  const protect: Parameters<typeof adminPage.route>[1] = async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && !readonlyPaths.has(path)) {
      blocked.push(path); await route.abort('blockedbyclient');
    } else await route.continue();
  };
  await adminPage.route('**/*', protect);
  let clean: Awaited<ReturnType<typeof loginU2uParticipant>> | undefined;
  try {
    const admin = new AccountTypeConfigurationPage(adminPage);
    await admin.goto(env.admin.baseUrl!); await admin.openBahrainEditor();
    const original = await admin.readFeeConfiguration(), currentRule = snapshotFeeRule(original, row.currency);
    expect(original.currencies[row.currency].enabled).toBe(true);
    await business.step({ action: '1. 读取现配置，填写本币种拟测模式后取消', expected: '仅修改该币种表单，取消后完整配置不变' }, async step => {
      await admin.fillTransferFeeRule(row.rule, original); await admin.cancelFeeEdit();
      await admin.goto(env.admin.baseUrl!); await admin.openBahrainEditor();
      expect(sameAccountTypeConfiguration(await admin.readFeeConfiguration(), original)).toBe(true);
      await admin.cancelFeeEdit();
      step.setActual(`原模式${currentRule.type}、参数${currentRule.value}；拟测${row.rule.type}、参数${row.rule.value}。没有保存。`);
    });
    clean = await loginU2uParticipant(browser, env.client.baseUrl!, sender);
    await clean.context.route('**/*', protect);
    const page = clean.page, accounts = new AccountDetailPage(page);
    await accounts.goto(env.client.baseUrl!);
    const balance = await accounts.readSnapshot('巴林账户', row.currency);
    business.setBusinessData({ beforeAvailableBalance: balance.available });
    console.log('MATRIX_AVAILABLE_BALANCE', row.currency, balance.available);
    if (row.currency === 'HKD') {
      const other = [];
      for (const currency of ['CNY','EUR']) {
        if (original.currencies[currency]?.enabled) other.push(await accounts.readSnapshot('巴林账户', currency));
      }
      console.log('MATRIX_ALTERNATIVE_BALANCES', JSON.stringify(other.map(item=>({currency:item.currency,available:item.available}))));
      business.setBusinessData({ accountTransferFeeEvidence: JSON.stringify({ alternativeBalances: other, currentRule }) });
    }
    const planned = describeTransferFeeMatrixRow(row, balance.available);
    business.setBusinessData({ beforeAvailableBalance: balance.available, accountTransferFeeEvidence: JSON.stringify({ currentRule, proposedRule: row.rule, planned }) });
    await business.step({ action: '2. 默认账号账户资金互转试算', expected: '原配置下费用及净额正确；拟测两笔金额合计小于现有余额；不提交' }, async step => {
      const client = new AccountInternalTransferPage(page);
      await client.goto(env.client.baseUrl!); await client.selectAccounts('巴林账户', '香港账户', row.currency);
      await client.preview(row.internalAmount);
      await expect.poll(async () => new Decimal((await client.readQuote()).fee).eq(calculateExactTransferFee(currentRule, row.internalAmount))).toBe(true);
      const quote = await client.readQuote();
      verifyTransferFeeQuote(quote, currentRule, { sourceAccount: '巴林账户', targetAccount: '香港账户', amount: row.internalAmount });
      await client.expectNoSubmission();
      step.setActual(`${row.currency}可用${balance.available}；账户互转金额${quote.amount}，当前手续费${quote.fee}，预计到账${quote.received}。仅试算。`);
    });
    await business.step({ action: '3. 同币种用户转账试算与待执行计划', expected: '固定测试收款人；巴林对应资产可选；用户转账共用现费率；不提交、不审核' }, async step => {
      const userTransfer = new UserToUserTransferPage(page);
      await userTransfer.goto(env.client.baseUrl!); await userTransfer.fillRecipient(sender, recipient);
      const preview = await userTransfer.previewUniqueAsset(row.currency, row.userAmount, '巴林账户');
      expect(preview.submitEnabled).toBe(true); expect(preview.quote.transferable).toBe(true);
      expect(parseU2uAmount(preview.fee, row.currency, true).eq(calculateExactTransferFee(currentRule, row.userAmount))).toBe(true);
      expect(preview.sourceAccountType).toBe('巴林账户');
      expect(userTransfer.confirmationClickCount()).toBe(0);
      expect(userTransfer.security.wasVerificationClicked()).toBe(false);
      await admin.goto(env.admin.baseUrl!); await admin.openBahrainEditor();
      expect(sameAccountTypeConfiguration(await admin.readFeeConfiguration(), original)).toBe(true);
      await admin.cancelFeeEdit(); expect(blocked).toEqual([]);
      step.setActual(`用户转账金额${row.userAmount}，当前手续费${preview.quote.fee}，预计到账${preview.quote.expectedCredit}。收款资格按真实页面在提交时验证；不得将按钮可用当资格证明。后续需要唯一原TXN和Admin审批，不追加余额/流水检查。`);
      step.recordPrimaryOracle({ id: 'MATRIX-PREFLIGHT', name: '同币种两类表单、现费率与余额条件', expected: '只读检查通过', actual: '通过', status: 'passed' });
    });
  } finally {
    await adminPage.unroute('**/*', protect);
    if (clean) await clean.context.close();
  }
});
