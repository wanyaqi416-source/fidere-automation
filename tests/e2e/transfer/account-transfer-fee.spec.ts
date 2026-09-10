import { test, expect } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment, MoneyMutationGuard } from '../../../src/flow-engine';
import { AccountTypeConfigurationPage } from '../../../pages/admin/AccountTypeConfigurationPage';
import { AccountInternalTransferPage } from '../../../pages/client/AccountInternalTransferPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { RegistrationKycStatusPage } from '../../../pages/client/RegistrationKycStatusPage';
import { AccountTransferFeeRun, type InternalTransferRecord } from '../../../src/transfer/account-transfer-fee-run';
import { fixedUsdFee, INTERNAL_ACCOUNT_REGIONS, matchFeeRunTransfers, sameAccountTypeConfiguration,
  verifyFixedTransferQuote, withUsdTransferFee, snapshotUsdFeeRule } from '../../../src/transfer/account-transfer-fee';
import { Decimal } from '../../../src/utils/money';
import { maskSensitiveText } from '../../../src/reporting/sensitive-data-mask';
import { readVerifiedAccountTransferSettlement } from '../../../src/transfer/account-transfer-fee-verification';

test.describe.configure({ mode: 'serial', retries: 0 });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('ATF-002 巴林USD固定互转手续费修改生效与原配置恢复 @mutation @money @L4', async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(420_000);
  business.flow('account-transfer-fee');
  const runId = process.env.ACCOUNT_TRANSFER_FEE_RUN_ID;
  const feeInput = process.env.ACCOUNT_TRANSFER_FIXED_FEE, amountInput = process.env.ACCOUNT_TRANSFER_AMOUNT;
  const target = process.env.ACCOUNT_TRANSFER_TARGET ?? '香港账户';
  if (!runId || !feeInput || !amountInput || !INTERNAL_ACCOUNT_REGIONS[target] ||
    process.env.ACCOUNT_TRANSFER_RESTORE_ORIGINAL !== 'true' || !env.client.username || !env.client.password || !env.client.otp || !env.client.securityKey) {
    throw new Error('BLOCKED_AUTHORIZATION: named Run, exact fixed fee/amount, default Client credentials and explicit restore-original authorization are required.');
  }
  const fixedFee = fixedUsdFee(feeInput), amount = fixedUsdFee(amountInput).amount;
  if (!new Decimal(amount).gt(fixedFee.amount)) throw new Error('Authorized transfer amount must exceed its fixed fee.');
  const switches = { ALLOW_MONEY_TESTS: env.exchange.allowMoneyTests, ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests };
  const guard = new MoneyMutationGuard('account-transfer-fee', true, true);
  const validate = () => {
    assertSandboxEnvironment(env.admin.baseUrl);
    guard.validateRuntime({ baseURL: env.client.baseUrl, workers: testInfo.config.workers,
      retries: testInfo.project.retries, repeatEach: testInfo.project.repeatEach, safetySwitches: switches });
    expect(testInfo.retry + testInfo.repeatEachIndex).toBe(0);
  };
  validate();
  const run = new AccountTransferFeeRun({ runId, email: env.client.username, fixedFee: fixedFee.amount, amount, targetAccount: target },
    process.env.ACCOUNT_TRANSFER_FEE_RESUME === 'true');
  const e = run.evidence, admin = new AccountTypeConfigurationPage(adminPage);
  let clean: Awaited<ReturnType<typeof RegistrationKycStatusPage.cleanLogin>> | undefined;
  let failure: unknown, corePassed = false, primaryId = 'ATF-PREFLIGHT';
  const report = () => {
    business.setResumeState(e.stage);
    business.setBusinessData({ sourceRunId: runId, senderIdentity: maskSensitiveText(env.client.username!),
      sourceAccountType: '巴林账户', targetAccountType: target, fromCurrency: 'USD', transferAmount: amount,
      transferFeeType: '固定金额', originalTransferFee: e.original?.currencies.USD.fee, configuredTransferFee: fixedFee.amount,
      configurationSaveClicks: Number(run.attempted('apply')), configurationRestoreClicks: Number(run.attempted('restore')),
      configurationRestored: e.restored, finalSubmissionClicks: Number(run.attempted('confirm')),
      securityVerificationClicks: Number(run.attempted('security')), clientTransferId: e.order?.orderNo,
      clientTransactionId: e.order?.txNo, feeAmount: e.order?.fee ?? fixedFee.amount, receivedAmount: e.settlement?.received,
      rawApiActualAmount: e.order?.actualAmount, receivedAmountSource: e.settlement?.receivedSource,
      clientFinalStatus: e.order?.status, accountTransferFeeEvidence: JSON.stringify({ quotes: e.quotes, order: e.order, settlement: e.settlement }), safeToRerun: false });
  };
  const passed = (name: string) => business.recordPrimaryOracle({ id: primaryId, name, expected: name, actual: '通过', status: 'passed' });
  const readConfiguration = async () => {
    await admin.goto(env.admin.baseUrl!); await admin.openBahrainEditor();
    return admin.readFeeConfiguration();
  };
  try {
    await business.step({ action: '1. 双端认证，保存原配置和默认账户状态', expected: '唯一巴林账户配置、默认Client身份/KYC、原USD余额和完整旧订单基线' }, async step => {
      const current = await readConfiguration();
      withUsdTransferFee(current, fixedFee.amount);
      await admin.cancelFeeEdit();
      clean = await RegistrationKycStatusPage.cleanLogin({ browser, baseURL: env.client.baseUrl!, email: env.client.username!,
        password: env.client.password!, otp: env.client.otp! });
      const client = new AccountInternalTransferPage(clean.statusPage.page);
      await client.verifyIdentity(env.client.baseUrl!, env.client.username!);
      guard.markAuthenticationReady(true, true);
      if (!e.original) { e.original = current; run.save(); }
      if (!run.attempted('apply')) {
        expect(sameAccountTypeConfiguration(current, e.original), 'Original configuration has not drifted').toBe(true);
        expect(snapshotUsdFeeRule(current).type === 'fixed' && new Decimal(current.currencies.USD.fee).eq(fixedFee.amount), 'Test fee must differ from the original to prove propagation').toBe(false);
        const accounts = new AccountDetailPage(clean.statusPage.page); await accounts.goto(env.client.baseUrl!);
        const before = await accounts.readSnapshot('巴林账户', 'USD');
        expect(new Decimal(before.available).gt(new Decimal(amount).plus('0.17')), 'Existing funds must cover the transfer and both previews').toBe(true);
        const records = await client.readRecords(env.client.baseUrl!);
        expect(records.filter(row => row.transferType === 'internal' && row.fromRegion === 'BH' &&
          row.toRegion === INTERNAL_ACCOUNT_REGIONS[target] && row.currency === 'USD' && new Decimal(row.amount).eq(amount)), 'Use an amount not already used for this direction').toHaveLength(0);
        e.originalOrderIds = records.map(row => row.orderNo); run.save();
        await client.goto(env.client.baseUrl!); await client.selectAccounts('巴林账户', target);
        step.setBusinessData({ beforeAvailableBalance: before.available, beforeTotalBalance: before.total });
      }
      report(); passed('双端认证、唯一配置和原测试上下文一致'); step.setActual('不注册、不造余额；未更改Client默认身份。');
    });
    const client = new AccountInternalTransferPage(clean!.statusPage.page);
    primaryId = 'ATF-CONFIG';
    await business.step({ action: '2. 单次保存巴林USD固定费并回读', expected: '仅USD固定费改变，其他币种、开通费用、支持状态和基础资料不变' }, async step => {
      if (!e.restored) {
        const expected = withUsdTransferFee(e.original!, fixedFee.amount);
        if (!run.attempted('apply')) {
          const current = await readConfiguration();
          expect(sameAccountTypeConfiguration(current, e.original!)).toBe(true);
          await admin.fillUsdTransferFee(fixedFee.amount, current);
          try { await admin.saveFeeOnce('apply', expected, () => { validate(); run.attempt('apply'); business.markMutationPerformed('保存巴林USD测试固定费一次'); report(); }); }
          catch (error) { if (!run.attempted('apply')) throw error; }
        }
        const persisted = await readConfiguration();
        expect(sameAccountTypeConfiguration(persisted, expected), 'CONFIG_SAVE_UNCONFIRMED: only read back after an attempted save, never click again').toBe(true);
        await admin.cancelFeeEdit(); e.applied = true; e.stage = 'CONFIG_UPDATED'; run.save();
      } else if (!e.order) throw new Error('Original fee already restored without a confirmed order; do not apply again or create a replacement.');
      report(); passed('配置已保存且只有巴林USD固定费变化'); step.setActual(`固定费用${fixedFee.amount} USD已回读确认；非百分比费用。`);
    });
    primaryId = 'ATF-QUOTE';
    if (!run.attempted('confirm')) {
      await business.step({ action: '3. Client重新加载新费，试算两种金额', expected: '两个金额手续费恒定；原金额、币种、方向和金额减手续费后的净额准确' }, async step => {
        e.quotes = [];
        await client.goto(env.client.baseUrl!); await client.selectAccounts('巴林账户', target);
        for (const value of [new Decimal(amount).plus('0.17').toFixed(2), amount]) {
          await client.preview(value);
          await expect.poll(async () => {
            const quote = await client.readQuote();
            return new Decimal(quote.fee).eq(fixedFee.amount) && new Decimal(quote.received).eq(new Decimal(value).minus(fixedFee.amount));
          }, { timeout: 30_000, intervals: [500, 1000, 2000] }).toBe(true);
          const quote = await client.readQuote(); verifyFixedTransferQuote(quote, fixedFee, { sourceAccount: '巴林账户', targetAccount: target, amount: value });
          e.quotes.push(quote);
        }
        await client.fillRunNote(runId); e.stage = 'CLIENT_REVIEW_READY'; run.save(); report();
        passed('固定费恒定与两种金额净额精确正确'); step.setActual('试算已通过，只会提交授权金额的一条互转。');
      });
    } else {
      if (!e.quotes || e.quotes.length !== 2) throw new Error('Original two-amount preview evidence missing; no re-submission.');
      for (const quote of e.quotes) verifyFixedTransferQuote(quote, fixedFee, { sourceAccount: '巴林账户', targetAccount: target, amount: quote.amount });
      passed('原Run两种金额试算证据保留');
    }
    primaryId = 'ATF-CREATED';
    await business.step({ action: '4. 互转确认与安全验证各一次，读取原TRF', expected: '创建证据来自完整历史记录，而非Toast或HTTP200；未知结果不再次提交' }, async step => {
      if (!run.attempted('confirm')) {
        // Configuration is shared: recheck immediately before the money boundary.
        expect(sameAccountTypeConfiguration(await readConfiguration(), withUsdTransferFee(e.original!, fixedFee.amount))).toBe(true);
        await admin.cancelFeeEdit();
        verifyFixedTransferQuote(await client.readQuote(), fixedFee, { sourceAccount: '巴林账户', targetAccount: target, amount });
        guard.assertClientMoneyConfirmationAllowed(switches);
        await client.confirmOnce(() => { validate(); run.attempt('confirm'); guard.recordClientMoneyConfirmation(); business.disallowSafeRerun(); report(); });
        await client.security.fill(env.client.securityKey!);
        guard.assertSecurityKeyVerificationAllowed(switches);
        run.attempt('security'); guard.recordSecurityKeyVerification(); business.markPotentiallySubmitted(); report();
        try { await client.security.verifyOnce(); }
        catch { business.recordDiagnostic({ id: 'ATF-SECURITY-UI', name: '安全验证后UI观测', status: 'unavailable', summary: '已尝试验证一次，仅查询原互转记录。', affectsCoreBusiness: false }); }
      }
      if (!run.attempted('security')) throw new Error('Confirmation was attempted without security verification; Resume cannot repeat it automatically.');
      let matches: InternalTransferRecord[] = [];
      await expect.poll(async () => {
        matches = matchFeeRunTransfers(await client.readRecords(env.client.baseUrl!), e, runId);
        if (matches.length > 1) throw new Error('Multiple matching internal transfers; no replacement or Admin operation.');
        return matches.length;
      }, { timeout: 75_000, intervals: [1000, 3000], message: 'ACCOUNT_TRANSFER_SUBMISSION_UNCONFIRMED' }).toBe(1);
      run.created(matches[0]); report(); passed('本次唯一真实TRF存在，未重复提交');
      step.setBusinessData({ candidateCount: 1 }); step.setActual('原TRF已保存；后续只查询同一笔互转。');
    });
    primaryId = 'ATF-COMPLETED';
    await business.step({ action: '5. 核对原互转的最终金额与完成状态', expected: '原TRF、内部互转类型、巴林到目标USD、金额、固定费和实际到账与确认页一致' }, async step => {
      await expect.poll(async () => {
        const matches = matchFeeRunTransfers(await client.readRecords(env.client.baseUrl!), e, runId);
        expect(matches).toHaveLength(1); run.created(matches[0]); report();
        return matches[0].status;
      }, { timeout: 60_000, intervals: [1000, 3000], message: 'Do not auto-approve a pending internal transfer; only query the original order.' }).toBe('approved');
      e.settlement = await readVerifiedAccountTransferSettlement({ page: adminPage, baseURL: env.admin.baseUrl!,
        email: env.client.username!, evidence: e, record: e.order!, business });
      run.save(); report();
      corePassed = true; passed('原互转完成且金额、费用和到账金额正确'); step.setActual('只读核对原TXN的Admin实际到账标签，与Client原确认页一致；未执行审批。');
    });
  } catch (error) {
    failure = error;
    business.recordPrimaryOracle({ id: primaryId, name: '固定费互转当前阶段', expected: '证据完整且数值正确',
      actual: maskSensitiveText(error instanceof Error ? error.message : String(error)), status: 'failed' });
    if (run.attempted('security') && !e.order) business.requireManualReview('只读查询本次原TRF；禁止再次验证、转账或修改未确认请求所用费用。');
  } finally {
    if (run.attempted('apply') && !e.restored) {
      try {
        if (run.attempted('security') && !e.order) throw new Error('CONFIG_RESTORE_DEFERRED: resolve uncertain original transfer before changing fees again.');
        await business.step({ action: '6. 恢复原巴林USD固定费', expected: '当前配置仍属于本Run，才允许一次恢复；发生外部改动不覆盖' }, async step => {
          const current = await readConfiguration(), original = e.original!;
          if (!sameAccountTypeConfiguration(current, original)) {
            const expected = withUsdTransferFee(original, fixedFee.amount);
            expect(sameAccountTypeConfiguration(current, expected), 'CONFIGURATION_CONFLICT: do not overwrite another operator').toBe(true);
            e.applied = true; run.save();
            if (!run.attempted('restore')) {
              await admin.fillUsdTransferFeeRule(snapshotUsdFeeRule(original), current);
              try { await admin.saveFeeOnce('restore', original, () => { validate(); run.attempt('restore'); business.markMutationPerformed('恢复原巴林USD固定费一次'); report(); }); }
              catch (error) { if (!run.attempted('restore')) throw error; }
            } else await admin.cancelFeeEdit();
            expect(sameAccountTypeConfiguration(await readConfiguration(), original), 'Original config restoration unconfirmed; never save a second time').toBe(true);
          }
          await admin.cancelFeeEdit(); e.restored = true; e.stage = 'CONFIG_RESTORED'; run.save(); report();
          business.recordPrimaryOracle({ id: 'ATF-RESTORED', name: '原账户类型配置已恢复', expected: '仅一次恢复或已为原值，其他字段不变', actual: '通过', status: 'passed' });
          step.setActual(`原固定费${original.currencies.USD.fee} USD已回读，不重试配置保存。`);
        });
      } catch (error) {
        failure ??= error;
        business.requireManualReview('共享手续费未确认恢复；保留原Run，不覆盖其他人员设置，不执行新的互转。');
        business.recordPrimaryOracle({ id: 'ATF-RESTORED', name: '原配置恢复', expected: '恢复并回读成功',
          actual: maskSensitiveText(error instanceof Error ? error.message : String(error)), status: 'failed' });
      }
    }
    report(); if (clean) await clean.context.close();
  }
  if (failure) throw failure;
  if (corePassed && e.restored) { run.complete(); report(); }
});
