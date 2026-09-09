import { test, expect } from '../../../fixtures/client.fixture';
import { env } from '../../../src/config/env';
import { loadU2uEvidence, participantHash } from '../../../src/user-transfer/u2u-evidence';
import { reconcileU2u } from '../../../src/user-transfer/u2u-reconciliation';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('U2U-003 原用户转账只读复核', { tag: ['@client', '@u2u', '@readonly', '@reconciliation'] }, async ({ browser, baseURL, business }) => {
  test.setTimeout(240_000);
  business.flow('user-to-user-transfer-reconciliation');
  const runId = process.env.U2U_RUN_ID;
  const recipient = process.env.U2U_RECIPIENT_EMAIL;
  if (!runId || !recipient || !env.client.username || !baseURL) throw new Error('Original U2U runId and both participants are required.');
  const evidence = loadU2uEvidence(runId);
  expect(evidence.senderHash === participantHash(env.client.username), 'Original Sender unchanged').toBe(true);
  expect(evidence.recipientHash === participantHash(recipient), 'Original Recipient unchanged').toBe(true);
  business.disallowSafeRerun();
  await reconcileU2u({ browser, baseURL, sender: env.client.username, recipient, evidence, business });
  business.setBusinessData({ confirmed: true, finalStatus: '已完成', createdOrderCount: 0, confirmationClicks: 0, securityVerificationClicks: 0, adminMutationClicks: 0 });
});
