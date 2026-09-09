import { test, expect } from '../../../fixtures/registration.fixture';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { ManualFiatDepositPage } from '../../../pages/admin/ManualFiatDepositPage';
import { BrokerOpeningReviewPage } from '../../../pages/admin/BrokerOpeningReviewPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { SecuritiesTradingPage } from '../../../pages/client/SecuritiesTradingPage';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment } from '../../../src/flow-engine';
import { PersonalPostRegistrationJourneyStore } from '../../../src/journey';
import { openPersonalJourneyClientSession } from '../../../src/registration';
import { maskSensitiveText } from '../../../src/reporting/sensitive-data-mask';
import { BrokerOpeningPage } from '../../../pages/client/BrokerOpeningPage';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });
test('券商开户与Admin手动入金只读预检 @readonly @L2', async ({ browser, adminPage, business }) => {
  test.setTimeout(180_000);
  assertSandboxEnvironment(env.client.baseUrl);
  assertSandboxEnvironment(env.admin.baseUrl);
  expect(env.exchange.allowMoneyTests || env.allowAdminMutationTests).toBe(false);
  const sourceRunId = process.env.BROKER_SOURCE_RUN_ID;
  if (!sourceRunId) throw new Error('An existing funded Journey source is required.');
  const source = new PersonalPostRegistrationJourneyStore(sourceRunId).load();
  if (!source || source.stage !== 'COMPLETED') throw new Error('Existing completed Journey required.');
  business.flow('account-opening-dry-run', { caseId: 'BROKER-PREFLIGHT', name: '原用户券商开户与手动入金只读预检', expectedResult: '复用原用户，不提交任何资金或开户操作。' });
  const shell = new AdminShellPage(adminPage);
  await shell.goto(env.admin.baseUrl!);
  await shell.expectSessionActive();
  const manual = new ManualFiatDepositPage(adminPage);
  await manual.goto(env.admin.baseUrl!);
  await manual.openForm();
  await manual.fillForm({ email: source.email, displayName: source.displayName, amount: '1000', note: 'AUTO_SANDBOX_BROKER_PREFLIGHT_ONLY' });
  console.log('MANUAL_DEPOSIT_FORM ' + await manual.readSafeForm());
  const broker = new BrokerOpeningReviewPage(adminPage);
  await broker.goto(env.admin.baseUrl!);
  await broker.searchEmail(source.email);
  console.log('BROKER_ADMIN_PRECHECK ' + await broker.readSafeState());
  const client = await openPersonalJourneyClientSession({ browser, baseURL: env.client.baseUrl!, runId: sourceRunId,
    email: source.email, password: env.client.password!, otp: env.client.otp!, forceFreshLogin: true });
  try {
    const accounts = new AccountDetailPage(client.page);
    await accounts.goto(env.client.baseUrl!);
    const balance = await accounts.readSnapshot('香港账户', 'USD');
    console.log('BROKER_AH_BALANCE ' + JSON.stringify(balance));
    const securities = new SecuritiesTradingPage(client.page);
    await securities.goto(env.client.baseUrl!);
    console.log('BROKER_CARDS ' + JSON.stringify(await securities.readBrokerCards()));
    for (const brokerName of ['老虎证券', 'Webull 微牛证券']) {
      await securities.goto(env.client.baseUrl!);
      await securities.openApplication(brokerName);
      const opening = new BrokerOpeningPage(client.page);
      if (brokerName === 'Webull 微牛证券') await opening.continueWebullToDocuments();
      console.log('BROKER_APPLICATION ' + brokerName + ' ' + maskSensitiveText(await client.page.locator('body').ariaSnapshot()));
    }
  } finally {
    await client.context.close();
  }
});
