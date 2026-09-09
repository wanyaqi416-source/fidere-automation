import { test } from '../../../fixtures/registration.fixture';
import { executeDigitalAddressApproval } from '../../../src/digital-address/digital-address-approval';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });
test('DA-002 数字资产地址新增与审核闭环 @mutation @L4', async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(240_000);
  await executeDigitalAddressApproval({ browser, adminPage, business, testInfo });
});
