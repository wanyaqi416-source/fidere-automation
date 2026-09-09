import { test, expect } from '../../fixtures/reporting.fixture';
import { parseWealthDisplayAmount } from '../../src/wealth/wealth-money';
import { matchingNewWealthOrders, uniqueSubscriptionAmount, type WealthJourneyEvidence } from '../../src/wealth/wealth-journey';
import { diagnoseWealthOrderCandidates } from '../../src/wealth/wealth-e2e';

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
