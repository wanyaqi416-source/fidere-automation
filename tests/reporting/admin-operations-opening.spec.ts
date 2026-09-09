import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { OperationsCustomersPage } from '../../pages/admin/OperationsCustomersPage';
import {
  COUNTRY_LABELS, parseOperationsCustomer, matchOperationsCustomers, OperationsOpeningRun,
  validateOperationsOpeningForm, operationsOpeningFeeInput, type OperationsOpeningIdentity
} from '../../src/account-opening/admin-operations-opening';
import { MoneyMutationGuard, requireExactlyOneCandidate } from '../../src/flow-engine';
import { getFlowDefinition } from '../../config/flow-registry';

const identity: OperationsOpeningIdentity = { email: 'operations@example.test', userId: '900000001',
  displayName: 'TEST SANDBOX AA', accountType: 'PERSONAL' };
const form = { holder: identity.displayName, accountNumber: 'SANDBOX-BH-ACCOUNT', iban: '', fee: '0', note: 'AUTO_SANDBOX_BH_UNIT' };
const headers = ['客户信息', '申请类型', '通过时间', '账户状态', '账户信息', '最后活动', '操作'];
const cells = [`TSAA\n\n${identity.displayName}\n\nID: ${identity.userId}\n\n${identity.email}`, '个人', '2026-09-09 08:00', '启用',
  '新加坡账户\n未开通\n尚未开通账户\n开通\n巴林账户\n未开通\n尚未开通账户\n开通', '2026-09-09 08:30', '查看详情\n修改密码'];

test('运营客户按表头取字段，个人/企业和地区状态分别解析', () => {
  const row = parseOperationsCustomer(headers, cells);
  expect(row).toMatchObject({ ...identity, status: '启用', countries: { BH: { status: '未开通' }, SG: { status: '未开通' } } });
  expect(parseOperationsCustomer([...headers].reverse(), [...cells].reverse())).toEqual(row);
  const business = [...cells];
  business[1] = '企业';
  expect(parseOperationsCustomer(headers, business).accountType).toBe('BUSINESS');
  const opened = [...cells];
  opened[4] = `巴林账户\n已开户\n账号：SANDBOX-BH-ACCOUNT|收款人：${identity.displayName}\n编辑\n新加坡账户\n未开通\n开通`;
  expect(parseOperationsCustomer(headers, opened).countries).toEqual({
    BH: { status: '已开户', accountNumber: form.accountNumber, holder: form.holder },
    SG: { status: '未开通', accountNumber: undefined, holder: undefined }
  });
  expect(() => parseOperationsCustomer(headers, cells.map(cell => cell.replaceAll('未开通', '审核中')))).toThrow(/Unknown/);
});

test('邮箱/UID/类型/启用/地区逐层匹配，不允许0条、多条或另一个国家冒充', () => {
  const row = parseOperationsCustomer(headers, cells);
  const candidates = [row, { ...row, userId: '900000002' }, { ...row, email: `other-${identity.email}` },
    { ...row, accountType: 'BUSINESS' as const }, { ...row, status: '停用' },
    { ...row, countries: { ...row.countries, BH: { status: '已开户' } } }];
  const match = matchOperationsCustomers(candidates, identity, 'BH', '未开通');
  expect(match.stages.map(stage => stage.candidateCount)).toEqual([5, 4, 3, 2, 1]);
  expect(requireExactlyOneCandidate(match.candidates, 'BH').userId).toBe(identity.userId);
  expect(() => requireExactlyOneCandidate([], 'BH')).toThrow(/received 0/);
  expect(() => requireExactlyOneCandidate([row, row], 'BH')).toThrow(/received 2/);
});

test('零费用需显式配置，收费/未知费率不自动调整成免费', () => {
  expect(() => validateOperationsOpeningForm(form)).not.toThrow();
  expect(() => validateOperationsOpeningForm({ ...form, fee: '' })).not.toThrow();
  expect(operationsOpeningFeeInput('0', 'blank')).toBe('');
  expect(operationsOpeningFeeInput('0')).toBe('0');
  for (const fee of [undefined, '', '-1', '100', 'NaN', 'Infinity', '0.001']) {
    expect(() => operationsOpeningFeeInput(fee, 'blank')).toThrow();
  }
  for (const fee of ['-1', '100', 'NaN', 'Infinity', '0.001']) {
    expect(() => validateOperationsOpeningForm({ ...form, fee })).toThrow();
  }
  expect(() => validateOperationsOpeningForm({ ...form, accountNumber: '' })).toThrow();
});

