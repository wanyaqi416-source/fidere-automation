import { test } from '../../../fixtures/registration.fixture';
import { runDepositRejection } from '../../../src/deposit/deposit-rejection-flow';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test('DP-004-READONLY Inspect original Deposit without an Admin TXN requirement', { tag: ['@readonly', '@L2', '@deposit'] }, async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(360_000);
  await runDepositRejection({ browser, adminPage, business, testInfo, mode: 'readonly' });
});
