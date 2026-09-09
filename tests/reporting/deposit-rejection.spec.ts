import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { DepositRejectionRun, assertDepositRejectionAuthorization, assertDepositRejectionBalance } from '../../src/deposit/deposit-rejection-run';
import { deriveUniqueDepositAmount, matchAdminDepositRecordsIgnoringStatus, requireUniqueAdminDepositCandidate, type AdminDepositCandidate } from '../../src/deposit/deposit-e2e';
import { getFlowDefinition } from '../../config/flow-registry';
import { DepositClaimListPage } from '../../pages/admin/DepositClaimListPage';
import { sanitizeBusinessData } from '../../src/reporting/sensitive-data-mask';

const baseline = { balanceBefore: '123.45', previousTransactionIds: ['TXN-OLD'], submittedAt: '2026-09-09T08:00:00.000Z', channel: 'SWIFT' };
const candidate: AdminDepositCandidate = { recordKey: 'original', submittedAtText: '2026-09-09 16:00:00', submittedAtMs: Date.parse(baseline.submittedAt),
  accountType: '香港账户', currency: 'USD', requestedAmount: '11.32', actualAmount: '11.32', payerText: 'TEST PAYER', channel: 'SWIFT',
  reference: 'AUTO_DP004_TEST', matchedCustomerText: 'TEST SANDBOX AH', matchStatus: '已匹配', status: '待处理' };

test('Named Run authorization and deterministic two-decimal Deposit amount', () => {
  expect(() => assertDepositRejectionAuthorization('DP004-TEST', undefined)).toThrow(/authorization/);
  expect(() => assertDepositRejectionAuthorization('DP004-TEST', 'OTHER')).toThrow(/authorization/);
  expect(() => assertDepositRejectionAuthorization('DP004-TEST', 'DP004-TEST')).not.toThrow();
  const amount = deriveUniqueDepositAmount('DP004-TEST', '11', 2);
  expect(amount.equals(deriveUniqueDepositAmount('DP004-TEST', '11', 2))).toBe(true);
  expect(amount.greaterThanOrEqualTo('11') && amount.lessThan('12')).toBe(true);
});
test('Submission tombstone binds original user, amount and balance across Resume', ({}, info) => {
  const root = info.outputPath('state');
  const run = new DepositRejectionRun('ONE', 'SOURCE', '香港账户', 'USD', '11.32', root);
  run.attemptSubmit(baseline);
  const resumed = new DepositRejectionRun('ONE', 'SOURCE', '香港账户', 'USD', '11.32', root);
  expect(resumed.baseline()).toEqual(baseline);
  expect(() => resumed.attemptSubmit(baseline)).toThrow(/twice/);
  expect(() => new DepositRejectionRun('TWO', 'SOURCE', '香港账户', 'USD', '11.32', root)).toThrow(/unfinished/);
  expect(() => new DepositRejectionRun('ONE', 'OTHER', '香港账户', 'USD', '11.32', root)).toThrow(/mismatch/);
  expect(() => new DepositRejectionRun('ONE', 'SOURCE', '香港账户', 'USD', '11.33', root)).toThrow(/mismatch/);
});
test('Unique original TXN and candidate precede exactly one reject', ({}, info) => {
  const root = info.outputPath('state');
  const run = new DepositRejectionRun('ONE', 'SOURCE', '香港账户', 'USD', '11.32', root);
  expect(() => run.attemptReject()).toThrow();
  expect(() => run.created('TXN-ONE')).toThrow();
  run.attemptSubmit(baseline); run.created('TXN-ONE');
  expect(() => run.created('TXN-TWO')).toThrow(/changed/);
  expect(() => run.located('REF', 0)).toThrow();
  expect(() => run.located('REF', 2)).toThrow();
  run.located('REF', 1); run.attemptReject();
  const resumed = new DepositRejectionRun('ONE', 'SOURCE', '香港账户', 'USD', '11.32', root);
  expect(() => resumed.attemptReject()).toThrow();
  expect(() => resumed.located('OTHER', 1)).toThrow(/changed/);
  resumed.adminRejected(); resumed.clientRejected();
  expect(() => resumed.complete('134.77')).toThrow(/BALANCE_MISMATCH/);
  resumed.complete('123.4500'); expect(resumed.state().stage).toBe('COMPLETED');
  expect(() => resumed.attemptSubmit(baseline)).toThrow();
  expect(() => resumed.attemptReject()).toThrow();
  const state = readFileSync(`${root}/deposit-rejection-journey/ONE.json`, 'utf8');
  expect(state).not.toMatch(/password|cookie|token|email|securityKey|otp/i);
});
test('Balance equality is exact Decimal, not greater-than or tolerance', () => {
  expect(() => assertDepositRejectionBalance('0.10', '0.1')).not.toThrow();
  for (const after of ['0.11', '0.09', 'NaN', 'Infinity']) {
    expect(() => assertDepositRejectionBalance('0.10', after)).toThrow();
  }
});

