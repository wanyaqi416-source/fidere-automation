import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { runTransferAuthPreflight } from '../../../src/transfer/transfer-auth-preflight';
import { TransferExecutionGuard } from '../../../src/transfer/transfer-e2e';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'TR-002双端认证与资金门禁预检 @workflows @transfer @readonly @auth-preflight',
  async ({ adminPage, clientPage }) => {
    if (!env.client.baseUrl || !env.admin.baseUrl) {
      throw new Error('CLIENT_BASE_URL and ADMIN_BASE_URL are required for Transfer E2E preflight.');
    }

    const guard = new TransferExecutionGuard();
    await runTransferAuthPreflight({
      clientPage,
      adminPage,
      clientBaseUrl: env.client.baseUrl,
      adminBaseUrl: env.admin.baseUrl,
      guard
    });

    // This stage must prove authentication is ready while the money gate remains closed.
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(() =>
      guard.assertClientSubmissionAllowed(
        env.exchange.allowMoneyTests,
        env.allowAdminMutationTests
      )
    ).toThrow('ALLOW_MONEY_TESTS is false');
  }
);
