import { test, expect } from '../../../fixtures/registration.fixture';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { BrokerOpeningReviewPage } from '../../../pages/admin/BrokerOpeningReviewPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { BrokerOpeningPage } from '../../../pages/client/BrokerOpeningPage';
import { RegistrationKycStatusPage } from '../../../pages/client/RegistrationKycStatusPage';
import { SecuritiesTradingPage } from '../../../pages/client/SecuritiesTradingPage';
import { resolveTigerOpeningUser } from '../../../src/broker-opening/tiger-runtime-user';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment } from '../../../src/flow-engine';
import { WEBULL_BROKER_NAME } from '../../../src/journey/webull-opening';
import { matchWebullOpening } from '../../../src/journey/tiger-opening';
import { readWebullSigningResult, WEBULL_DOCUMENTS, type WebullDocumentId } from '../../../src/journey/webull-opening';
import { WebullOpeningPage } from '../../../pages/client/WebullOpeningPage';
import { evaluateWebullPreflight } from '../../../scripts/launcher-webull-run';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });

function signingEnvelopeShape(body: unknown): unknown {
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 6) return 'max-depth';
    if (Array.isArray(value)) return value.slice(0, 3).map(item => visit(item, depth + 1));
    if (!value || typeof value !== 'object') return typeof value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      key === 'signed' && typeof nested === 'boolean' ? nested : visit(nested, depth + 1)
    ]));
  };
  return visit(body, 0);
}

