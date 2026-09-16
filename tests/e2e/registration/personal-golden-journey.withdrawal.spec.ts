import { test } from '../../../fixtures/registration.fixture';
import { env } from '../../../src/config/env';
import { runJourneyWithdrawal } from '../../../src/withdrawal/journey-withdrawal';

test.describe.configure({ mode: 'serial', retries: 0 });
test('原Personal Golden Journey小额出金审核通过 @journey @withdrawal @money @mutation @resume @L4', async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(360_000);
  test.skip(!env.exchange.allowMoneyTests || !env.allowAdminMutationTests, 'Requires this Run money and Admin authorization.');
  await runJourneyWithdrawal({ browser, adminPage, business, testInfo });
});
