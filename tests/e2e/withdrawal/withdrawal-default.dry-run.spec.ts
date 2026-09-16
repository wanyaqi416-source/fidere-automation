import { test } from '../../../fixtures/registration.fixture';
import { runJourneyWithdrawal } from '../../../src/withdrawal/journey-withdrawal';

test('默认Client出金确认页Dry Run @withdrawal @dry-run @L3', async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(180_000);
  test.skip(process.env.WITHDRAWAL_USE_DEFAULT_CLIENT !== 'true', 'Default Client Dry Run requires explicit default-account selection.');
  await runJourneyWithdrawal({ browser, adminPage, business, testInfo, dryRun: true });
});
