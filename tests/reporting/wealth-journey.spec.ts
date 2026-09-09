import { test, expect } from '../../fixtures/reporting.fixture';
import { parseWealthDisplayAmount } from '../../src/wealth/wealth-money';
import { matchingNewWealthOrders, uniqueSubscriptionAmount, type WealthJourneyEvidence } from '../../src/wealth/wealth-journey';
import { diagnoseWealthOrderCandidates } from '../../src/wealth/wealth-e2e';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { WealthJourneyStore } from '../../src/wealth/wealth-journey';
import { assertOriginalRejectedSubscription, compareRejectedHolding, rejectionFundsRestored } from '../../src/wealth/wealth-subscription-rejection';
import { WealthOrderListPage } from '../../pages/admin/WealthOrderListPage';
import type { WealthPosition } from '../../pages/client/FundTradingPage';
import { sanitizeBusinessData } from '../../src/reporting/sensitive-data-mask';

test('@wealth @validation @L1 USD and USDT remain distinct in full currency parsing', () => {
  expect(parseWealthDisplayAmount('-400.00 USDT')).toMatchObject({ amount: '400', currency: 'USDT' });
  expect(parseWealthDisplayAmount('-1,000.00 USD')).toMatchObject({ amount: '1000', currency: 'USD' });
  expect(parseWealthDisplayAmount('US$1,000')).toMatchObject({ amount: '1000', currency: 'USD' });
  expect(parseWealthDisplayAmount('US$0.01')).toMatchObject({ amount: '0.01', currency: 'USD' });
  expect(parseWealthDisplayAmount('100\nETH')).toMatchObject({ amount: '100', currency: 'ETH' });
  expect(() => parseWealthDisplayAmount('unavailable')).toThrow();
});

test('@wealth @validation @L1 Unique subscription amount is deterministic from named Run', () => {
  expect(uniqueSubscriptionAmount('1', 'WS003-20260908-143500')).toBe('1.43');
  expect(uniqueSubscriptionAmount('1', 'WS003-20260908-143500')).toBe(uniqueSubscriptionAmount('1', 'WS003-20260908-143500'));
});

test('@wealth @validation @L1 New order matching rejects historical IDs, wrong asset, account, amount and time', () => {
  const createdAt = '2026-09-08 14:35:00';
  const evidence: WealthJourneyEvidence = { runId: 'UNIT', kind: 'subscription', identityHash: 'test',
    oldOrderIds: ['INV-OLD'], amount: '1.43', currency: 'USD', productName: 'Sandbox Fund', purchaseAccount: '香港账户',
    createdAt: new Date(createdAt).toISOString(), confirmationClicks: 0, securityVerificationClicks: 0, adminApprovalClicks: 0, completed: false };
  const row = { orderId: 'INV-NEW', productName: 'Sandbox Fund', amount: '1.43', currency: 'USD',
    status: '待审核', type: '申购', createdAt, purchaseAccount: '香港账户' };
  const matches = matchingNewWealthOrders([row, { ...row, orderId: 'INV-OLD' },
    { ...row, orderId: 'INV-ASSET', currency: 'USDT' }, { ...row, orderId: 'INV-ACCOUNT', purchaseAccount: '新加坡账户' },
    { ...row, orderId: 'INV-AMOUNT', amount: '1.44' }, { ...row, orderId: 'INV-TIME', createdAt: '2026-01-01 00:00:00' }], evidence);
  expect(matches.map(item => item.orderId)).toEqual(['INV-NEW']);
});

test('@wealth @validation @L1 Admin fingerprint rechecks identity and cannot turn duplicate candidates into one', () => {
  const row = { orderId: 'INV-UNIT', kind: 'subscription' as const, customerText: 'wealth@example.test',
    productName: 'Sandbox Fund', amount: '1.43', currency: 'USD', status: '待审核' };
  const fingerprint = { ...row, customerIdentity: row.customerText };
  expect(diagnoseWealthOrderCandidates([row], fingerprint).candidates).toHaveLength(1);
  expect(diagnoseWealthOrderCandidates([row, row], fingerprint).candidates).toHaveLength(2);
  expect(diagnoseWealthOrderCandidates([{ ...row, customerText: 'another@example.test' }], fingerprint).candidates).toHaveLength(0);
});

