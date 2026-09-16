import { expect, test } from '@playwright/test';
import {
  isClientTransferCompleted,
  locateApprovableTransfer
} from '../../src/transfer/transfer-approval-state';
import type { AdminTransferCandidate, TransferFingerprint } from '../../src/transfer/transfer-e2e';

const start = Date.parse('2026-09-14T18:44:28+08:00');
const fingerprint: TransferFingerprint = { runId: 'LOCAL-ONLY', userIdentity: 'sender@example.test',
  sourceAccountType: '香港账户', targetAccountType: '老虎证券', currency: 'USD', amount: '80.82',
  runStartedAtMs: start, clientSubmittedAtMs: start + 10_000, adminStatus: '待审核' };
const row: AdminTransferCandidate = { adminTransactionId: 'TXN-original', recordType: '信托转券商',
  userIdentity: fingerprint.userIdentity, sourceAccountType: fingerprint.sourceAccountType,
  targetAccountType: fingerprint.targetAccountType, currency: 'USD', amount: '80.82', requestedAmount: '80.82',
  feeAmount: '40', netAmount: '40.82', createdAtMs: Math.floor(start / 60_000) * 60_000, status: '已批准' };
test('already approved original is recognized without requiring pending status', () => {
  expect(locateApprovableTransfer([row], fingerprint, 60_000)).toBe(row);
  expect(locateApprovableTransfer([{ ...row, status: '待审核' }], fingerprint, 60_000).status).toBe('待审核');
});
test('matching both statuses cannot conceal duplicates; history and wrong identities are excluded', () => {
  expect(() => locateApprovableTransfer([row, { ...row, adminTransactionId: 'TXN-other', status: '待审核' }], fingerprint, 60_000)).toThrow();
  for (const patch of [{ createdAtMs: start - 60_000 }, { createdAtMs: undefined }, { status: '已拒绝' },
    { userIdentity: 'other@example.test' }, { requestedAmount: '80.83' }]) {
    expect(() => locateApprovableTransfer([{ ...row, ...patch }], fingerprint, 60_000)).toThrow();
  }
});

test('completed Client transfer skips the pending Admin candidate path', () => {
  expect(isClientTransferCompleted('已完成')).toBe(true);
  expect(isClientTransferCompleted('Completed')).toBe(true);
  expect(isClientTransferCompleted('待审核')).toBe(false);
  expect(isClientTransferCompleted('处理中')).toBe(false);
});
