import { DepositPage } from '../../../pages/client/DepositPage';
import { expect, test } from '../../../fixtures/registration.fixture';
import { env } from '../../../src/config/env';
import {
  openPersonalJourneyClientSession,
  PersonalJourneyContextStore
} from '../../../src/registration';
import { getDepositTestConfig } from '../../client/deposit/depositTestSupport';

test('Personal Golden Journey Deposit form option probe @readonly', async ({ browser }) => {
  expect(env.exchange.allowMoneyTests).toBe(false);
  expect(env.allowAdminMutationTests).toBe(false);
  expect(env.allowClientMutationTests).toBe(false);
  const baseURL = env.client.baseUrl;
  const password = env.client.password;
  const otp = env.client.otp;
  if (!baseURL || !password || !otp) throw new Error('Client probe configuration is incomplete.');
  const sourceRunId = env.personalRegistration.adminApprovalSourceRunId ?? 'REGP-20260904020924';
  const source = new PersonalJourneyContextStore().load(sourceRunId);
  if (!source) throw new Error('Personal source Journey was not found.');
  const config = getDepositTestConfig();
  const client = await openPersonalJourneyClientSession({
    browser,
    baseURL,
    runId: sourceRunId,
    email: source.email,
    password,
    otp
  });
  try {
    const deposit = new DepositPage(client.page);
    await deposit.goto(baseURL);
    await deposit.selectAccount(config.accountType);
    await deposit.selectCurrency(config.currencyLabel);
    const options = {
      channels: await deposit.readChannelOptions(),
      purposes: await deposit.readPurposeOptions(),
      sourcesOfFunds: await deposit.readSourceOfFundsOptions(),
      transferMethods: await deposit.readTransferMethodOptions(),
      supportingDocument: await deposit.readSupportingDocumentRequirements()
    };
    test.info().annotations.push({
      type: 'deposit-form-options',
      description: JSON.stringify(options)
    });
    console.log(`DEPOSIT_FORM_OPTIONS=${JSON.stringify(options)}`);
  } finally {
    await client.context.close();
  }
});
