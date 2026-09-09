import { test } from '../../../fixtures/registration.fixture';
import { runAdminManualWithdrawal } from '../../../src/withdrawal/admin-manual-withdrawal-flow';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });
test('ADMIN-MW-DRY Admin手动出金提交前验证 @dry-run @L3', async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(180_000);
  await runAdminManualWithdrawal({ browser, adminPage, business, testInfo, dryRun: true });
});
