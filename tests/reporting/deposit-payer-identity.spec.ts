import { expect, test } from '@playwright/test';
import { AdminClientUsersPage } from '../../pages/admin/AdminClientUsersPage';
import { depositCustomerIdentityHash, diagnoseAdminDepositCandidates, matchAdminDepositCandidates,
  matchAdminDepositRecordsIgnoringStatus, type AdminDepositCandidate } from '../../src/deposit/deposit-e2e';

const candidate: AdminDepositCandidate = { recordKey: 'original', submittedAtText: '2026-09-14 17:35:31',
  submittedAtMs: Date.parse('2026-09-14T17:35:31+08:00'), accountType: '香港账户', currency: 'USD',
  requestedAmount: '11.66', actualAmount: '11.66', payerText: 'TEST COMPANY', channel: 'SWIFT',
  reference: '-', matchedCustomerText: 'DIFFERENT PERSONAL PROFILE', matchStatus: '已匹配', status: '待处理' };

test('payer-mode uses the real payer, not matched customer, nickname or TXN', () => {
  const fingerprint = { runId: 'test', userIdentity: depositCustomerIdentityHash('TEST COMPANY'),
    identityField: 'payer' as const, accountType: '香港账户', currency: 'USD', requestedAmount: '11.66',
    clientSubmittedAtMs: candidate.submittedAtMs, adminStatus: '待处理', channel: 'SWIFT' };
  expect(matchAdminDepositCandidates([candidate], fingerprint, 300_000)).toHaveLength(1);
  expect(diagnoseAdminDepositCandidates([candidate], fingerprint, 300_000).counts.user).toBe(1);
  expect(matchAdminDepositRecordsIgnoringStatus([{ ...candidate, status: '处理完成' }], fingerprint, 300_000)).toHaveLength(1);
  expect(matchAdminDepositCandidates([{ ...candidate, payerText: 'OTHER', matchedCustomerText: 'TEST COMPANY' }], fingerprint, 300_000)).toHaveLength(0);
  expect(matchAdminDepositCandidates([candidate], { ...fingerprint, identityField: undefined }, 300_000)).toHaveLength(0);
  expect(matchAdminDepositCandidates([candidate], { ...fingerprint, identityField: undefined,
    userIdentity: depositCustomerIdentityHash(candidate.matchedCustomerText) }, 300_000)).toHaveLength(1);
  expect(matchAdminDepositCandidates([{ ...candidate, requestedAmount: '11.67' }], fingerprint, 300_000)).toHaveLength(0);
});

test('personal identity matches matched customer even when payer differs, with no payer fallback', () => {
  const fingerprint = { runId: 'test', userIdentity: depositCustomerIdentityHash('TEST PERSON'),
    identityField: 'matchedCustomer' as const, accountType: '香港账户', currency: 'USD', requestedAmount: '11.66',
    clientSubmittedAtMs: candidate.submittedAtMs, adminStatus: '待处理', channel: 'SWIFT' };
  const personal = { ...candidate, payerText: 'UNRELATED BANK HOLDER', matchedCustomerText: 'TEST PERSON' };
  expect(matchAdminDepositCandidates([personal], fingerprint, 300_000)).toHaveLength(1);
  expect(diagnoseAdminDepositCandidates([personal], fingerprint, 300_000).counts.user).toBe(1);
  expect(matchAdminDepositRecordsIgnoringStatus([{ ...personal, status: '处理完成' }], fingerprint, 300_000)).toHaveLength(1);
  expect(matchAdminDepositCandidates([{ ...personal, payerText: 'TEST PERSON', matchedCustomerText: 'OTHER' }], fingerprint, 300_000)).toHaveLength(0);
  expect(matchAdminDepositCandidates([personal, { ...personal, recordKey: 'duplicate' }], fingerprint, 300_000)).toHaveLength(2);
});

for (const accountType of ['PERSONAL', 'BUSINESS'] as const) {
  test(`${accountType} reads the correct field from the same email's Admin user detail`, async ({ page }) => {
    const email = 'tester@sandbox.test';
    const details: string[] = [];
    const field = (label: string, value: string) => `<div><div><h6>${label}</h6></div><p>${value}</p></div>`;
    await page.route('https://admin.test/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/zh-CN/kyc/userManagement') {
        await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<input name="keyword"><table><thead><tr><th>客户信息</th><th>申请类型</th></tr></thead><tbody><tr><td><p>TEST NICKNAME 企业 个人</p><p>ID: 7</p><p>${email}</p></td><td>${accountType === 'BUSINESS' ? '企业' : '个人'}</td></tr></tbody></table>` });
      } else {
        details.push(path);
        await route.fulfill({ contentType: 'text/html; charset=utf-8', body: accountType === 'BUSINESS'
          ? `<p>企业客户</p><div><div><p>主体名称</p></div><p>TEST COMPANY</p></div>${field('名', 'WRONG')}${field('姓', 'PERSON')}`
          : `<p>个人客户</p><p>${email}</p>${field('名', 'TEST')}${field('中间名', 'IGNORE')}${field('姓', 'PERSON')}` });
      }
    });
    expect(await new AdminClientUsersPage(page).readDepositCustomerIdentityByEmail('https://admin.test', email))
      .toEqual({ accountType, userId: '7', name: accountType === 'BUSINESS' ? 'TEST COMPANY' : 'TEST PERSON' });
    expect(details).toEqual([`/zh-CN/kyc/userManagement/7${accountType === 'BUSINESS' ? '/enterprise' : ''}`]);
  });
}

for (const invalid of ['unknown-type', 'missing-header', 'duplicate-users', 'different-email'] as const) {
  test(`Admin identity does not guess or open a detail for ${invalid}`, async ({ page }) => {
    let detailOpened = false;
    const row = `<tr><td><p>ID: 7</p><p>${invalid === 'different-email' ? 'other' : 'tester'}@sandbox.test</p></td><td>${invalid === 'unknown-type' ? '未知' : '个人'}</td></tr>`;
    await page.route('https://admin.test/**', async route => {
      if (new URL(route.request().url()).pathname !== '/zh-CN/kyc/userManagement') detailOpened = true;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<input name="keyword"><table><thead><tr><th>客户信息</th><th>${invalid === 'missing-header' ? '其他类型' : '申请类型'}</th></tr></thead><tbody>${row}${invalid === 'duplicate-users' ? row : ''}</tbody></table>` });
    });
    await expect(new AdminClientUsersPage(page).readDepositCustomerIdentityByEmail('https://admin.test', 'tester@sandbox.test'))
      .rejects.toThrow(/application.type|candidateCount/);
    expect(detailOpened).toBe(false);
  });
}
