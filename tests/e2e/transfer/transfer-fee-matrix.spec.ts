import { test, expect } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { MoneyMutationGuard, assertSandboxEnvironment } from '../../../src/flow-engine';
import { AccountTypeConfigurationPage } from '../../../pages/admin/AccountTypeConfigurationPage';
import { AccountInternalTransferPage } from '../../../pages/client/AccountInternalTransferPage';
import { UserToUserTransferPage } from '../../../pages/client/UserToUserTransferPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { TransferListPage } from '../../../pages/admin/TransferListPage';
import { TransferDetailPage } from '../../../pages/admin/TransferDetailPage';
import { loginU2uParticipant } from '../../../src/user-transfer/u2u-participant';
import { openOriginalU2uReview, readOriginalU2uApproval } from '../../../src/user-transfer/u2u-admin-review';
import { matchesAdminCustomerIdentity } from '../../../src/transfer/transfer-e2e';
import { fundedUsdMatrix } from '../../../src/transfer/transfer-fee-matrix';
import { TransferFeeMatrixRun, matchMatrixOrders } from '../../../src/transfer/transfer-fee-matrix-run';
import { transferFeeRule, snapshotFeeRule, sameAccountTypeConfiguration, verifyTransferFeeQuote,
  withTransferFeeRule, type AccountTransferQuote } from '../../../src/transfer/account-transfer-fee';
import type { InternalTransferRecord } from '../../../src/transfer/account-transfer-fee-run';
import { Decimal } from '../../../src/utils/money';
import { maskSensitiveText } from '../../../src/reporting/sensitive-data-mask';

