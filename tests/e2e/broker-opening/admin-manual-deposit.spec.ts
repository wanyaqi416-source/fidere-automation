import { test, expect } from '../../../fixtures/registration.fixture';
import { env } from '../../../src/config/env';
import { MoneyMutationGuard } from '../../../src/flow-engine';
import { FreshUserBalanceBootstrapStore } from '../../../src/journey/fresh-user-balance-bootstrap';
import { PersonalPostRegistrationJourneyStore } from '../../../src/journey';
import { openPersonalJourneyClientSession, maskRegistrationEmail } from '../../../src/registration';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { ManualFiatDepositPage } from '../../../pages/admin/ManualFiatDepositPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { RegistrationKycStatusPage } from '../../../pages/client/RegistrationKycStatusPage';
import { Decimal } from '../../../src/utils/money';
import { maskSensitiveText } from '../../../src/reporting/sensitive-data-mask';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });
test('ADMIN-MD-001 原Journey香港USD手动入金一次 @money @mutation @L4', async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(180_000);
  const sourceRunId = process.env.BROKER_SOURCE_RUN_ID;
  const runId = process.env.MANUAL_DEPOSIT_RUN_ID;
  const amount = process.env.MANUAL_DEPOSIT_AUTHORIZED_AMOUNT;
  const resumeConfirmation = process.env.MANUAL_DEPOSIT_RESUME_CONFIRMATION === 'true';
  if (!sourceRunId || !runId || !amount) throw new Error('Explicit source, named Run and authorized amount required.');
  const guard = new MoneyMutationGuard('admin-manual-fiat-deposit');
  const switches = { ALLOW_MONEY_TESTS: env.exchange.allowMoneyTests, ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests };
  for (const baseURL of [env.client.baseUrl, env.admin.baseUrl]) guard.validateRuntime({ baseURL, workers: testInfo.config.workers, retries: testInfo.project.retries, repeatEach: testInfo.project.repeatEach, safetySwitches: switches });
  expect(testInfo.retry + testInfo.repeatEachIndex).toBe(0);
  const source = new PersonalPostRegistrationJourneyStore(sourceRunId).load();
  if (!source || source.stage !== 'COMPLETED') throw new Error('Existing completed Journey required; creating users/deposits in Client is forbidden.');
  const store = new FreshUserBalanceBootstrapStore();
  let state = store.prepare({ journeyId: runId, userEmail: source.email, bootstrapAmount: amount });
  if (!resumeConfirmation && (state.stage !== 'PREPARED' || state.submissionClicks)) throw new Error('This manual deposit has already been attempted. Read-only reconciliation only, never resubmit.');
  if (resumeConfirmation && (state.finalConfirmationClicks || state.stage === 'BOOTSTRAP_COMPLETED' || state.depositTxn)) throw new Error('Final confirmation was already attempted; only read-only reconciliation is allowed.');
  business.flow('admin-manual-fiat-deposit');
  business.setBusinessData({ runId, sourceRunId, registrationTestName: source.displayName, maskedLogin: maskRegistrationEmail(source.email), accountType: '香港账户', currency: 'USD', requestedAmount: amount });
  const shell = new AdminShellPage(adminPage);
  await shell.goto(env.admin.baseUrl!);
  await shell.expectSessionActive();
  const manual = new ManualFiatDepositPage(adminPage);
  await manual.goto(env.admin.baseUrl!);
  const client = await openPersonalJourneyClientSession({ browser, baseURL: env.client.baseUrl!, runId: sourceRunId,
    email: source.email, password: env.client.password!, otp: env.client.otp!, forceFreshLogin: true });
  try {
    await new RegistrationKycStatusPage(client.page).expectApproved({ ...source, runId: sourceRunId }, env.client.baseUrl!);
    guard.markAuthenticationReady(true, true);
    const accounts = new AccountDetailPage(client.page);
    await accounts.goto(env.client.baseUrl!);
    const before = await accounts.readSnapshot('香港账户', 'USD');
    const existingRows = await manual.findRunLedger(env.admin.baseUrl!, runId);
    expect(existingRows).toHaveLength(0);
    if (resumeConfirmation && state.finalConfirmationClicks === undefined && state.stage === 'BOOTSTRAP_SUBMISSION_ATTEMPTED') {
      if (runId !== 'MD001-AH-20260908') throw new Error('Legacy confirmation-only evidence exists only for the named historical Run.');
      state = store.reconcileLegacyConfirmationOnly(state, { observedBalance: before.available, originalConfirmationDialogObserved: true, existingLedgerCount: existingRows.length });
      business.recordDiagnostic({ id: 'manual-deposit-confirmation-only', name: '首次按钮只打开二次确认框', status: 'info',
        summary: '原失败现场存在确认手动入金弹窗、最终确认未点击；只读余额未变且原Run流水0。保留原失败历史，不重复资金提交。', affectsCoreBusiness: false });
    }
    await business.step({ action: '1. 邮箱唯一选择原用户，填写香港账户USD手动入金', expected: '客户=原Journey；金额=本Run授权金额，备注标明Sandbox用途。' }, async step => {
      await manual.goto(env.admin.baseUrl!);
      await manual.openForm();
      await manual.fillForm({ email: source.email, displayName: source.displayName, amount, note: `AUTO_SANDBOX_BROKER_BOOTSTRAP_${runId}` });
      step.setActual(`邮箱唯一客户=${source.displayName}；香港USD；入金${amount}；原余额${before.available}；渠道Others（测试余额准备）。`);
      step.setBusinessData({ candidateCount: 1, beforeAvailableBalance: before.available });
    });
    await business.step({ action: '2. Admin确认入金一次', expected: '点击前持久化attempt；不走Client入金，不重试。' }, async step => {
      state = store.recordConfirmationOpened(state);
      await manual.openConfirmation({ displayName: source.displayName, amount, note: `AUTO_SANDBOX_BROKER_BOOTSTRAP_${runId}` });
      state = store.recordSubmissionAttempt(state, before.available);
      business.setResumeState(state.stage);
      step.disallowSafeRerun(); step.markPotentiallySubmitted();
      let evidence: Awaited<ReturnType<ManualFiatDepositPage['confirmOnce']>>;
      try { evidence = await manual.confirmOnce(); }
      finally { await testInfo.attach('manual-deposit-safe-network', { body: JSON.stringify(manual.safeNetworkEvidence()), contentType: 'application/json' }); }
      state = store.recordSubmitted(state, { depositTxn: evidence.businessReference });
      await testInfo.attach('manual-deposit-safe-network', { body: maskSensitiveText(JSON.stringify(evidence)), contentType: 'application/json' });
      business.markMutationPerformed('Admin手动入金');
      step.setActual('二次确认框中的最终确认入金1次，表单已关闭，继续验证实际余额。');
    });
    await business.step({ action: '3. Client香港USD余额核实入账', expected: 'after - before严格等于本次授权入金金额。' }, async step => {
      let after = before;
      await expect.poll(async () => {
        await accounts.goto(env.client.baseUrl!);
        after = await accounts.readSnapshot('香港账户', 'USD');
        return new Decimal(after.available).minus(before.available).equals(amount);
      }, { timeout: 45_000, intervals: [1000, 2000, 5000] }).toBe(true);
      state = store.recordCompleted(state, { depositTxn: state.depositTxn, balanceBefore: before.available, balanceAfter: after.available });
      business.setResumeState(state.stage);
      step.setBusinessData({ beforeAvailableBalance: before.available, afterApprovedAvailableBalance: after.available, confirmationClicks: state.submissionClicks, finalStatus: '手动入金已到账', confirmed: true });
      step.setActual(`${after.available} - ${before.available} = ${amount} USD；原用户香港账户入账已确认。`);
      step.recordPrimaryOracle({ id: 'manual-deposit-completed', name: '唯一原用户单次手动入金及余额到账', expected: '正确账户一次入金，实际增量与授权一致', actual: `确认1次；实际增量${amount} USD`, status: 'passed' });
      console.log('MANUAL_DEPOSIT_COMPLETED ' + JSON.stringify({ runId, before: before.available, after: after.available, amount, submissionClicks: 1 }));
    });
    try {
      const rows = await manual.findRunLedger(env.admin.baseUrl!, runId);
      business.recordDiagnostic({ id: 'manual-deposit-ledger', name: 'Admin按Run备注查询流水', status: rows.length === 1 ? 'available' : 'unavailable',
        summary: `候选${rows.length}条；原用户实际余额增量已确认，列表查询不影响资金入账结论。`, affectsCoreBusiness: false });
    } catch (error) {
      business.recordDiagnostic({ id: 'manual-deposit-ledger', name: 'Admin按Run备注查询流水', status: 'unavailable', summary: '实际入账已确认，辅助列表查询不可用。',
        reason: maskSensitiveText(error instanceof Error ? error.message : String(error)), affectsCoreBusiness: false });
    }
  } catch (error) {
    const persisted = store.load(runId);
    if (persisted?.submissionClicks && persisted.stage !== 'BOOTSTRAP_COMPLETED') business.requireManualReview('原用户手动入金记录及香港USD余额；禁止再次入金');
    throw error;
  } finally { await client.context.close(); }
});