const snapshot = { accountType: '香港账户', currency: 'USD', available: '98.4', frozen: '2.6', total: '101', observedAt: '2026-09-09T01:00:00Z' };
test('@wealth @validation @L1 Rejection report retains the three fund snapshots and holding evidence without leaking identity', () => {
  const data = sanitizeBusinessData({ senderIdentity: 'private@example.test', subscriptionOrderId: 'INV-UNIT1234',
    purchaseAccount: '香港账户', wealthRejectionReason: 'AUTO UNIT', wealthHoldingEvidence: JSON.stringify({ principal: '1.43' }),
    wealthBalanceSnapshots: JSON.stringify({ before: snapshot, afterSubmit: snapshot, afterReject: snapshot }),
    adminMutationClicks: 1, approvalClicks: 0, finalSubmissionClicks: 1, securityVerificationClicks: 1 });
  expect(data).toHaveProperty('wealthHoldingEvidence'); expect(data).toHaveProperty('wealthBalanceSnapshots');
  expect(data).toMatchObject({ wealthRejectionReason: 'AUTO UNIT', adminMutationClicks: 1, approvalClicks: 0 });
  expect(JSON.stringify(data)).not.toContain('private@example.test');
  expect(JSON.stringify(data)).not.toContain('INV-UNIT1234');
});
test('@wealth @validation @L1 Rejection restores available, historical freeze and total without guessing the submit-time rule', () => {
  expect(rejectionFundsRestored(snapshot, { ...snapshot, available: '98.40' })).toBe(true);
  for (const key of ['available', 'frozen', 'total'] as const) {
    expect(rejectionFundsRestored(snapshot, { ...snapshot, [key]: '0' })).toBe(false);
  }
  expect(rejectionFundsRestored(snapshot, { ...snapshot, accountType: '新加坡账户' })).toBe(false);
  expect(rejectionFundsRestored(snapshot, { ...snapshot, currency: 'USDT' })).toBe(false);
});

const position: WealthPosition = { productId: '1', productName: 'Sandbox Fund', principal: '1.43', currency: 'USD', status: '持有中' };
test('@wealth @validation @L1 Rejected subscription preserves an existing holding rather than requiring zero holdings', () => {
  expect(compareRejectedHolding([position], [{ ...position, principal: '1.430' }], '1', 'USD').passed).toBe(true);
  expect(compareRejectedHolding([position], [{ ...position, principal: '3.03' }], '1', 'USD').passed).toBe(false);
  expect(compareRejectedHolding([position], [position, { ...position, principal: '0' }], '1', 'USD').passed).toBe(false);
  expect(compareRejectedHolding([], [], '1', 'USD').passed).toBe(true);
  expect(compareRejectedHolding([], [position], '1', 'USD').passed).toBe(false);
  expect(compareRejectedHolding([position], [{ ...position, status: '' }], '1', 'USD').passed).toBe(false);
});

test('@wealth @validation @L1 Rejection validates the original INV, amount, account and displayed reason', () => {
  const record = { orderId: 'INV-UNIT', productName: 'Sandbox Fund', currency: 'USD', amount: '1.60',
    type: '申购', status: '已拒绝', createdAt: '2026-09-09 10:00:00', purchaseAccount: '香港账户', rejectionReason: 'AUTO UNIT' };
  const evidence: WealthJourneyEvidence = { runId: 'UNIT', kind: 'subscription', decision: 'reject', identityHash: 'unit',
    productName: record.productName, currency: 'USD', amount: '1.6', purchaseAccount: record.purchaseAccount, clientOrder: record,
    rejectionReason: 'AUTO UNIT', oldOrderIds: [], confirmationClicks: 1, securityVerificationClicks: 1, adminApprovalClicks: 0, completed: false };
  expect(() => assertOriginalRejectedSubscription(record, evidence)).not.toThrow();
  expect(() => assertOriginalRejectedSubscription({ ...record, rejectionReason: undefined }, evidence)).not.toThrow();
  for (const wrong of [{ orderId: 'INV-OTHER' }, { productName: 'Other' }, { currency: 'USDT' }, { amount: '2' },
    { purchaseAccount: '新加坡账户' }, { status: '持有中' }, { rejectionReason: 'Different reason' }]) {
    expect(() => assertOriginalRejectedSubscription({ ...record, ...wrong }, evidence)).toThrow();
  }
});

