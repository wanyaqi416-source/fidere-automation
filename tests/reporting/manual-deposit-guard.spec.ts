import { test, expect } from '@playwright/test';
import { FreshUserBalanceBootstrapStore } from '../../src/journey/fresh-user-balance-bootstrap';

test('Admin手动入金提交前持久化尝试，不允许旧对象或重新载入后重复提交', async ({}, testInfo) => {
  const store = new FreshUserBalanceBootstrapStore(testInfo.outputPath('bootstrap'));
  const state = store.prepare({ journeyId: 'MD-UNIT', userEmail: 'sandbox@example.test', bootstrapAmount: '1000' });
  const attempted = store.recordSubmissionAttempt(state, '7.65');
  expect(attempted.stage).toBe('BOOTSTRAP_SUBMISSION_ATTEMPTED');
  expect(attempted.submissionClicks).toBe(1);
  expect(attempted.finalConfirmationClicks).toBe(1);
  expect(() => store.reconcileLegacyConfirmationOnly(attempted, { observedBalance: '7.65', originalConfirmationDialogObserved: true, existingLedgerCount: 0 })).toThrow(/real final attempt/);
  expect(() => store.recordSubmissionAttempt(state, '7.65')).toThrow(/already attempted/);
  expect(() => store.recordSubmissionAttempt(store.load('MD-UNIT')!, '7.65')).toThrow(/already attempted/);
  const submitted = store.recordSubmitted(attempted, { depositTxn: 'TXN-UNIT' });
  expect(submitted.stage).toBe('BOOTSTRAP_SUBMITTED');
  expect(() => store.recordCompleted(submitted, { depositTxn: 'TXN-UNIT', balanceBefore: '7.65', balanceAfter: '1000' })).toThrow(/Oracle/);
  expect(store.recordCompleted(submitted, { depositTxn: 'TXN-UNIT', balanceBefore: '7.65', balanceAfter: '1007.65' }).stage).toBe('BOOTSTRAP_COMPLETED');
});

test('打开二次确认不等于入金，最终确认计数只能从0到1', async ({}, testInfo) => {
  const store = new FreshUserBalanceBootstrapStore(testInfo.outputPath('bootstrap'));
  const state = store.prepare({ journeyId: 'MD-DOUBLE-CONFIRM', userEmail: 'sandbox@example.test', bootstrapAmount: '1000' });
  const opened = store.recordConfirmationOpened(state);
  expect(opened.stage).toBe('BOOTSTRAP_CONFIRMATION_REQUIRED');
  expect(opened.confirmationOpenClicks).toBe(1);
  expect(opened.finalConfirmationClicks ?? 0).toBe(0);
  const attempted = store.recordSubmissionAttempt(opened, '7.65');
  expect(attempted.finalConfirmationClicks).toBe(1);
  expect(() => store.recordConfirmationOpened(opened)).toThrow(/final submission attempt/);
  expect(() => store.recordSubmissionAttempt(opened, '7.65')).toThrow(/already attempted/);
});
