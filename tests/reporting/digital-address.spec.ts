import { readFileSync, readdirSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { DigitalAddressRun, decodeDigitalAddressReceipt, maskWalletAddress, matchDigitalAddresses,
  validateDigitalAddressInput, type DigitalAddressFingerprint, type DigitalAddressCandidate } from '../../src/digital-address/digital-address';
import { MoneyMutationGuard, requireExactlyOneCandidate } from '../../src/flow-engine';
import { DigitalAddressPage } from '../../pages/client/DigitalAddressPage';
import { AdminWhitelistReviewPage } from '../../pages/admin/AdminWhitelistReviewPage';
import { BankAccountManagementPage } from '../../pages/client/BankAccountManagementPage';
import { sanitizeBusinessData } from '../../src/reporting/sensitive-data-mask';

const fingerprint: DigitalAddressFingerprint = { email: 'fixture@example.test', userId: '42', assetKey: 'USDT_TRC20', address: 'TEST-CaSeSensitive-WALLET', label: 'AUTO DA UNIT' };
const row: DigitalAddressCandidate = { id: '101', customerText: 'TEST USER ID: 42 fixture@example.test', address: fingerprint.address,
  asset: 'USDT', network: 'Tron', label: fingerprint.label, status: '待审核', submittedAt: '2026-09-08 18:00' };

test('DA candidate stages reject wrong user, network, label, original ID and ambiguous candidates', () => {
  for (const mismatch of [{ customerText: 'other-fixture@example.test' }, { customerText: 'ID: 420' }, { network: 'Ethereum' },
    { label: 'another run' }, { asset: 'ETH' }, { address: fingerprint.address.toLowerCase() }]) {
    expect(matchDigitalAddresses([{ ...row, ...mismatch }], fingerprint, '待审核').candidates.length).toBe(0);
  }
  expect(matchDigitalAddresses([row], { ...fingerprint, reference: '999' }).candidates.length).toBe(0);
  const result = matchDigitalAddresses([row], fingerprint, '待审核');
  expect(result.stages.map(stage => stage.candidateCount)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  expect(requireExactlyOneCandidate(result.candidates, 'DA').id).toBe('101');
  expect(() => requireExactlyOneCandidate([], 'DA')).toThrow();
  expect(() => requireExactlyOneCandidate([row, { ...row, id: '102' }], 'DA')).toThrow();
});

test('DA preflight duplicate detection ignores a new label but preserves exact wallet/network', () => {
  expect(matchDigitalAddresses([{ ...row, label: 'OLD LABEL' }], fingerprint, undefined, false).candidates.length).toBe(1);
  expect(matchDigitalAddresses([{ ...row, network: 'Ethereum' }], fingerprint, undefined, false).candidates.length).toBe(0);
});

test('DA only explicit business success codes are accepted, never HTTP200 alone', () => {
  for (const body of [undefined, null, {}, { status: 200 }, { code: '' }, { code: false }, { code: null }, { code: 500 }, { code: 0, data: false }]) {
    expect(decodeDigitalAddressReceipt(body).accepted).toBe(false);
  }
  expect(decodeDigitalAddressReceipt({ code: 0, data: { id: 101, token: 'not-retained' } })).toEqual({ accepted: true, reference: '101' });
});

test('DA state binds the original identity, survives restarts and blocks duplicate actions', ({}, testInfo) => {
  const root = testInfo.outputPath('state');
  const identity = { ...fingerprint, sourceRunId: 'REG-UNIT' };
  const run = new DigitalAddressRun('DA-UNIT', identity, root);
  run.attempt('client');
  run.advance('CLIENT_SUBMIT_ATTEMPTED');
  run.attempt('security');
  run.advance('SECURITY_KEY_VERIFICATION_ATTEMPTED');
  const resumed = new DigitalAddressRun('DA-UNIT', identity, root);
  expect(() => resumed.attempt('client')).toThrow();
  expect(() => resumed.attempt('security')).toThrow();
  expect(() => new DigitalAddressRun('DA-UNIT', { ...identity, address: 'another-address' }, root)).toThrow(/identity mismatch/);
  resumed.advance('CLIENT_CREATED', { clientReference: '101' });
  resumed.advance('ADMIN_LOCATED', { adminReference: '101' });
  resumed.attempt('admin');
  resumed.advance('ADMIN_APPROVAL_SUBMISSION_ATTEMPTED');
  expect(() => new DigitalAddressRun('DA-UNIT', identity, root).attempt('admin')).toThrow();
  resumed.advance('ADMIN_ACTION_DONE');
  resumed.advance('CLIENT_FINALIZED');
  resumed.advance('COMPLETED');
  expect(() => resumed.attempt('client')).toThrow(/Completed/);
  const stored = readdirSync(`${root}/digital-address-approval`).map(file => readFileSync(`${root}/digital-address-approval/${file}`, 'utf8')).join('');
  expect(stored).not.toContain(fingerprint.address);
  expect(stored).not.toContain(fingerprint.email);
  expect(stored).not.toMatch(/password|cookie|token|otp/i);
});

test('DA validates observed length limits and masks wallets before reporting', () => {
  expect(() => validateDigitalAddressInput(fingerprint)).not.toThrow();
  for (const bad of [{ label: '' }, { label: 'A'.repeat(51) }, { address: '' }, { address: 'A'.repeat(201) }]) {
    expect(() => validateDigitalAddressInput({ ...fingerprint, ...bad })).toThrow();
  }
  const masked = maskWalletAddress(fingerprint.address);
  expect(masked).not.toBe(fingerprint.address);
  expect(sanitizeBusinessData({ digitalWalletMasked: masked, password: 'not-retained' })).toEqual({ digitalWalletMasked: masked });
});

test('DA remains a Client/Admin non-money mutation with serial execution switches', () => {
  const guard = new MoneyMutationGuard('digital-address-approval', true, true);
  const runtime = { baseURL: 'https://client.sandbox.test', workers: 1, retries: 0, repeatEach: 1,
    safetySwitches: { ALLOW_CLIENT_MUTATION_TESTS: true, ALLOW_ADMIN_MUTATION_TESTS: true } };
  expect(() => guard.validateRuntime(runtime)).not.toThrow();
  for (const disabled of Object.keys(runtime.safetySwitches)) {
    expect(() => guard.validateRuntime({ ...runtime, safetySwitches: { ...runtime.safetySwitches, [disabled]: false } })).toThrow();
  }
  for (const invalid of [{ workers: 2 }, { retries: 1 }, { repeatEach: 2 }, { baseURL: 'https://client.production.example' }]) {
    expect(() => guard.validateRuntime({ ...runtime, ...invalid })).toThrow();
  }
  expect(() => guard.assertAdminActionAllowed(runtime.safetySwitches)).toThrow();
});

test('DA shares SecurityKeyDialog and prohibits final clicks when the guard denies', async ({ page }) => {
  await page.setContent('<div role="dialog" aria-label="添加地址"><button>提交</button></div>');
  const client = new DigitalAddressPage(page);
  await expect(client.submitForSecurityOnce(() => { throw new Error('not authorized'); })).rejects.toThrow('not authorized');
  expect(client.counts()).toEqual({ clientSubmissionClicks: 0, securityKeyVerifications: 0 });
  await page.setContent('<div role="dialog" aria-label="确认通过审核"><button>确认通过</button></div>');
  const admin = new AdminWhitelistReviewPage(page);
  await expect(admin.confirmApproveOnce(() => { throw new Error('not authorized'); })).rejects.toThrow('not authorized');
  expect(admin.counts().adminApprovalClicks).toBe(0);
});

test('DA reads reordered headers and separates enabled state from approval state', async ({ page }) => {
  await page.setContent(`<div role="tab" aria-selected="true">待审核</div><table><thead><tr>${['地址', '白名单ID', '客户信息', '地址类型', '状态', '标签', '网络', '提交时间', '操作'].map(t => `<th>${t}</th>`).join('')}</tr></thead>
    <tbody><tr>${[row.address, row.id, row.customerText, row.asset, '启用', row.label, row.network, row.submittedAt, '查看详情'].map(t => `<td>${t}</td>`).join('')}</tr></tbody></table>`);
  const rows = await new AdminWhitelistReviewPage(page).readRows();
  expect(rows.length).toBe(1);
  expect(rows[0].address).toBe(row.address);
  expect(rows[0].id).toBe('101');
  expect(rows[0].status).toBe('待审核');
  expect(rows[0].enabledState).toBe('启用');
});

test('Shared settings navigation retains the existing fiat bank entry', async ({ page }) => {
  await page.route('https://client.sandbox.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
    new URL(route.request().url()).pathname.endsWith('/dashboard')
      ? `<div class="MuiAvatar-root" onclick="document.getElementById('menu').hidden=false"><svg class="lucide-user"></svg></div>
          <div id="menu" role="menu" hidden><button role="menuitem" onclick="location.href='/zh-CN/user-profile'">设置</button></div>`
      : `<button onclick="document.getElementById('heading').hidden=false">银行账户管理</button><h1 id="heading" hidden>银行账户管理</h1>` }));
  await new BankAccountManagementPage(page).gotoFromProfileMenu('https://client.sandbox.test');
  await expect(page.getByRole('heading', { name: '银行账户管理' })).toBeVisible();
});
