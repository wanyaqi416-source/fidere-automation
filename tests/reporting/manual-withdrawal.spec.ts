import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { AdminManualWithdrawalStore, assertManualWithdrawalAmount, assertManualWithdrawalFunds, decodeManualWithdrawalReceipt } from '../../src/withdrawal/admin-manual-withdrawal';
import { ManualFiatForm } from '../../pages/admin/ManualFiatForm';
import { ManualFiatDepositPage } from '../../pages/admin/ManualFiatDepositPage';
import { ManualFiatWithdrawalPage } from '../../pages/admin/ManualFiatWithdrawalPage';
import { MoneyMutationGuard } from '../../src/flow-engine';

const identity = { runId: 'MW-UNIT', sourceRunId: 'REG-UNIT', accountType: '香港账户', currency: 'USD', amount: '11.03' };

test('手动出金金额与资金余量使用Decimal，不使用全部余额', () => {
  for (const value of ['0', '-1', 'NaN', 'Infinity', '1e2', '1.001', '']) expect(() => assertManualWithdrawalAmount(value)).toThrow();
  expect(() => assertManualWithdrawalFunds('13.04', '11.03', '2.00')).not.toThrow();
  expect(() => assertManualWithdrawalFunds('13.03', '11.03', '2.00')).toThrow(/all funds/);
  expect(() => assertManualWithdrawalFunds('1', '11.03', '2.00')).toThrow(/insufficient/);
  expect(() => assertManualWithdrawalFunds('100', '11.03', '-2')).toThrow();
});

test('确认框不是扣款；持久化attempt后旧对象、重启、改金额均不可再次提交', ({}, testInfo) => {
  const root = testInfo.outputPath('manual-withdrawal');
  const store = new AdminManualWithdrawalStore(root);
  const prepared = store.prepare(identity);
  expect(prepared.finalConfirmationClicks).toBe(0);
  const ready = store.confirmationReady(identity.runId, '2', '100');
  expect(ready.stage).toBe('CONFIRMATION_READY');
  expect(ready.finalConfirmationClicks).toBe(0);
  expect(store.recordAttempt(identity.runId).finalConfirmationClicks).toBe(1);
  expect(() => store.recordAttempt(identity.runId)).toThrow(/already attempted/);
  expect(() => new AdminManualWithdrawalStore(root).prepare(identity)).toThrow(/read-only/);
  expect(() => store.prepare({ ...identity, amount: '11.04' })).toThrow(/mismatch/);
  expect(() => store.prepare({ ...identity, sourceRunId: 'ANOTHER-USER' })).toThrow(/mismatch/);
});

test('只有明确的业务响应和Admin成功状态才能完成；完成后禁止重跑', ({}, testInfo) => {
  const store = new AdminManualWithdrawalStore(testInfo.outputPath('manual-withdrawal'));
  store.prepare(identity);
  expect(() => store.recordAttempt(identity.runId)).toThrow(/confirmation/);
  store.confirmationReady(identity.runId, '2', '100');
  store.recordAttempt(identity.runId);
  expect(() => store.completed(identity.runId, { accepted: true, uiSuccess: false })).toThrow();
  expect(store.completed(identity.runId, { accepted: true, uiSuccess: true, reference: 'TXN-UNIT' }).stage).toBe('COMPLETED');
  expect(() => store.prepare(identity)).toThrow(/read-only/);
  expect(() => store.confirmationReady(identity.runId, '2', '100')).toThrow(/already attempted/);
});

test('HTTP200或未知响应不当作业务成功，业务引用按白名单提取', () => {
  for (const body of [null, {}, { status: 200 }, { code: 500 }, { code: 0, data: false }, { code: 200, success: false }]) {
    expect(decodeManualWithdrawalReceipt(body).accepted).toBe(false);
  }
  expect(decodeManualWithdrawalReceipt({ code: 0, data: { transactionId: 'TXN-UNIT', token: 'not-retained' } })).toEqual({ accepted: true, reference: 'TXN-UNIT' });
  expect(decodeManualWithdrawalReceipt({ code: 200, data: { transactionId: 'unconfirmed-format' } })).toEqual({ accepted: true, reference: undefined });
});

test('Resume只保存业务白名单，无密码/邮箱等身份正文', ({}, testInfo) => {
  const root = testInfo.outputPath('manual-withdrawal');
  const store = new AdminManualWithdrawalStore(root);
  store.prepare({ ...identity, password: 'not-stored', email: 'not-stored@example.test' } as typeof identity);
  const persisted = readFileSync(`${root}/${identity.runId}.json`, 'utf8');
  expect(persisted).not.toMatch(/not-stored|password|email|cookie|token/i);
  expect(() => store.load('../outside')).toThrow(/Invalid/);
});

test('Admin手动出金维持双开关和单worker零重试约束', () => {
  const guard = new MoneyMutationGuard('admin-manual-fiat-withdrawal');
  const runtime = { baseURL: 'https://admin.sandbox.test', workers: 1, retries: 0, repeatEach: 1,
    safetySwitches: { ALLOW_MONEY_TESTS: true, ALLOW_ADMIN_MUTATION_TESTS: true } };
  expect(() => guard.validateRuntime(runtime)).not.toThrow();
  for (const disabled of ['ALLOW_MONEY_TESTS', 'ALLOW_ADMIN_MUTATION_TESTS']) {
    expect(() => guard.validateRuntime({ ...runtime, safetySwitches: { ...runtime.safetySwitches, [disabled]: false } })).toThrow(/closed/);
  }
  for (const invalid of [{ workers: 2 }, { retries: 1 }, { repeatEach: 2 }, { baseURL: 'https://admin.fidere.com' }]) {
    expect(() => guard.validateRuntime({ ...runtime, ...invalid })).toThrow();
  }
});

test('共享客户选择器兼容手动入金，姓名不作为搜索词', async ({ page }) => {
  await page.setContent(`<label>选择客户<input role="combobox" aria-label="选择客户"></label>
    <div role="option" onclick="document.querySelector('input').value = this.textContent">TEST SANDBOX AH (sandbox@example.test)</div>
    <div><label>选择账户 *</label><button role="combobox" onclick="document.querySelector('#accounts').hidden = false">请选择</button></div>
    <div id="accounts" hidden><div role="option">香港账户</div></div>`);
  const deposit = new ManualFiatDepositPage(page);
  await deposit.chooseCustomer('sandbox@example.test');
  expect((await page.getByRole('combobox', { name: '选择客户' }).inputValue()).includes('sandbox@example.test')).toBe(true);
  await deposit.openAccountOptions();
  await expect(page.getByRole('option', { name: '香港账户', exact: true })).toBeVisible();
});

test('客户精确邮箱验证拒绝子串近似邮箱', async ({ page }) => {
  await page.setContent(`<input role="combobox" aria-label="选择客户"><div role="option">TEST (other-sandbox@example.test)</div>`);
  await expect(new ManualFiatForm(page).chooseCustomer('sandbox@example.test')).rejects.toThrow();
});

test('未授权不能触发最终确认，API监听限定同源手动出金', async ({ page }) => {
  await page.route('https://admin.sandbox.test/**', route => route.fulfill({ body: '<html>local fixture</html>', contentType: 'text/html' }));
  await page.goto('https://admin.sandbox.test/zh-CN/operation/fiatAssets');
  const manual = new ManualFiatWithdrawalPage(page);
  let recorded = false;
  await expect(manual.confirmOnce(() => { recorded = true; })).rejects.toThrow();
  expect(recorded).toBe(false);
  expect(manual.counts()).toEqual({ confirmationOpenClicks: 0, finalConfirmationClicks: 0 });
});