test('@wealth @validation @L1 Approval and rejection contexts cannot Resume each other and attempted actions cannot repeat', () => {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'wealth-reject-unit-'));
  try {
    const options = { rootDirectory, decision: 'reject' as const };
    const store = new WealthJourneyStore('subscription', 'REJECT-UNIT', 'unit@example.test', false, options);
    expect(() => new WealthJourneyStore('subscription', 'REJECT-UNIT', 'unit@example.test', true, { rootDirectory })).toThrow(/decision mismatch/);
    expect(() => store.reserveRejectionAttempt()).toThrow();
    store.evidence.clientOrder = { orderId: 'INV-UNIT', productName: 'Sandbox Fund', amount: '1.60', currency: 'USD',
      purchaseAccount: '香港账户', type: '申购', status: '待审核', createdAt: '2026-09-09 10:00:00' };
    store.advance('CLIENT_CREATED', { clientReference: 'INV-UNIT' });
    expect(() => new WealthJourneyStore('subscription', 'REPLACEMENT', 'unit@example.test', false, options)).toThrow(/earlier wealth submission/);
    store.advance('ADMIN_LOCATED');
    for (const count of [0, 2]) {
      store.evidence.candidateCount = count;
      expect(() => store.reserveRejectionAttempt()).toThrow();
    }
    store.evidence.candidateCount = 1; store.save();
    // A second loaded process cannot bypass the exclusive final-action marker.
    const stale = new WealthJourneyStore('subscription', 'REJECT-UNIT', 'unit@example.test', true, options);
    store.reserveRejectionAttempt();
    expect(() => stale.reserveRejectionAttempt()).toThrow(/EEXIST/);
    const resumed = new WealthJourneyStore('subscription', 'REJECT-UNIT', 'unit@example.test', true, options);
    expect(resumed.evidence.adminRejectionClicks).toBe(1);
    expect(() => resumed.reserveRejectionAttempt()).toThrow();
    expect(() => new WealthJourneyStore('subscription', 'REJECT-UNIT', 'other@example.test', true, options)).toThrow(/identity mismatch/);
  } finally {
    if (dirname(rootDirectory) !== resolve(tmpdir()) || !basename(rootDirectory).startsWith('wealth-reject-unit-')) {
      throw new Error('Refusing cleanup outside the named temporary unit-test directory.');
    }
    rmSync(rootDirectory, { recursive: true, force: true });
  }
});

test('@wealth @validation @L1 Local rejection form separates opening from final action and persists before clicking', async ({ page }) => {
  await page.setContent(`<section><div>INV-UNIT</div><p>订单号 手续费 申请时间</p>
    <button id="open">拒绝</button><button id="approve">批准认购</button>
    <section id="form" hidden><textarea placeholder="请说明拒绝该认购的原因"></textarea><button id="confirm" disabled>确认拒绝</button></section></section>
    <script>window.actions=[];
    document.querySelector('#open').onclick=()=>{document.querySelector('#form').hidden=false;window.actions.push('open');};
    document.querySelector('textarea').oninput=e=>{document.querySelector('#confirm').disabled=!e.target.value.trim();};
    document.querySelector('#confirm').onclick=()=>window.actions.push('reject');
    document.querySelector('#approve').onclick=()=>window.actions.push('approve');</script>`);
  const admin = new WealthOrderListPage(page);
  await expect(admin.rejectOnce('INV-UNIT', () => {})).rejects.toThrow(/unprepared/);
  await admin.fillRejectionForm('INV-UNIT', 'AUTO TEST');
  expect(admin.mutationClickCount()).toBe(0);
  await expect(admin.rejectOnce('INV-OTHER', () => {})).rejects.toThrow(/wrong/);
  await expect(admin.rejectOnce('INV-UNIT', () => { throw new Error('authorization closed'); })).rejects.toThrow(/authorization/);
  expect(await page.evaluate(() => (window as unknown as { actions: string[] }).actions)).toEqual(['open']);
  let persisted = false;
  await admin.rejectOnce('INV-UNIT', () => { persisted = true; });
  expect(persisted).toBe(true); expect(admin.mutationClickCount()).toBe(1);
  await expect(admin.rejectOnce('INV-UNIT', () => {})).rejects.toThrow(/repeated/);
  expect(await page.evaluate(() => (window as unknown as { actions: string[] }).actions)).toEqual(['open', 'reject']);
});
