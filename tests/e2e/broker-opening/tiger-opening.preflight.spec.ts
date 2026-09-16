import { test, expect } from '../../../fixtures/registration.fixture';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { BrokerOpeningReviewPage } from '../../../pages/admin/BrokerOpeningReviewPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { BrokerOpeningPage } from '../../../pages/client/BrokerOpeningPage';
import { SecuritiesTradingPage } from '../../../pages/client/SecuritiesTradingPage';
import { RegistrationKycStatusPage } from '../../../pages/client/RegistrationKycStatusPage';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment } from '../../../src/flow-engine';
import { openPersonalJourneyClientSession } from '../../../src/registration';
import { Decimal } from '../../../src/utils/money';
import { matchTigerOpening } from '../../../src/journey/tiger-opening';
import { requireExactlyOneCandidate } from '../../../src/flow-engine';
import { resolveTigerOpeningUser } from '../../../src/broker-opening/tiger-runtime-user';
import { evaluateTigerPreflight } from '../../../scripts/launcher-tiger-run';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });
test('老虎证券开户专项只读预检 @readonly @L2', async ({ browser, adminPage, business }) => {
  test.setTimeout(180_000);
  assertSandboxEnvironment(env.client.baseUrl);
  assertSandboxEnvironment(env.admin.baseUrl);
  expect(env.exchange.allowMoneyTests || env.allowAdminMutationTests).toBe(false);
  const sourceRunId = process.env.BROKER_SOURCE_RUN_ID;
  const runtimeEmail = process.env.TIGER_TEST_EMAIL?.trim().toLowerCase();
  if (!sourceRunId) throw new Error('Existing Journey source required.');
  business.flow('account-opening-dry-run', { caseId: 'TIGER-PREFLIGHT', name: '原用户老虎证券开户只读预检' });
  const shell = new AdminShellPage(adminPage);
  await shell.goto(env.admin.baseUrl!);
  await shell.expectSessionActive();
  const source = await resolveTigerOpeningUser({ adminPage, adminBaseUrl: env.admin.baseUrl!, sourceRunId, runtimeEmail });
  const admin = new BrokerOpeningReviewPage(adminPage);
  await admin.goto(env.admin.baseUrl!);
  if (process.env.BROKER_ADMIN_STRUCTURE_ONLY === 'true') {
    await admin.searchEmail('');
    console.log('BROKER_ROW_STRUCTURE ' + JSON.stringify((await admin.readRows()).map(({ customerText, ...row }) => ({
      ...row, customerHasEmail: /@/.test(customerText)
    }))));
    if (process.env.BROKER_RECON_REFERENCE) console.log('BROKER_PROCESS_CONTRACT ' + JSON.stringify(await admin.inspectProcess(process.env.BROKER_RECON_REFERENCE)));
    return;
  }
  await admin.searchEmail(source.email);
  console.log('TIGER_ADMIN_PREFLIGHT ' + await admin.readSafeState());
  if (process.env.BROKER_PREFLIGHT_EXISTING) {
    const matched = matchTigerOpening(await admin.collectRows(), { ...source, reference: process.env.BROKER_PREFLIGHT_EXISTING });
    const candidate = requireExactlyOneCandidate(matched.candidates, 'Existing Tiger application');
    await admin.verifyDetail(candidate, source);
    await admin.fillApprovalForm(candidate, 'AUTO_TIGER_PREFLIGHT_ONLY');
    console.log('TIGER_EXISTING_APPROVAL_FORM_READY ' + JSON.stringify({ candidateCount: 1, detailMatched: true, status: candidate.status, approvalClicks: admin.approvalClickCount() }));
    return;
  }
  const client = runtimeEmail
    ? await RegistrationKycStatusPage.cleanLogin({ browser, baseURL: env.client.baseUrl!, email: source.email,
      password: env.client.password!, otp: env.client.otp! })
    : await openPersonalJourneyClientSession({ browser, baseURL: env.client.baseUrl!, runId: sourceRunId,
      email: source.email, password: env.client.password!, otp: env.client.otp!, forceFreshLogin: true });
  const clientPage = 'statusPage' in client ? client.statusPage.page : client.page;
  try {
    await new RegistrationKycStatusPage(clientPage).expectApproved({ ...source, runId: sourceRunId }, env.client.baseUrl!);
    const accounts = new AccountDetailPage(clientPage);
    await accounts.goto(env.client.baseUrl!);
    const balance = await accounts.readSnapshot('香港账户', 'USD');
    console.log('TIGER_BALANCE ' + JSON.stringify(balance));
    const securities = new SecuritiesTradingPage(clientPage);
    await securities.goto(env.client.baseUrl!);
    const tiger = (await securities.readBrokerCards()).filter(card => card.name === '老虎证券');
    expect(tiger).toHaveLength(1);
    console.log('TIGER_CARD ' + JSON.stringify(tiger[0]));
    if (/^(?:已开通|已开户)$/.test(tiger[0].status)) {
      console.log('TIGER_MENU_PREFLIGHT ' + JSON.stringify(evaluateTigerPreflight({
        email: source.email,
        brokerStatus: tiger[0].status,
        currentBalance: balance.available,
        requiredBalance: tiger[0].openingFee
      })));
      return;
    }
    if (tiger[0].status !== '待开户') {
      console.log('TIGER_MENU_PREFLIGHT ' + JSON.stringify(evaluateTigerPreflight({
        email: source.email,
        brokerStatus: tiger[0].status,
        currentBalance: balance.available,
        requiredBalance: tiger[0].openingFee
      })));
      return;
    }
    await securities.openApplication('老虎证券');
    const opening = new BrokerOpeningPage(clientPage);
    const fee = await opening.readFee();
    expect(fee.currency).toBe('USD');
    const result = evaluateTigerPreflight({ email: source.email, brokerStatus: tiger[0].status,
      currentBalance: balance.available, requiredBalance: fee.amount });
    console.log('TIGER_MENU_PREFLIGHT ' + JSON.stringify(result));
    console.log('TIGER_FEE_FORM ' + await opening.readSafeState());
    business.setBusinessData({ sourceRunId, registrationTestName: source.displayName, beforeAvailableBalance: balance.available,
      openingFeeAmount: fee.amount, currency: fee.currency, confirmationClicks: 0, approvalClicks: 0 });
  } finally { await client.context.close(); }
});
