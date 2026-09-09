import { test } from '../../../fixtures/registration.fixture';
import { runDepositRejection } from '../../../src/deposit/deposit-rejection-flow';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ retries: 0 });
test('DP-004 Existing user fiat Deposit rejection journey', { tag: ['@mutation', '@money', '@L4', '@deposit'] }, async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(420_000);
  await runDepositRejection({ browser, adminPage, business, testInfo, mode: process.env.DEPOSIT_REJECT_RESUME === 'true' ? 'resume' : 'fresh' });
});