test('Webull standalone read-only preflight @readonly @L2', async ({ browser, adminPage, business }) => {
  test.setTimeout(180_000);
  assertSandboxEnvironment(env.client.baseUrl);
  assertSandboxEnvironment(env.admin.baseUrl);
  expect(env.exchange.allowMoneyTests || env.allowAdminMutationTests
    || process.env.ALLOW_CLIENT_MUTATION_TESTS === 'true').toBe(false);
  const sourceRunId = process.env.BROKER_SOURCE_RUN_ID;
  const runtimeEmail = process.env.WEBULL_TEST_EMAIL?.trim().toLowerCase();
  if (!sourceRunId || !runtimeEmail) throw new Error('WEBULL_PREFLIGHT_RUNTIME_USER_REQUIRED');

  business.flow('webull-broker-opening-dry-run', {
    caseId: 'WEBULL-PREFLIGHT',
    name: '微牛证券开户只读预检'
  });
  const shell = new AdminShellPage(adminPage);
  await shell.goto(env.admin.baseUrl!);
  await shell.expectSessionActive();
  const source = await resolveTigerOpeningUser({
    adminPage,
    adminBaseUrl: env.admin.baseUrl!,
    sourceRunId,
    runtimeEmail
  });
  const admin = new BrokerOpeningReviewPage(adminPage);
  await admin.goto(env.admin.baseUrl!);
  await admin.searchEmail(source.email);
  const adminRows = await admin.collectRows();
  const adminMatch = matchWebullOpening(adminRows, source);
  console.log('WEBULL_ADMIN_PREFLIGHT ' + JSON.stringify({
    rowCount: adminRows.length,
    candidateCount: adminMatch.candidates.length,
    stages: adminMatch.stages
  }));
  const client = await RegistrationKycStatusPage.cleanLogin({
    browser,
    baseURL: env.client.baseUrl!,
    email: source.email,
    password: env.client.password!,
    otp: env.client.otp!
  });
  try {
    await new RegistrationKycStatusPage(client.statusPage.page)
      .expectApproved({ ...source, runId: sourceRunId }, env.client.baseUrl!);
    const accounts = new AccountDetailPage(client.statusPage.page);
    await accounts.goto(env.client.baseUrl!);
    const balance = await accounts.readSnapshot('香港账户', 'USD');
    const securities = new SecuritiesTradingPage(client.statusPage.page);
    await securities.goto(env.client.baseUrl!);
    const cards = (await securities.readBrokerCards()).filter(card => card.name === WEBULL_BROKER_NAME);
    expect(cards).toHaveLength(1);
    const card = cards[0];
    if (/^(?:已开通|已开户)$/.test(card.status) || card.status !== '待开户') {
      console.log('WEBULL_MENU_PREFLIGHT ' + JSON.stringify(evaluateWebullPreflight({
        email: source.email,
        brokerStatus: card.status,
        currentBalance: balance.available,
        requiredBalance: card.openingFee
      })));
      return;
    }
    await securities.openApplication(WEBULL_BROKER_NAME);
    const brokerOpening = new BrokerOpeningPage(client.statusPage.page);
    const fee = await brokerOpening.readFee();
    expect(fee.currency).toBe('USD');
    const result = evaluateWebullPreflight({
      email: source.email,
      brokerStatus: card.status,
      currentBalance: balance.available,
      requiredBalance: fee.amount
    });
    console.log('WEBULL_MENU_PREFLIGHT ' + JSON.stringify(result));
    await brokerOpening.continueWebullToDocuments();
    const webull = new WebullOpeningPage(client.statusPage.page);
    const documentStates = [];
    for (const document of WEBULL_DOCUMENTS) documentStates.push(await webull.readDocumentState(document.id));
    console.log('WEBULL_DOCUMENT_STATES ' + JSON.stringify(documentStates));
    const inspectDocument = process.env.WEBULL_INSPECT_DOCUMENT as WebullDocumentId | undefined;
    if (inspectDocument) {
      if (!WEBULL_DOCUMENTS.some(document => document.id === inspectDocument)) {
        throw new Error('WEBULL_INSPECT_DOCUMENT_INVALID');
      }
      const entry = await webull.signingEntry(inspectDocument);
      const [response] = await Promise.all([
        client.statusPage.page.waitForResponse(candidate =>
          new URL(candidate.url()).pathname.endsWith('/brokerage/init-sign')
          && candidate.request().method() === 'POST', { timeout: 30_000 }),
        entry.click()
      ]);
      const body = await response.json();
      const result = readWebullSigningResult(body);
      await expect.poll(async () => client.statusPage.page.frames()
        .filter(frame => /^https:\/\/app\.documenso\.com\//.test(frame.url())).length
        + await client.statusPage.page.getByRole('dialog').count(),
      { timeout: 30_000 }).toBeGreaterThan(0);
      const providerFrame = client.statusPage.page.frames()
        .find(frame => /^https:\/\/app\.documenso\.com\//.test(frame.url()));
      const visibleDialogs = [];
      for (const dialog of await client.statusPage.page.getByRole('dialog').all()) {
        if (!await dialog.isVisible()) continue;
        visibleDialogs.push({
          text: (await dialog.innerText()).replace(/\s+/g, ' ').trim().slice(0, 500),
          buttons: await dialog.getByRole('button').allTextContents()
        });
      }
      const provider = providerFrame ? {
        framePresent: true,
        remaining: await providerFrame.getByText(/^\d+ Fields? Remaining$/i).allTextContents(),
        completeButtons: await providerFrame.getByRole('button', { name: 'Complete', exact: true }).count(),
        signButtons: await providerFrame.getByRole('button', { name: /^(Sign|签署)$/ }).count(),
        completionTextPresent: await providerFrame.getByText(/document.*completed|文档.*完成/i).count()
      } : { framePresent: false };
      console.log('WEBULL_INIT_SIGN_DIAGNOSTIC ' + JSON.stringify({
        document: inspectDocument,
        httpStatus: response.status(),
        result,
        envelopeShape: signingEnvelopeShape(body),
        provider,
        visibleDialogs
      }));
    }
    business.setBusinessData({
      sourceRunId,
      registrationTestName: source.displayName,
      beforeAvailableBalance: balance.available,
      openingFeeAmount: fee.amount,
      currency: fee.currency,
      confirmationClicks: 0,
      approvalClicks: 0
    });
  } finally {
    await client.context.close();
  }
});
