import { test } from '../../../fixtures/registration.fixture';
import { runOperationsOpening } from '../../../src/account-opening/admin-operations-opening-flow';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ retries: 0 });
for (const country of ['BH', 'SG'] as const) {
  test(`ADMIN-OPEN-${country}-001 运营客户${country === 'BH' ? '巴林' : '新加坡'}账户开通 @mutation @L4`, async ({ adminPage, business }, testInfo) => {
    test.setTimeout(150_000);
    await runOperationsOpening({ adminPage, business, testInfo, country, dryRun: false });
  });
}