test('Authorized original Admin evidence resumes without inventing a Client TXN and keeps rejection single-use', ({}, info) => {
  const run = new DepositRejectionRun('ONE', 'SOURCE', '香港账户', 'USD', '11.32', info.outputPath('state'));
  const fingerprint = { runId: 'ONE', userIdentity: candidate.matchedCustomerText, accountType: candidate.accountType,
    currency: 'USD', requestedAmount: '11.32', clientSubmittedAtMs: candidate.submittedAtMs, adminStatus: '待处理', channel: 'SWIFT' };
  expect(() => run.createdFromVerifiedAdmin(candidate, 1, fingerprint, 300_000)).toThrow();
  run.attemptSubmit(baseline);
  for (const count of [0, 2]) expect(() => run.createdFromVerifiedAdmin(candidate, count, fingerprint, 300_000)).toThrow();
  expect(() => run.createdFromVerifiedAdmin({ ...candidate, requestedAmount: '11.33' }, 1, fingerprint, 300_000)).toThrow();
  expect(() => run.createdFromVerifiedAdmin(candidate, 1, { ...fingerprint, clientSubmittedAtMs: 0 }, 300_000)).toThrow();
  const original = { ...candidate, reference: '-' };
  run.createdFromVerifiedAdmin(original, 1, fingerprint, 300_000);
  expect(run.state().clientReference).toBeUndefined();
  expect(run.state().stage).toBe('CLIENT_CREATED');
  expect(() => run.createdFromVerifiedAdmin({ ...original, payerText: 'DIFFERENT' }, 1, fingerprint, 300_000)).toThrow(/changed/);
  run.located('-', 1); run.attemptReject();
  expect(() => run.attemptReject()).toThrow();
  run.createdFromVerifiedAdmin({ ...original, status: '处理失败', recordKey: 'changed-status-key' }, 1, fingerprint, 300_000);
  run.adminRejected(); run.clientRejected(); run.complete('123.45');
  expect(run.state().stage).toBe('COMPLETED');
  expect(() => run.attemptSubmit(baseline)).toThrow();
});
test('Candidate matches user account currency exact amount time, not Admin TXN', () => {
  const fingerprint = { runId: 'ONE', userIdentity: candidate.matchedCustomerText, accountType: candidate.accountType,
    currency: 'USD', requestedAmount: '11.32', clientSubmittedAtMs: candidate.submittedAtMs, adminStatus: '待处理', channel: 'SWIFT' };
  const records = [candidate, { ...candidate, matchedCustomerText: 'OTHER' }, { ...candidate, accountType: '巴林账户' },
    { ...candidate, currency: 'HKD' }, { ...candidate, requestedAmount: '11.33' }, { ...candidate, submittedAtMs: 0 }];
  expect(matchAdminDepositRecordsIgnoringStatus(records, fingerprint, 300_000)).toEqual([candidate]);
  expect(matchAdminDepositRecordsIgnoringStatus([{ ...candidate, reference: '-' }], fingerprint, 300_000)).toHaveLength(1);
  expect(matchAdminDepositRecordsIgnoringStatus([{ ...candidate, reference: 'NON_TXN_BANK_REFERENCE' }], fingerprint, 300_000)).toHaveLength(1);
  expect(() => requireUniqueAdminDepositCandidate([])).toThrow();
  expect(() => requireUniqueAdminDepositCandidate([candidate, candidate])).toThrow();
  expect(matchAdminDepositRecordsIgnoringStatus([{ ...candidate, status: '已拒绝' }], fingerprint, 300_000)).toHaveLength(1);
});
test('Incomplete Admin pagination cannot report unique candidates', async ({ page }) => {
  await page.setContent('<table></table><button aria-label="Go to next page">next</button>');
  const list = new DepositClaimListPage(page);
  list.readCurrentPageRecords = async () => [candidate];
  // A page limit must throw even when only one record has been collected.
  await expect(list.readAllFilteredRecords(0)).rejects.toThrow(/incomplete/);
});