test('Resume绑定原客户和地区，提交attempt持久化且不能再次确认', ({}, testInfo) => {
  const root = testInfo.outputPath('opening');
  const run = new OperationsOpeningRun('BH-UNIT', 'BH', identity, form, root);
  expect(() => run.attempt()).toThrow(/not uniquely/);
  run.located(identity.userId);
  run.attempt();
  expect(run.state().stage).toBe('ADMIN_APPROVAL_SUBMISSION_ATTEMPTED');
  const resumed = new OperationsOpeningRun('BH-UNIT', 'BH', identity, form, root);
  expect(resumed.attempted()).toBe(true);
  expect(() => resumed.attempt()).toThrow(/already attempted/);
  expect(() => new OperationsOpeningRun('BH-UNIT', 'BH', { ...identity, email: 'other@example.test' }, form, root)).toThrow(/mismatch/);
  expect(() => new OperationsOpeningRun('BH-UNIT', 'BH', identity, { ...form, accountNumber: 'different' }, root)).toThrow(/mismatch/);
  expect(() => new OperationsOpeningRun('BH-REPLACEMENT', 'BH', identity, form, root)).toThrow(/original Run/);
  expect(new OperationsOpeningRun('SG-UNIT', 'SG', identity, { ...form, accountNumber: 'SANDBOX-SG-ACCOUNT' }, root).attempted()).toBe(false);
  resumed.complete();
  expect(resumed.state().stage).toBe('COMPLETED');
  expect(() => resumed.attempt()).toThrow();
  const state = readFileSync(`${root}/admin-operations-opening-bh/BH-UNIT.json`, 'utf8');
  expect(state).not.toMatch(/operations@example|SANDBOX-BH-ACCOUNT|password|cookie|token/i);
});

test('Admin独立Mutation仍限制Sandbox、开关、单worker、零retry和单repeat', () => {
  const guard = new MoneyMutationGuard('admin-operations-opening-bh');
  const runtime = { baseURL: 'https://admin.sandbox.test', workers: 1, retries: 0, repeatEach: 1,
    safetySwitches: { ALLOW_ADMIN_MUTATION_TESTS: true } };
  expect(() => guard.validateRuntime(runtime)).not.toThrow();
  for (const change of [{ workers: 2 }, { retries: 1 }, { repeatEach: 2 }, { baseURL: 'https://fidere.com' },
    { safetySwitches: { ALLOW_ADMIN_MUTATION_TESTS: false } }]) {
    expect(() => guard.validateRuntime({ ...runtime, ...change })).toThrow();
  }
});

for (const country of ['BH', 'SG'] as const) {
  test(`${country}真实卡片结构只定位本地区；填表取消不确认，最终确认单次`, async ({ page }) => {
    await page.setContent(`<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody><tr>
      <td><p>${identity.displayName}</p><p>ID: ${identity.userId}</p><p>${identity.email}</p></td><td>个人</td><td>date</td><td>启用</td>
      <td><div>${(['SG', 'BH'] as const).map(key => `<div><div><p>${COUNTRY_LABELS[key]}</p><span>未开通</span></div>
      <p>尚未开通账户</p><button onclick="document.querySelector('#title').textContent='开通${COUNTRY_LABELS[key]}';document.querySelector('#form').hidden=false">开通</button></div>`).join('')}</div></td>
      <td>date</td><td><button>查看详情</button></td></tr></tbody></table>
      <div id="form" role="dialog" hidden><h2 id="title"></h2><p>${identity.displayName} / UID-${identity.userId}</p>
      <p>后台手动开通</p><p>未开通</p><label>收款人<input required></label><label>账户号码<input required></label>
      <label>IBAN（选填）<input></label><label>备注<input></label><label>开户费金额<input placeholder="空或 0 表示免费" oninput="window.feeInputs=(window.feeInputs||0)+1"></label>
      <select disabled></select><button onclick="document.querySelector('#form').hidden=true">取消</button>
      <button onclick="window.confirmed=(window.confirmed||0)+1">确认开通</button></div>`);
    const operations = new OperationsCustomersPage(page);
    const inputForm = country === 'SG' ? { ...form, fee: '' } : form;
    await operations.openCountryForm(identity, country);
    await operations.fillForm(inputForm);
    if (country === 'SG') expect(await page.evaluate(() => (window as unknown as { feeInputs?: number }).feeInputs ?? 0)).toBe(0);
    expect(operations.counts().finalSubmissionClicks).toBe(0);
    await operations.cancel();
    await operations.openCountryForm(identity, country);
    await operations.fillForm(inputForm);
    let attempts = 0;
    await operations.confirmOnce(() => attempts++);
    await expect(operations.confirmOnce(() => attempts++)).rejects.toThrow(/already attempted/);
    expect(attempts).toBe(1);
    expect(operations.counts().finalSubmissionClicks).toBe(1);
    expect(await page.evaluate(() => (window as unknown as { confirmed: number }).confirmed)).toBe(1);
  });
}

test('两个独立用例共享实现，不进入默认资金回归，也不依赖Client签署', () => {
  for (const country of ['bh', 'sg']) {
    const flow = getFlowDefinition(`admin-operations-opening-${country}`);
    expect(flow.scope).toBe('Admin');
    expect(flow.requiresClient || flow.requiresThirdParty || flow.requiresSecurityKey).toBe(false);
    expect(flow.changesData).toBe(true);
    expect(flow.realE2EVerified).toBe(true);
    expect(flow.status).toBe('Ready');
    expect(flow.defaultRegression).toBe(false);
    expect(flow.safetySwitches).toEqual(['ALLOW_ADMIN_MUTATION_TESTS']);
    expect(getFlowDefinition(`${flow.id}-dry-run`).changesData).toBe(false);
  }
});
