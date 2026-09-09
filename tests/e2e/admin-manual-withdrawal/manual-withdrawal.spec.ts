import { test } from '../../../fixtures/registration.fixture';
import { runAdminManualWithdrawal } from '../../../src/withdrawal/admin-manual-withdrawal-flow';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });
test('ADMIN-MW-001 原Journey用户Admin普通手动出金一次 @money @mutation @L4', async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(180_000);
  await runAdminManualWithdrawal({ browser, adminPage, business, testInfo, dryRun: false });
});