for (const pagination of [
  { label: 'early end', range: '1–1 of 2', message: /displayed total/ },
  { label: 'missing first page', range: '2–2 of 2', message: /skipped a range/ }
]) {
  test(`Admin candidate collection rejects ${pagination.label}`, async ({ page }) => {
    await page.setContent(`<table></table><p>${pagination.range}</p><button aria-label="Go to previous page" disabled>previous</button><button aria-label="Go to next page" disabled>next</button>`);
    const list = new DepositClaimListPage(page);
    list.readCurrentPageRecords = async () => [candidate];
    await expect(list.readAllFilteredRecords()).rejects.toThrow(pagination.message);
  });
}

test('An actually empty Admin list is complete, not a partial scan', async ({ page }) => {
  await page.setContent('<table></table><p>0–0 of 0</p><button aria-label="Go to previous page" disabled>previous</button><button aria-label="Go to next page" disabled>next</button>');
  const list = new DepositClaimListPage(page);
  list.readCurrentPageRecords = async () => [];
  expect(await list.readAllFilteredRecords()).toEqual([]);
});
test('Rejection case requires Client rejection and unchanged balance, no claim and no default regression', () => {
  const flow = getFlowDefinition('deposit-rejection-journey')!;
  expect(flow.adminAction).toBe('Reject');
  expect(flow.defaultRegression).toBe(false);
  expect(flow.safetySwitches).toContain('ALLOW_ADMIN_MUTATION_TESTS');
  expect(flow.primaryOracles.join(' ')).toContain('最终余额等于提交前余额');
  expect(flow.primaryOracles.join(' ')).toContain('Client原申请已拒绝');
});

test('Admin pagination waits through an empty loading table and collects all pages', async ({ page }) => {
  const headers = ['提交时间', '账户类型', '币种/金额', '实际入账金额', '付款人', '渠道', '参考号', '匹配客户', '匹配状态', '状态', '操作'];
  const row = (value: string) => `<tr>${['2026-09-09 16:00:00', '香港账户', `USD ${value}`, `USD ${value}`,
    'TEST PAYER', 'SWIFT', 'REF', 'TEST SANDBOX AH', '已匹配', '待处理', ''].map(cell => `<td>${cell}</td>`).join('')}</tr>`;
  let reachedLoading!: () => void;
  let releaseLoading!: () => void;
  const loading = new Promise<void>(resolve => { reachedLoading = resolve; });
  const release = new Promise<void>(resolve => { releaseLoading = resolve; });
  await page.exposeFunction('fixtureNextPage', async () => { reachedLoading(); await release; return row('11.33'); });
  await page.setContent(`<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${row('11.32')}</tbody></table>
    <p id="range">1–1 of 2</p><button aria-label="Go to previous page" disabled>previous</button><button aria-label="Go to next page">next</button>`);
  await page.evaluate(() => {
    const next = document.querySelector<HTMLButtonElement>('[aria-label="Go to next page"]')!;
    next.onclick = async () => {
      document.querySelector('tbody')!.innerHTML = '';
      document.getElementById('range')!.textContent = '2–2 of 2';
      const html = await (window as unknown as { fixtureNextPage(): Promise<string> }).fixtureNextPage();
      document.querySelector('tbody')!.innerHTML = html;
      next.disabled = true;
    };
  });
  let resolved = false;
  const result = new DepositClaimListPage(page).readAllFilteredRecords().then(rows => { resolved = true; return rows; });
  try {
    await loading;
    expect(resolved).toBe(false);
  } finally { releaseLoading(); }
  expect((await result).map(record => record.requestedAmount)).toEqual(['11.32', '11.33']);
});

test('Report retains masked identity, currency, balances, original references and counts', () => {
  const data = sanitizeBusinessData({ registrationTestName: 'TEST SANDBOX AH', registrationLoginIdentity: 'demo@example.test',
    depositCurrency: 'USD', depositAmount: '11.56', depositBalanceBefore: '794.62', depositBalanceAfter: '794.62',
    depositOrderId: 'TXN-EXAMPLE1234', recordOccurredAt: '2026-09-09 16:00:00', confirmationClicks: 1,
    rejectConfirmationClicks: 1, repeatedClientSubmission: false });
  expect(data).toMatchObject({ registrationTestName: 'TEST SANDBOX AH', depositCurrency: 'USD', depositAmount: '11.56',
    depositBalanceBefore: '794.62', depositBalanceAfter: '794.62', confirmationClicks: 1, rejectConfirmationClicks: 1,
    repeatedClientSubmission: false });
  expect(JSON.stringify(data)).not.toContain('demo@example.test');
  expect(data).toHaveProperty('depositOrderId');
  expect(data).toHaveProperty('recordOccurredAt');
});
