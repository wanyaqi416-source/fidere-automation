import { test } from '../../../fixtures/registration.fixture';
import { runOperationsOpening } from '../../../src/account-opening/admin-operations-opening-flow';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ retries: 0 });
for (const country of ['BH', 'SG'] as const) {
  test(`ADMIN-OPEN-${country}-DRY 运营客户${country === 'BH' ? '巴林' : '新加坡'}开户提交前验证 @dry-run @L3`, async ({ adminPage, business }, testInfo) => {
    test.setTimeout(90_000);
    await runOperationsOpening({ adminPage, business, testInfo, country, dryRun: true });
  });
}
