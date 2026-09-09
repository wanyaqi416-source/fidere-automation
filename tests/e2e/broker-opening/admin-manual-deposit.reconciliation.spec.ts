import { test, expect } from '../../../fixtures/registration.fixture';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment } from '../../../src/flow-engine';
import { FreshUserBalanceBootstrapStore } from '../../../src/journey/fresh-user-balance-bootstrap';
import { PersonalPostRegistrationJourneyStore } from '../../../src/journey';
import { openPersonalJourneyClientSession } from '../../../src/registration';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { ManualFiatDepositPage } from '../../../pages/admin/ManualFiatDepositPage';
import { Decimal } from '../../../src/utils/money';
import { maskSensitiveText } from '../../../src/reporting/sensitive-data-mask';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });
test('原MD001仅只读核对余额与Admin流水 @readonly @L2', async ({ browser, adminPage, business }) => {
  test.setTimeout(120_000);
  expect(env.exchange.allowMoneyTests || env.allowAdminMutationTests).toBe(false);
  assertSandboxEnvironment(env.client.baseUrl); assertSandboxEnvironment(env.admin.baseUrl);
  const sourceId = process.env.BROKER_SOURCE_RUN_ID;
  const runId = process.env.MANUAL_DEPOSIT_RUN_ID;
  if (!sourceId || !runId) throw new Error('Existing source and Run required.');
  const source = new PersonalPostRegistrationJourneyStore(sourceId).load();
  const store = new FreshUserBalanceBootstrapStore();
  const state = store.load(runId);
  if (!source || !state || source.email !== state.userEmail) throw new Error('Original Run identity required.');
  business.flow('admin-manual-fiat-deposit', { caseId: 'ADMIN-MD-RECON', name: '原手动入金只读核对', type: ['Read-only'], level: 'L2', changesData: false, affectsMoney: false, safetySwitches: [] });
  business.setBusinessData({ runId, sourceRunId: sourceId, registrationTestName: source.displayName, accountType: state.accountType, currency: state.currency, requestedAmount: state.bootstrapAmount });
  const client = await openPersonalJourneyClientSession({ browser, baseURL: env.client.baseUrl!, runId: sourceId, email: source.email, password: env.client.password!, otp: env.client.otp!, forceFreshLogin: true });
  try {
    await business.step({ action: '只读核对原用户香港USD余额', expected: '不执行第二次入金；记录现场余额。' }, async step => {
      const accounts = new AccountDetailPage(client.page);
      await accounts.goto(env.client.baseUrl!);
      const balance = await accounts.readSnapshot('香港账户', 'USD');
      console.log('MANUAL_DEPOSIT_READONLY_BALANCE ' + JSON.stringify({ runId, originalBefore: state.balanceBefore, ...balance }));
      step.setActual(`原余额${state.balanceBefore}；当前可用${balance.available}；冻结${balance.frozen}；总余额${balance.total}。`);
      if (['BOOTSTRAP_SUBMITTED', 'BOOTSTRAP_COMPLETED'].includes(state.stage)) {
        expect(state.finalConfirmationClicks).toBe(1);
        expect(new Decimal(balance.available).minus(state.balanceBefore!).equals(state.bootstrapAmount)).toBe(true);
        const completed = store.recordCompleted(state, { balanceBefore: state.balanceBefore!, balanceAfter: balance.available, depositTxn: state.depositTxn });
        business.setResumeState(completed.stage);
        business.disallowSafeRerun();
        business.setBusinessData({ beforeAvailableBalance: state.balanceBefore, afterApprovedAvailableBalance: balance.available, confirmationClicks: 1, finalStatus: '手动入金已到账', confirmed: true, manualCheckRequired: false });
        step.recordPrimaryOracle({ id: 'manual-deposit-completed', name: '原用户单次手动入金与实际到账', expected: '已记录一次最终确认，香港USD实际增加授权金额',
          actual: `${balance.available} - ${state.balanceBefore} = ${state.bootstrapAmount} USD；最终确认1次；本次只读查询。`, status: 'passed' });
      }
    });
    const shell = new AdminShellPage(adminPage);
    await shell.goto(env.admin.baseUrl!); await shell.expectSessionActive();
    try {
      const rows = await new ManualFiatDepositPage(adminPage).findRunLedger(env.admin.baseUrl!, runId);
      console.log('MANUAL_DEPOSIT_RUN_LEDGER_COUNT ' + rows.length);
      business.recordDiagnostic({ id: 'manual-deposit-ledger', name: 'Admin按Run备注查询流水', status: rows.length === 1 ? 'available' : 'unavailable',
        summary: `候选${rows.length}条。列表仅为辅助诊断；入账由原Run单次最终确认及香港USD余额实际增量核实。`, affectsCoreBusiness: false });
    } catch (error) {
      business.recordDiagnostic({ id: 'manual-deposit-ledger', name: 'Admin按Run备注查询流水', status: 'unavailable', summary: '辅助查询不可用，不影响已确认入账结果。',
        reason: maskSensitiveText(error instanceof Error ? error.message : String(error)), affectsCoreBusiness: false });
    }
  } finally { await client.context.close(); }
});
