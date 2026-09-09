import { expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { AdminShellPage } from '../../pages/admin/AdminShellPage';
import { ManualFiatWithdrawalPage } from '../../pages/admin/ManualFiatWithdrawalPage';
import { AccountDetailPage } from '../../pages/client/AccountDetailPage';
import { RegistrationKycStatusPage } from '../../pages/client/RegistrationKycStatusPage';
import { env } from '../config/env';
import { assertSandboxEnvironment, MoneyMutationGuard } from '../flow-engine';
import { PersonalPostRegistrationJourneyStore } from '../journey';
import { openPersonalJourneyClientSession, maskRegistrationEmail } from '../registration';
import type { BusinessReportApi } from '../reporting/business-report.types';
import { maskSensitiveText } from '../reporting/sensitive-data-mask';
import { Decimal } from '../utils/money';
import { AdminManualWithdrawalStore, assertManualWithdrawalFunds, MANUAL_WITHDRAWAL_FLOW_ID } from './admin-manual-withdrawal';

export async function runAdminManualWithdrawal(input: {
  browser: Browser; adminPage: Page; business: BusinessReportApi; testInfo: TestInfo; dryRun: boolean;
}): Promise<void> {
  const { browser, adminPage, business, testInfo, dryRun } = input;
  const sourceRunId = process.env.MANUAL_WITHDRAWAL_SOURCE_RUN_ID;
  const runId = dryRun ? `MW-DRY-${Date.now()}` : process.env.MANUAL_WITHDRAWAL_RUN_ID;
  const amount = dryRun ? process.env.MANUAL_WITHDRAWAL_DRY_RUN_AMOUNT || '11.03' : process.env.MANUAL_WITHDRAWAL_AUTHORIZED_AMOUNT;
  const authorizedFee = process.env.MANUAL_WITHDRAWAL_AUTHORIZED_FEE;
  const channel = process.env.MANUAL_WITHDRAWAL_CHANNEL || 'SWIFT';
  if (!sourceRunId || !runId || !amount) throw new Error('Existing source Journey, named Run and authorized amount are required.');
  if (!dryRun && (!authorizedFee || !new Decimal(authorizedFee).isFinite() || new Decimal(authorizedFee).isNegative())) {
    throw new Error('The explicitly authorized manual withdrawal fee is required.');
  }
  const guard = new MoneyMutationGuard(MANUAL_WITHDRAWAL_FLOW_ID);
  const switches = { ALLOW_MONEY_TESTS: env.exchange.allowMoneyTests, ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests };
  for (const baseURL of [env.client.baseUrl, env.admin.baseUrl]) {
    assertSandboxEnvironment(baseURL);
    if (!dryRun) guard.validateRuntime({ baseURL, workers: testInfo.config.workers, retries: testInfo.project.retries,
      repeatEach: testInfo.project.repeatEach, safetySwitches: switches });
  }
  expect(testInfo.retry + testInfo.repeatEachIndex).toBe(0);
  if (dryRun) expect(switches.ALLOW_MONEY_TESTS || switches.ALLOW_ADMIN_MUTATION_TESTS || env.allowClientMutationTests).toBe(false);
  const source = new PersonalPostRegistrationJourneyStore(sourceRunId).load();
  if (!source || source.stage !== 'COMPLETED' || !source.fiatAddressAccountSuffix) {
    throw new Error('Existing completed, funded Journey and bank required; never create a user, bank or deposit here.');
  }
  const store = new AdminManualWithdrawalStore();
  if (!dryRun) store.prepare({ runId, sourceRunId, accountType: '香港账户', currency: 'USD', amount });
  business.flow(dryRun ? 'admin-manual-fiat-withdrawal-dry-run' : MANUAL_WITHDRAWAL_FLOW_ID);
  business.setBusinessData({ runId, sourceRunId, registrationTestName: source.displayName,
    registrationLoginIdentity: maskRegistrationEmail(source.email), accountType: '香港账户', withdrawalCurrency: 'USD',
    requestedAmount: amount, selectedPaymentChannel: channel, beneficiaryAccountSuffix: `****${source.fiatAddressAccountSuffix}`, dryRun });
  const manual = new ManualFiatWithdrawalPage(adminPage);
  let requestCount = 0;
  const observe = (request: import('@playwright/test').Request) => { if (manual.isSubmissionRequest(request)) requestCount++; };
  adminPage.on('request', observe);
  if (dryRun) await adminPage.route('**/operation/fiat/manual-withdraw', route => route.abort('blockedbyclient'));
  let client: Awaited<ReturnType<typeof openPersonalJourneyClientSession>> | undefined;
  try {
    await business.step({ action: '1. Admin认证及原Journey用户预检', expected: '认证有效，仅复用原用户；不创建Client出金申请。' }, async step => {
      const shell = new AdminShellPage(adminPage);
      await shell.goto(env.admin.baseUrl!);
      await shell.expectSessionActive();
      client = await openPersonalJourneyClientSession({ browser, baseURL: env.client.baseUrl!, runId: sourceRunId,
        email: source.email, password: env.client.password!, otp: env.client.otp!, forceFreshLogin: true });
      await new RegistrationKycStatusPage(client.page).expectApproved({ ...source, runId: sourceRunId }, env.client.baseUrl!);
      guard.markAuthenticationReady(true, true);
      step.setActual('Admin认证有效；原用户Client干净登录及KYC正常；Client只读。');
    });
    const accounts = new AccountDetailPage(client!.page);
    await accounts.goto(env.client.baseUrl!);
    const before = await accounts.readSnapshot('香港账户', 'USD');
    let fee = '';
    await business.step({ action: '2. 邮箱唯一选择客户，填写普通手动出金', expected: '香港USD、原银行账户唯一、金额和备注正确；读取实时手续费并检查可用余额。' }, async step => {
      await manual.goto(env.admin.baseUrl!);
      await manual.openForm();
      const summary = await manual.fillForm({ email: source.email, displayName: source.displayName, accountType: '香港账户', currency: 'USD',
        bankAccountSuffix: source.fiatAddressAccountSuffix!, amount, channel, note: `AUTO_SANDBOX_MANUAL_WITHDRAWAL_${runId}` });
      fee = summary.fee;
      if (!dryRun && !new Decimal(fee).equals(authorizedFee!)) throw new Error('Displayed fee differs from the authorized fee; no withdrawal is allowed.');
      assertManualWithdrawalFunds(before.available, amount, fee);
      step.setBusinessData({ candidateCount: summary.bankCandidateCount, feeAmount: fee,
        candidateStageCounts: [{ field: '原用户邮箱', count: 1 }, { field: '香港账户', count: 1 },
          { field: '银行尾号与持有人', count: summary.bankCandidateCount }],
        beforeAvailableBalance: before.available, beforeTotalBalance: before.total, frozenAmount: before.frozen });
      step.setActual(`普通出金${amount} USD；页面手续费${fee} USD；可用余额${before.available} USD；客户、账户及银行候选各1。`);
    });
    await business.step({ action: '3. 打开并核对二次确认框', expected: '确认客户、普通出金、金额、银行与Run备注；打开弹窗不算出金。' }, async step => {
      await manual.openConfirmation();
      await testInfo.attach('manual-withdrawal-confirmation', { body: await manual.readSafeConfirmation(), contentType: 'text/plain' });
      expect(requestCount).toBe(0);
      if (!dryRun) store.confirmationReady(runId, fee, before.available);
      business.setResumeState('CONFIRMATION_READY');
      step.setBusinessData({ confirmationClicks: manual.counts().confirmationOpenClicks, finalSubmissionClicks: 0 });
      step.setActual('确认手动出金弹窗匹配；最终确认手动出金按钮可用；资金请求0次。');
    });
    if (dryRun) {
      await business.step({ action: '4. 最终扣款前停止', expected: '取消确认框，手动出金请求及最终点击均为0，不改变余额。' }, async step => {
        await manual.cancelConfirmation();
        expect(requestCount).toBe(0);
        expect(manual.counts().finalConfirmationClicks).toBe(0);
        await accounts.goto(env.client.baseUrl!);
        const after = await accounts.readSnapshot('香港账户', 'USD');
        expect(new Decimal(after.available).equals(before.available)).toBe(true);
        expect(new Decimal(after.total).equals(before.total)).toBe(true);
        step.setBusinessData({ finalSubmissionClicks: 0, mutationPerformed: false, finalStatus: 'Dry Run通过，未出金',
          afterApprovedAvailableBalance: after.available, confirmed: true });
        step.recordPrimaryOracle({ id: 'manual-withdrawal-dry-run', name: '真实表单及二次确认可用且零出金',
          expected: '数据匹配、可用余额充足、最终提交0次', actual: '全部匹配；资金请求0；余额未变', status: 'passed' });
        step.setActual(`Dry Run通过；可用余额${before.available} -> ${after.available} USD；最终扣款0次。`);
      });
      return;
    }
    await business.step({ action: '4. Admin最终确认手动出金一次', expected: '先持久化attempt，再单次确认；业务响应和Admin成功状态均明确，不进入Client申请/审批流程。' }, async step => {
      // Re-read immediately before the final action; do not rely on a stale preflight balance.
      await accounts.goto(env.client.baseUrl!);
      const current = await accounts.readSnapshot('香港账户', 'USD');
      const currentFee = await manual.readFee('USD');
      if (!new Decimal(currentFee).equals(authorizedFee!)) throw new Error('Fee changed before final confirmation; no withdrawal is allowed.');
      assertManualWithdrawalFunds(current.available, amount, fee);
      store.confirmationReady(runId, fee, current.available);
      const receipt = await manual.confirmOnce(() => {
        store.recordAttempt(runId);
        business.setResumeState('SUBMISSION_ATTEMPTED');
        step.disallowSafeRerun();
        step.markPotentiallySubmitted();
      });
      expect(requestCount).toBe(1);
      store.completed(runId, { ...receipt, uiSuccess: true });
      business.markMutationPerformed('Admin普通手动出金');
      business.setResumeState('COMPLETED');
      step.setBusinessData({ finalSubmissionClicks: manual.counts().finalConfirmationClicks, adminReference: receipt.reference,
        safeRequestEvidence: manual.safeNetworkEvidence(), finalStatus: 'Admin手动出金提交成功', confirmed: true });
      step.recordPrimaryOracle({ id: 'manual-withdrawal-admin-submitted', name: '原用户单次Admin手动出金成功', expected: '业务成功响应且Admin显示手动出金成功',
        actual: '最终确认1次；业务成功响应和Admin成功提示均已验证', status: 'passed' });
      step.setActual('Admin手动出金单次提交成功；未创建Client出金申请，未执行额外审批。');
    });
    try {
      await accounts.goto(env.client.baseUrl!);
      const after = await accounts.readSnapshot('香港账户', 'USD');
      const persisted = store.load(runId)!;
      store.recordBalanceObservation(runId, after.available);
      business.setBusinessData({ afterApprovedAvailableBalance: after.available, afterApprovedTotalBalance: after.total,
        actualDebitAmount: new Decimal(persisted.balanceBefore!).minus(after.available).toString() });
      business.recordDiagnostic({ id: 'manual-withdrawal-balance-observation', name: 'Client余额观测', status: 'available', affectsCoreBusiness: false,
        summary: `可用余额${persisted.balanceBefore} -> ${after.available} USD；页面手续费${fee}。扣费公式未由本次前置只读证据确认，不套用Client出金公式。` });
    } catch (error) {
      business.recordDiagnostic({ id: 'manual-withdrawal-balance-observation', name: 'Client余额观测', status: 'unavailable', affectsCoreBusiness: false,
        summary: 'Admin业务提交已成功，辅助余额暂不可读。', reason: maskSensitiveText(error instanceof Error ? error.message : String(error)) });
    }
  } catch (error) {
    if (!dryRun && store.load(runId)?.stage === 'SUBMISSION_ATTEMPTED') {
      business.requireManualReview('MANUAL_WITHDRAWAL_SUBMISSION_UNCONFIRMED：只读核查同一Run，不得重复手动出金。');
    }
    throw error;
  } finally {
    adminPage.off('request', observe);
    if (dryRun) await adminPage.unroute('**/operation/fiat/manual-withdraw');
    await testInfo.attach('manual-withdrawal-safe-network', { body: JSON.stringify(manual.safeNetworkEvidence()), contentType: 'application/json' });
    await client?.context.close();
  }
}
