import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { test, expect } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment, FlowStateStore } from '../../../src/flow-engine';
import { AccountTransferFeeRun, type FeeRunEvidence } from '../../../src/transfer/account-transfer-fee-run';
import { fixedUsdFee, matchFeeRunTransfers, sameAccountTypeConfiguration, verifyFixedTransferQuote } from '../../../src/transfer/account-transfer-fee';
import { readVerifiedAccountTransferSettlement } from '../../../src/transfer/account-transfer-fee-verification';
import { RegistrationKycStatusPage } from '../../../pages/client/RegistrationKycStatusPage';
import { AccountInternalTransferPage } from '../../../pages/client/AccountInternalTransferPage';
import { AccountTypeConfigurationPage } from '../../../pages/admin/AccountTypeConfigurationPage';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('ATF-002 原订单实际到账字段更正只读复核 @readonly @reconciliation @L2', async ({ browser, adminPage, business }) => {
  test.setTimeout(180_000);
  business.flow('account-transfer-fee-reconciliation');
  expect(env.allowAdminMutationTests || env.allowClientMutationTests || env.exchange.allowMoneyTests).toBe(false);
  assertSandboxEnvironment(env.admin.baseUrl); assertSandboxEnvironment(env.client.baseUrl);
  const runId = process.env.ACCOUNT_TRANSFER_FEE_RUN_ID;
  if (!runId || !env.client.username || !env.client.password || !env.client.otp) throw new Error('Original Run and default Client authentication required.');
  const states = new FlowStateStore(), state = states.load('account-transfer-fee', runId);
  if (!state?.clientReference) throw new Error('Original submitted account transfer required; never start a new Run.');
  const path = states.pathFor('account-transfer-fee', runId).replace(/\.json$/, '.evidence');
  const e = JSON.parse(readFileSync(path, 'utf8')) as FeeRunEvidence;
  expect(e.identityHash === createHash('sha256').update(env.client.username.trim().toLowerCase()).digest('hex')).toBe(true);
  if (!e.order || e.order.orderNo !== state.clientReference || !e.restored || !e.original || e.quotes?.length !== 2) {
    throw new Error('Original order, restored configuration and two original previews must already exist.');
  }
  const attempts = Object.fromEntries(['apply', 'confirm', 'security', 'restore'].map(phase => [phase, Number(existsSync(`${path}.${phase}-attempt`))]));
  expect(Object.values(attempts)).toEqual([1, 1, 1, 1]);
  for (const quote of e.quotes) verifyFixedTransferQuote(quote, fixedUsdFee(e.fixedFee), { sourceAccount: '巴林账户', targetAccount: e.targetAccount, amount: quote.amount });
  business.disallowSafeRerun();
  business.setBusinessData({ sourceRunId: runId, clientTransferId: e.order.orderNo, clientTransactionId: e.order.txNo,
    transferAmount: e.amount, configuredTransferFee: e.fixedFee, originalTransferFee: e.original.currencies.USD.fee,
    sourceAccountType: '巴林账户', targetAccountType: e.targetAccount, fromCurrency: 'USD',
    configurationSaveClicks: 0, configurationRestoreClicks: 0, finalSubmissionClicks: 0, securityVerificationClicks: 0 });
  const readonlyQueries = new Set(['/api/transfer/records', '/admin-api/operation/account-domain/list',
    '/admin-api/operation/account-domain/detail', '/admin-api/operation/internal-transfer/list',
    '/api/asset-change-trend', '/api/get-activitys-table', '/api/invest/positions-list', '/api/asset-distribution',
    '/api/assets-overview', '/api/get-account-info', '/api/account/list-all', '/api/get-fiat-info', '/api/get-digital-info']);
  const blocked: string[] = [];
  const protect: Parameters<typeof adminPage.route>[1] = async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && !readonlyQueries.has(path)) {
      blocked.push(path); await route.abort('blockedbyclient');
    } else await route.continue();
  };
  await adminPage.route('**/*', protect);
  let clean: Awaited<ReturnType<typeof RegistrationKycStatusPage.cleanLogin>> | undefined;
  try {
    await business.step({ action: '1. 复核原配置已恢复及原Run单次执行证据', expected: '原手续费已恢复，原保存/提交/验证/恢复均只有一次，本次零写入' }, async step => {
      const admin = new AccountTypeConfigurationPage(adminPage);
      await admin.goto(env.admin.baseUrl!); await admin.openBahrainEditor();
      expect(sameAccountTypeConfiguration(await admin.readFeeConfiguration(), e.original!)).toBe(true);
      await admin.cancelFeeEdit();
      step.recordPrimaryOracle({ id: 'ATF-RESTORED-READONLY', name: '原配置和单次证据', expected: '已恢复且无重跑', actual: '通过', status: 'passed' });
      step.setActual('原配置已恢复；读取原Run，未重复改费或提交。');
    });
    clean = await RegistrationKycStatusPage.cleanLogin({ browser, baseURL: env.client.baseUrl!, email: env.client.username,
      password: env.client.password, otp: env.client.otp });
    await clean.context.route('**/*', protect);
    const client = new AccountInternalTransferPage(clean.statusPage.page);
    await client.verifyIdentity(env.client.baseUrl!, env.client.username);
    await business.step({ action: '2. 原TRF/TXN唯一关联，复核Admin实际到账金额', expected: '原Client订单已完成；Admin同TXN列表和详情金额/手续费/实际到账与原确认页一致' }, async step => {
      const candidates = matchFeeRunTransfers(await client.readRecords(env.client.baseUrl!), e, runId);
      expect(candidates).toHaveLength(1); expect(candidates[0].orderNo === e.order!.orderNo).toBe(true);
      e.order = candidates[0];
      e.settlement = await readVerifiedAccountTransferSettlement({ page: adminPage, baseURL: env.admin.baseUrl!,
        email: env.client.username!, evidence: e, record: candidates[0], business });
      expect(blocked).toEqual([]);
      business.setBusinessData({ clientFinalStatus: e.order.status, feeAmount: e.order.fee, receivedAmount: e.settlement.received,
        configurationRestored: true, accountTransferFeeEvidence: JSON.stringify({ originalAttempts: attempts, quotes: e.quotes, settlement: e.settlement }) });
      step.recordPrimaryOracle({ id: 'ATF-NET-RECONCILED', name: '实际到账与确认页一致', expected: e.quotes!.find(q=>q.amount===e.amount)!.received,
        actual: e.settlement.received, status: 'passed' });
      step.setActual(`原订单已完成；Admin实际到账${e.settlement.received} USD。接口actualAmount只保留原始诊断，不再误作到账Oracle。`);
    });
    if (state.stage !== 'COMPLETED') {
      const original = new AccountTransferFeeRun({ runId, email: env.client.username, fixedFee: e.fixedFee, amount: e.amount, targetAccount: e.targetAccount }, true);
      original.created(e.order); original.evidence.settlement = e.settlement; original.complete();
    }
    business.setResumeState('COMPLETED');
    business.recordDiagnostic({ id: 'ATF-ORACLE-CORRECTION', name: '原判定更正', status: 'info',
      summary: '原FAIL由接口字段语义误用造成。原失败报告保留，本报告为同一订单只读复核，无任何新业务Mutation。', affectsCoreBusiness: false });
  } finally {
    await adminPage.unroute('**/*', protect);
    if (clean) await clean.context.close();
  }
});
