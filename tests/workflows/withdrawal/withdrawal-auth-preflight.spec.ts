import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { runWithdrawalAuthPreflight } from '../../../src/withdrawal/withdrawal-auth-preflight';
import { WithdrawalExecutionGuard } from '../../../src/withdrawal/withdrawal-e2e';

test.describe.configure({ mode: 'serial', retries: 0 });

test('Withdrawal Client/Admin认证预检 @withdrawal @readonly @preflight', async ({ clientPage, adminPage }) => {
  if (!env.client.baseUrl || !env.admin.baseUrl) {
    throw new Error('CLIENT_BASE_URL and ADMIN_BASE_URL are required for Withdrawal preflight.');
  }
  expect(env.exchange.allowMoneyTests).toBe(false);
  expect(env.allowAdminMutationTests).toBe(false);
  const guard = new WithdrawalExecutionGuard();
  await runWithdrawalAuthPreflight({
    clientPage,
    adminPage,
    clientBaseUrl: env.client.baseUrl,
    adminBaseUrl: env.admin.baseUrl,
    guard
  });
  expect(() => guard.assertClientSubmissionAllowed(false, false)).toThrow(
    /ALLOW_MONEY_TESTS=true/
  );
});