test.describe.configure({ mode: 'serial', retries: 0 });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
const plans = fundedUsdMatrix();
for (const plan of plans) test(`ATFM ${plan.feeType} ${plan.kind} USD手续费真实闭环 @mutation @money @L4`, async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(360_000);
  business.flow(`transfer-fee-matrix-${plan.feeType}-${plan.kind}`);
  const batch = process.env.TRANSFER_FEE_MATRIX_RUN_ID, recipient = process.env.U2U_RECIPIENT_EMAIL;
  if (!batch || process.env.TRANSFER_FEE_MATRIX_PLAN !== 'USD_ONLY' || process.env.ACCOUNT_TRANSFER_RESTORE_ORIGINAL !== 'true' ||
    !recipient || !env.client.username || !env.client.securityKey) throw new Error('Named USD_ONLY batch, configured identities/key and restore authorization required.');
  const runId = `${batch}-${plan.feeType}-${plan.kind}`;
  const switches = { ALLOW_MONEY_TESTS: env.exchange.allowMoneyTests, ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests,
    ALLOW_CLIENT_MUTATION_TESTS: env.allowClientMutationTests };
  const guard = new MoneyMutationGuard(runId, true, true);
  const validate = () => {
    assertSandboxEnvironment(env.admin.baseUrl);
    guard.validateRuntime({ baseURL: env.client.baseUrl, workers: testInfo.config.workers, retries: testInfo.project.retries,
      repeatEach: testInfo.project.repeatEach, safetySwitches: switches });
    expect(testInfo.retry + testInfo.repeatEachIndex).toBe(0);
  };
  validate();
  const run = new TransferFeeMatrixRun(runId, plan, env.client.username, recipient), e = run.evidence;
  const rule = transferFeeRule(plan.currency, plan.feeType, plan.feeValue), admin = new AccountTypeConfigurationPage(adminPage);
  let clean: Awaited<ReturnType<typeof loginU2uParticipant>> | undefined, failure: unknown;
  const report = () => {
    business.setResumeState(run.state.stage);
    business.setBusinessData({ runId, senderIdentity: env.client.username, recipientIdentity: plan.kind === 'p2p' ? recipient : undefined,
      transferFeeType: rule.type, configuredTransferFee: rule.value, originalTransferFee: e.original?.currencies[plan.currency].fee,
      transferCurrency: plan.currency, transferAmount: plan.amount, feeAmount: plan.fee, receivedAmount: e.adminNet ?? plan.expectedCredit,
      sourceAccountType: '巴林账户', targetAccountType: e.quote?.targetAccount,
      beforeAvailableBalance: e.beforeAvailable, clientTransferId: e.order?.orderNo, adminTransactionId: e.order?.txNo,
      finalSubmissionClicks: Number(run.attempted('confirm')), securityVerificationClicks: Number(run.attempted('security')),
      adminMutationClicks: e.approvalClicks ?? Number(run.attempted('approve')), configurationSaveClicks: Number(run.attempted('apply')),
      configurationRestoreClicks: Number(run.attempted('restore')), configurationRestored: e.restored,
      clientFinalStatus: plan.kind === 'internal' ? e.order?.status : undefined, adminFinalStatus: e.adminStatus, confirmed: e.verified, safeToRerun: false,
      accountTransferFeeEvidence: JSON.stringify({ plan, quote: e.quote, order: e.order, adminNet: e.adminNet, restored: e.restored }) });
  };
  const readConfiguration = async () => {
    await admin.goto(env.admin.baseUrl!); await admin.openBahrainEditor(); return admin.readFeeConfiguration();
  };
  const diag = (id: string, summary: string) => business.recordDiagnostic({ id, name: '单次动作后的只读确认', status: 'info', summary, affectsCoreBusiness: false });
  try {
    await business.step({ action: '1. 双端认证、原配置、余额及历史订单基线', expected: '默认账号KYC正常；仅使用现有USD；保存完整原配置；不注册或造余额' }, async step => {
      e.original = await readConfiguration(); withTransferFeeRule(e.original, rule); await admin.cancelFeeEdit();
      clean = await loginU2uParticipant(browser, env.client.baseUrl!, env.client.username!);
      guard.markAuthenticationReady(true, true);
      const accounts = new AccountDetailPage(clean.page); await accounts.goto(env.client.baseUrl!);
      e.beforeAvailable = (await accounts.readSnapshot('巴林账户', plan.currency)).available;
      const remainingBudget = plans.slice(plans.indexOf(plan)).reduce((sum, item) => sum.plus(item.amount), new Decimal(0));
      expect(new Decimal(e.beforeAvailable).gt(remainingBudget), 'Existing funds must cover all remaining authorized small transfers').toBe(true);
      const records = await new AccountInternalTransferPage(clean.page).readRecords(env.client.baseUrl!);
      e.baselineIds = records.map(row => row.orderNo); run.save(); report();
      step.setActual(`原配置${snapshotFeeRule(e.original, plan.currency).type}/${e.original.currencies[plan.currency].fee}；可用余额充足；独立Run=${runId}。`);
    });
    const history = new AccountInternalTransferPage(clean!.page);
    await business.step({ action: '2. 保存本笔测试费率并完整回读', expected: '只改变巴林USD费用模式和值，其他配置不变；相同配置不重复保存' }, async step => {
      const current = await readConfiguration(), expected = withTransferFeeRule(e.original!, rule);
      expect(sameAccountTypeConfiguration(current, e.original!)).toBe(true);
      if (!sameAccountTypeConfiguration(current, expected)) {
        await admin.fillTransferFeeRule(rule, current);
        try { await admin.saveFeeOnce('apply', expected, () => { validate(); run.attempt('apply'); business.markMutationPerformed('保存本Run测试费率一次'); }); }
        catch (error) { if (!run.attempted('apply')) throw error; diag('config-save', '保存已尝试，仅回读配置，不再次保存。'); }
        expect(sameAccountTypeConfiguration(await readConfiguration(), expected)).toBe(true);
      }
      await admin.cancelFeeEdit(); e.applied = true; run.save(); report();
      step.setActual(`${plan.currency} ${rule.type} ${rule.value} 已回读，其他字段未变。`);
    });
    const client = plan.kind === 'internal' ? history : new UserToUserTransferPage(clean!.page);
    await business.step({ action: '3. 重新加载Client并精确核对本笔试算', expected: '金额、币种、方向、费用类型和值、金额减手续费后的预计到账全部正确' }, async step => {
      await client.goto(env.client.baseUrl!);
      if (client instanceof AccountInternalTransferPage) {
        await client.selectAccounts('巴林账户', '香港账户', plan.currency);
        e.quote = await client.preview(plan.amount);
      } else {
        await client.fillRecipient(env.client.username!, recipient);
        const preview = await client.previewUniqueAsset(plan.currency, plan.amount, '巴林账户');
        expect(preview.submitEnabled && preview.quote.transferable).toBe(true);
        e.quote = { sourceAccount: preview.sourceAccountType, targetAccount: '收款用户（账户待订单确认）', currency: plan.currency,
          amount: preview.quote.amount, fee: preview.quote.fee, received: preview.quote.expectedCredit };
      }
      verifyTransferFeeQuote(e.quote, rule, { sourceAccount: '巴林账户', targetAccount: e.quote.targetAccount, amount: plan.amount });
      await client.fillRunNote(runId); run.save(); report();
      step.setActual(`金额${e.quote.amount}；手续费${e.quote.fee}；预计到账${e.quote.received} ${plan.currency}。用户收款资格仍由服务端在提交时验证。`);
    });
    await business.step({ action: '4. Client确认和安全验证各一次，读取唯一新TRF/TXN', expected: '完整历史中存在本Run唯一业务；未知结果禁止重复提交' }, async step => {
      expect(sameAccountTypeConfiguration(await readConfiguration(), withTransferFeeRule(e.original!, rule))).toBe(true);
      await admin.cancelFeeEdit();
      guard.assertClientMoneyConfirmationAllowed(switches);
      await client.confirmOnce(() => { validate(); run.attempt('confirm'); guard.recordClientMoneyConfirmation(); business.disallowSafeRerun(); report(); });
      await client.security.fill(env.client.securityKey!);
      guard.assertSecurityKeyVerificationAllowed(switches); run.attempt('security'); guard.recordSecurityKeyVerification();
      business.markPotentiallySubmitted(); report();
      try { await client.security.verifyOnce(); }
      catch { diag('security', '安全验证已尝试一次，仅查询本Run原订单，绝不重交。'); }
      let matches: InternalTransferRecord[] = [];
      await expect.poll(async () => {
        matches = matchMatrixOrders(await history.readRecords(env.client.baseUrl!), e, runId);
        business.setBusinessData({ candidateCount: matches.length });
        if (matches.length > 1) throw new Error('Multiple new Run orders; stop before Admin mutation.');
        return matches.length;
      }, { timeout: 75_000, intervals: [1000, 3000], message: 'TRANSFER_SUBMISSION_UNCONFIRMED' }).toBe(1);
      run.created(matches[0]); guard.assertClientSubmissionAllowed(switches); guard.recordClientSubmission();
      expect(new Decimal(e.order!.fee).eq(plan.fee)).toBe(true);
      report(); step.setActual('同一Run、历史基线之外、类型/方向/币种/金额/时间匹配，唯一真实TRF和TXN已保存。');
    });
    await business.step({ action: plan.kind === 'internal' ? '5. 核对原资金互转自动完成及实际到账' : '5. 唯一定位原用户转账，核对详情并批准一次',
      expected: '原TXN候选恰好一条；用户、方向、金额、费用和实际到账与Client一致；不操作其他历史订单' }, async step => {
      const record = e.order!;
      if (plan.kind === 'p2p') {
        const names: Record<string, string> = { HK: '香港账户', BH: '巴林账户', SG: '新加坡账户', US: '美国账户' };
        const target = names[record.toRegion];
        if (!target) throw new Error('Original recipient account is not established by the created order.');
        const original = await openOriginalU2uReview({ page: adminPage, baseURL: env.admin.baseUrl!, sender: env.client.username!, recipient,
          evidence: { senderLedgerId: record.txNo, submittedAt: e.submittedAt, sourceAccountType: '巴林账户', targetAccountType: target,
            currency: plan.currency, amount: plan.amount, fee: plan.fee, expectedCredit: plan.expectedCredit }, business });
        e.adminNet = original.detail.receivedAmount; run.advance('ADMIN_LOCATED'); guard.recordUniqueAdminCandidate(1);
        await original.review.fillRemark(`AUTO_FEE_APPROVE_${runId}`);
        expect(await original.review.readRemarkValue()).toBe(`AUTO_FEE_APPROVE_${runId}`);
        validate(); guard.assertAdminActionAllowed(switches); run.attempt('approve'); guard.recordAdminAction();
        business.markMutationPerformed('批准本Run原用户转账一次'); report();
        try { await original.review.confirmApproveOnce(switches.ALLOW_MONEY_TESTS, switches.ALLOW_ADMIN_MUTATION_TESTS); }
        catch (error) { if (!original.review.wasApproved()) throw error; diag('approval', '批准已点击一次，只查询原TXN真实审核状态。'); }
        finally { e.approvalClicks = original.review.approvalClickCount(); e.approvalConfirmations = original.review.secondaryConfirmationClickCount(); run.save(); }
        e.adminStatus = (await readOriginalU2uApproval(original.list, env.admin.baseUrl!, env.client.username!, record.txNo)).status;
        run.advance('ADMIN_ACTION_DONE');
        step.setActual(`唯一原TXN，详情全部一致；批准${e.approvalClicks}次，状态${e.adminStatus}。到此确认审核提交成功，不追加双方余额或流水检查。`);
      } else {
        await expect.poll(async () => {
          const matches = matchMatrixOrders(await history.readRecords(env.client.baseUrl!), e, runId);
          expect(matches).toHaveLength(1); run.created(matches[0]); return matches[0].status;
        }, { timeout: 60_000, intervals: [1000, 3000] }).toBe('approved');
        const list = new TransferListPage(adminPage);
        await adminPage.goto(new URL('/zh-CN/operation/fiatAssets', env.admin.baseUrl!).toString(), { waitUntil: 'domcontentloaded' });
        await list.goto(env.admin.baseUrl!);
        let candidates = [] as Awaited<ReturnType<TransferListPage['readAllFilteredRecords']>>;
        await expect.poll(async () => {
          candidates = (await list.readAllFilteredRecords()).filter(row => row.adminTransactionId === record.txNo);
          business.setBusinessData({ candidateCount: candidates.length, candidateStageCounts: { '原Client TXN': candidates.length } });
          if (candidates.length > 1) throw new Error('Original Admin TXN is not unique.');
          return candidates.length;
        }, { timeout: 30_000 }).toBe(1);
        const detailPage = new TransferDetailPage(adminPage); await detailPage.openFromList(list, record.txNo);
        const detail = await detailPage.readDetail();
        expect(detail.adminTransactionId).toBe(record.txNo); expect(detail.recordType).toBe('信托账户互转');
        expect(matchesAdminCustomerIdentity(detail.userIdentity, env.client.username!)).toBe(true);
        expect(detail.status).toBe('已批准');
        if (detail.fee === undefined || detail.receivedAmount === undefined) throw new Error('Labelled Admin fee/net required, not raw API actualAmount.');
        const actual: AccountTransferQuote = { sourceAccount: detail.sourceAccountType, targetAccount: detail.targetAccountType,
          currency: detail.currency, amount: detail.amount, fee: detail.fee, received: detail.receivedAmount };
        verifyTransferFeeQuote(actual, rule, { sourceAccount: '巴林账户', targetAccount: '香港账户', amount: plan.amount });
        e.adminStatus = detail.status; e.adminNet = detail.receivedAmount;
        await detailPage.close(); run.advance('CLIENT_FINALIZED');
        step.setActual(`原互转自动完成；同TXN的Admin实际到账${e.adminNet}，手续费${detail.fee}；未点击Admin审批。`);
      }
      e.verified = true; run.save(); report();
      step.recordPrimaryOracle({ id: 'original-transfer', name: '原交易费用生效与真实完成', expected: '唯一原订单、费用与实际到账正确且已批准', actual: '通过', status: 'passed' });
    });
  } catch (error) {
    failure = error;
    business.recordPrimaryOracle({ id: 'matrix-stage', name: '本笔手续费闭环', expected: '所有核心步骤通过',
      actual: maskSensitiveText(error instanceof Error ? error.message : String(error)), status: 'failed' });
    if ((run.attempted('security') && !e.order) || (run.attempted('approve') && e.adminStatus !== '已批准'))
      business.requireManualReview('最终动作已尝试但原订单结果未确认；仅查询原TRF/TXN，不重新提交或审批。');
  } finally {
    try {
      if (e.original && (run.attempted('apply') || e.applied)) {
        if (run.attempted('security') && !e.order) throw new Error('Restore deferred until uncertain original transfer is reconciled.');
        await business.step({ action: '6. 恢复本笔之前的完整费用配置', expected: '类型和值恢复；非本Run变更不覆盖；恢复保存至多一次' }, async step => {
          const current = await readConfiguration();
          if (!sameAccountTypeConfiguration(current, e.original!)) {
            expect(sameAccountTypeConfiguration(current, withTransferFeeRule(e.original!, rule)), 'Do not overwrite concurrent configuration edits').toBe(true);
            e.applied = true; run.save();
            await admin.fillTransferFeeRule(snapshotFeeRule(e.original!, plan.currency), current);
            try { await admin.saveFeeOnce('restore', e.original!, () => { validate(); run.attempt('restore'); business.markMutationPerformed('恢复本Run原费率一次'); }); }
            catch (error) { if (!run.attempted('restore')) throw error; diag('restore', '恢复已尝试一次，仅回读确认。'); }
            expect(sameAccountTypeConfiguration(await readConfiguration(), e.original!)).toBe(true);
          }
          await admin.cancelFeeEdit(); e.restored = true; run.save(); report();
          step.recordPrimaryOracle({ id: 'restore', name: '原完整费用配置恢复', expected: '原类型和值及其他字段不变', actual: '已回读确认', status: 'passed' });
          step.setActual('原完整配置已回读。不会恢复成历史旧值，也不会影响其他币种。');
        });
      }
    } catch (error) { failure ??= error; business.requireManualReview('原共享费率尚未确认恢复，先核查原Run，不继续后续交易。'); }
    report(); if (clean) await clean.context.close();
  }
  if (failure) throw failure;
  run.complete(); report();
});
