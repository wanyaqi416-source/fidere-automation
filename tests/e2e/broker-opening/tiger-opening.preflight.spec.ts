import { test, expect } from '../../../fixtures/registration.fixture';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { BrokerOpeningReviewPage } from '../../../pages/admin/BrokerOpeningReviewPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { BrokerOpeningPage } from '../../../pages/client/BrokerOpeningPage';
import { SecuritiesTradingPage } from '../../../pages/client/SecuritiesTradingPage';
import { RegistrationKycStatusPage } from '../../../pages/client/RegistrationKycStatusPage';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment } from '../../../src/flow-engine';
import { PersonalPostRegistrationJourneyStore } from '../../../src/journey';
import { openPersonalJourneyClientSession } from '../../../src/registration';
import { Decimal } from '../../../src/utils/money';
import { matchTigerOpening } from '../../../src/journey/tiger-opening';
import { requireExactlyOneCandidate } from '../../../src/flow-engine';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });
test('老虎证券开户专项只读预检 @readonly @L2', async ({ browser, adminPage, business }) => {
  test.setTimeout(180_000);
  assertSandboxEnvironment(env.client.baseUrl);
  assertSandboxEnvironment(env.admin.baseUrl);
  expect(env.exchange.allowMoneyTests || env.allowAdminMutationTests).toBe(false);
  const sourceRunId = process.env.BROKER_SOURCE_RUN_ID;
  if (!sourceRunId) throw new Error('Existing Journey source required.');
  const source = new PersonalPostRegistrationJourneyStore(sourceRunId).load();
  if (!source || source.stage !== 'COMPLETED') throw new Error('Existing completed Journey required.');
  business.flow('account-opening-dry-run', { caseId: 'TIGER-PREFLIGHT', name: '原用户老虎证券开户只读预检' });
  const shell = new AdminShellPage(adminPage);
  await shell.goto(env.admin.baseUrl!);
  await shell.expectSessionActive();
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
  const client = await openPersonalJourneyClientSession({ browser, baseURL: env.client.baseUrl!, runId: sourceRunId,
    email: source.email, password: env.client.password!, otp: env.client.otp!, forceFreshLogin: true });
  try {
    await new RegistrationKycStatusPage(client.page).expectApproved({ ...source, runId: sourceRunId }, env.client.baseUrl!);
    const accounts = new AccountDetailPage(client.page);
    await accounts.goto(env.client.baseUrl!);
    const balance = await accounts.readSnapshot('香港账户', 'USD');
    console.log('TIGER_BALANCE ' + JSON.stringify(balance));
    const securities = new SecuritiesTradingPage(client.page);
    await securities.goto(env.client.baseUrl!);
    const tiger = (await securities.readBrokerCards()).filter(card => card.name === '老虎证券');
    expect(tiger).toHaveLength(1);
    console.log('TIGER_CARD ' + JSON.stringify(tiger[0]));
    expect(tiger[0].status).toBe('待开户');
    await securities.openApplication('老虎证券');
    const opening = new BrokerOpeningPage(client.page);
    const fee = await opening.readFee();
    expect(fee.currency).toBe('USD');
    expect(new Decimal(balance.available).greaterThan(fee.amount)).toBe(true);
    console.log('TIGER_FEE_FORM ' + await opening.readSafeState());
    business.setBusinessData({ sourceRunId, registrationTestName: source.displayName, beforeAvailableBalance: balance.available,
      openingFeeAmount: fee.amount, currency: fee.currency, confirmationClicks: 0, approvalClicks: 0 });
  } finally { await client.context.close(); }
});
