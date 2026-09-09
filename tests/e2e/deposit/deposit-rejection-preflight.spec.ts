import { test } from '../../../fixtures/registration.fixture';
import { runDepositRejection } from '../../../src/deposit/deposit-rejection-flow';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test('DP-004-PREFLIGHT Existing user Deposit rejection preflight', { tag: ['@dry-run', '@L3', '@deposit'] }, async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(210_000);
  await runDepositRejection({ browser, adminPage, business, testInfo, mode: 'preflight' });
});
