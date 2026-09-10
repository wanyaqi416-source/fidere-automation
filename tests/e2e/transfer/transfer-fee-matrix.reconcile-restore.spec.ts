import { test, expect } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { MoneyMutationGuard, assertSandboxEnvironment } from '../../../src/flow-engine';
import { TransferFeeMatrixRun, matchMatrixOrders } from '../../../src/transfer/transfer-fee-matrix-run';
import { loginU2uParticipant } from '../../../src/user-transfer/u2u-participant';
import { AccountInternalTransferPage } from '../../../pages/client/AccountInternalTransferPage';
import { AccountTypeConfigurationPage } from '../../../pages/admin/AccountTypeConfigurationPage';
import { readVerifiedAccountTransferSettlement } from '../../../src/transfer/account-transfer-fee-verification';
import { sameAccountTypeConfiguration, withTransferFeeRule, snapshotFeeRule, transferFeeRule } from '../../../src/transfer/account-transfer-fee';
import type { FeeRunEvidence, InternalTransferRecord } from '../../../src/transfer/account-transfer-fee-run';
import { Decimal } from '../../../src/utils/money';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('原固定费互转只读核对并恢复配置，不创建或批准交易 @mutation @L4', async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(240_000);
  business.flow('transfer-fee-matrix-reconcile-restore');
  expect(env.exchange.allowMoneyTests || env.allowClientMutationTests).toBe(false);
  const guard = new MoneyMutationGuard('matrix-config-restore', true, false);
  guard.validateRuntime({ baseURL: env.admin.baseUrl, workers: testInfo.config.workers, retries: testInfo.project.retries,
    repeatEach: testInfo.project.repeatEach, safetySwitches: { ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests } });
  assertSandboxEnvironment(env.client.baseUrl);
  const runId = process.env.TRANSFER_FEE_MATRIX_RECONCILE_RUN_ID;
  if (!runId || process.env.ACCOUNT_TRANSFER_RESTORE_ORIGINAL !== 'true' || !env.client.username || !process.env.U2U_RECIPIENT_EMAIL) throw new Error('Original Run and configuration restoration authorization required.');
  const original = TransferFeeMatrixRun.readEvidence(runId);
  if (original.plan.kind !== 'internal' || original.plan.feeType !== 'fixed' || original.plan.currency !== 'USD') throw new Error('This reconciliation targets the existing fixed USD internal transfer only.');
  const run = new TransferFeeMatrixRun(runId, original.plan, env.client.username, process.env.U2U_RECIPIENT_EMAIL, undefined, true), e = run.evidence;
  if (!run.attempted('security') || !e.original || !e.quote || run.attempted('restore')) throw new Error('Original security attempt and unattempted config restoration required.');
  const clean = await loginU2uParticipant(browser, env.client.baseUrl!, env.client.username);
  try {
    // Browser reads only. Neither a Client submit nor an Admin approval is part of this entry point.
    await clean.context.route('**/*', async route => {
      const r = route.request(), path = new URL(r.url()).pathname;
      const denied = ['/api/transfer/internal','/api/transfer/p2p','/api/transfer/submit'];
      if (['PUT','PATCH','DELETE'].includes(r.method()) || (r.method() === 'POST' && !['/api/transfer/records'].includes(path))) await route.abort('blockedbyclient');
      else if (denied.includes(path)) await route.abort('blockedbyclient'); else await route.continue();
    });
    const history = new AccountInternalTransferPage(clean.page);
    await business.step({ action: '1. 只读恢复原TRF/TXN和自动完成证据', expected: '原Run金额/类型/方向/时间/备注和历史基线匹配，候选1；Client确认与验证均0次' }, async step => {
      let matches: InternalTransferRecord[] = [];
      await expect.poll(async () => {
        matches = matchMatrixOrders(await history.readRecords(env.client.baseUrl!), e, runId);
        business.setBusinessData({ candidateCount: matches.length });
        if (matches.length > 1) throw new Error('Multiple matching original orders; no mutation allowed.');
        return matches.length === 1 ? matches[0].status : 'missing';
      }, { timeout: 60_000, intervals: [1000, 3000] }).toBe('approved');
      run.created(matches[0]); expect(new Decimal(matches[0].fee).eq(e.plan.fee)).toBe(true);
      const legacyEvidence: FeeRunEvidence = { identityHash: e.senderHash, fixedFee: e.plan.fee, amount: e.plan.amount, targetAccount: '香港账户',
        original: e.original, originalOrderIds: e.baselineIds, stage: 'CLIENT_CREATED', applied: true, restored: false,
        submittedAt: e.submittedAt, order: e.order, quotes: [e.quote!] };
      const settlement = await readVerifiedAccountTransferSettlement({ page: adminPage, baseURL: env.admin.baseUrl!, email: env.client.username!,
        evidence: legacyEvidence, record: e.order!, business });
      e.adminStatus = settlement.adminStatus; e.adminNet = settlement.received; e.verified = true; run.advance('CLIENT_FINALIZED');
      step.setActual(`原订单已批准；金额${e.plan.amount}，费用${e.plan.fee}，实际到账${e.adminNet}。没有重交或再次验证。`);
      step.recordPrimaryOracle({ id: 'original', name: '原资金业务确认完成', expected: '唯一原订单及费用到账正确', actual: '通过', status: 'passed' });
    });
    await business.step({ action: '2. 仅恢复原配置一次', expected: '当前仍为本Run固定费0.37才恢复原完整配置；不批准或创建交易' }, async step => {
      const admin = new AccountTypeConfigurationPage(adminPage);
      await admin.goto(env.admin.baseUrl!); await admin.openBahrainEditor();
      const current = await admin.readFeeConfiguration();
      if (!sameAccountTypeConfiguration(current, e.original!)) {
        expect(sameAccountTypeConfiguration(current, withTransferFeeRule(e.original!, transferFeeRule('USD','fixed',e.plan.fee)))).toBe(true);
        await admin.fillTransferFeeRule(snapshotFeeRule(e.original!, 'USD'), current);
        try { await admin.saveFeeOnce('restore', e.original!, () => { run.attempt('restore'); business.markMutationPerformed('仅恢复原USD费率配置一次'); }); }
        catch (error) { if (!run.attempted('restore')) throw error; business.recordDiagnostic({ id:'restore-ui',name:'恢复后UI',status:'info',summary:'已尝试保存一次，仅回读',affectsCoreBusiness:false }); }
        await admin.goto(env.admin.baseUrl!); await admin.openBahrainEditor();
        expect(sameAccountTypeConfiguration(await admin.readFeeConfiguration(),e.original!)).toBe(true);
      }
      await admin.cancelFeeEdit(); e.restored=true; run.save(); run.complete();
      step.setActual('原5%配置及其他全部字段已恢复并回读。资金操作0次。');
      step.recordPrimaryOracle({ id:'restore',name:'原完整配置已恢复',expected:'原类型和值',actual:'通过',status:'passed' });
    });
    business.setResumeState(run.state.stage);
    business.setBusinessData({runId,clientTransferId:e.order!.orderNo,adminTransactionId:e.order!.txNo,transferAmount:e.plan.amount,
      feeAmount:e.plan.fee,receivedAmount:e.adminNet,adminFinalStatus:e.adminStatus,clientFinalStatus:e.order!.status,
      finalSubmissionClicks:0,securityVerificationClicks:0,adminMutationClicks:0,configurationRestoreClicks:Number(run.attempted('restore')),
      configurationRestored:e.restored,confirmed:e.verified,safeToRerun:false});
  } finally { await clean.context.close(); }
});
