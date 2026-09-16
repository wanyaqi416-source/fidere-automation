import { test } from '../../../fixtures/workflow.fixture';
import { runExistingU2u } from '../../../src/user-transfer/u2u-existing-runner';

test.describe.configure({ mode: 'serial', retries: 0 });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('U2U-006 现有用户转账、审核及双方资金流水闭环', {
  tag: ['@u2u', '@e2e', '@money', '@mutation', '@L4']
}, async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(480_000);
  await runExistingU2u({ browser, adminPage, business, testInfo });
});
