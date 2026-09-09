import { test as base, expect } from './registration.fixture';
import { env } from '../src/config/env';
import { assertSandboxEnvironment } from '../src/flow-engine';
import { PersonalPostRegistrationJourneyStore } from '../src/journey';
import { openPersonalJourneyClientSession } from '../src/registration';
import { DigitalAddressPage } from '../pages/client/DigitalAddressPage';
import { AdminWhitelistReviewPage } from '../pages/admin/AdminWhitelistReviewPage';
import { AdminShellPage } from '../pages/admin/AdminShellPage';
import { RegistrationKycStatusPage } from '../pages/client/RegistrationKycStatusPage';

type Session = { client: DigitalAddressPage; admin: AdminWhitelistReviewPage; expectNoWrites(): void };
export const test = base.extend<{ digitalAddress: Session }>({
  digitalAddress: async ({ browser, adminPage }, use) => {
    expect(env.allowClientMutationTests || env.allowAdminMutationTests || env.exchange.allowMoneyTests).toBe(false);
    assertSandboxEnvironment(env.admin.baseUrl);
    assertSandboxEnvironment(env.client.baseUrl);
    const sourceRunId = process.env.DIGITAL_ADDRESS_SOURCE_RUN_ID;
    if (!sourceRunId) throw new Error('Existing DIGITAL_ADDRESS_SOURCE_RUN_ID required; no new user.');
    const source = new PersonalPostRegistrationJourneyStore(sourceRunId).load();
    if (!source || source.stage !== 'COMPLETED') throw new Error('Existing approved Journey required.');
    const shell = new AdminShellPage(adminPage);
    await shell.goto(env.admin.baseUrl!);
    await shell.expectSessionActive();
    const client = await openPersonalJourneyClientSession({ browser, baseURL: env.client.baseUrl!, runId: sourceRunId,
      email: source.email, password: env.client.password!, otp: env.client.otp!, forceFreshLogin: true });
    let blockedWrites = 0;
    const paths = /\/wallet-whitelist-(add|update|delete|toggle-status)$|\/walletWhitelist\/(approve|reject)$/;
    const block = async (route: import('@playwright/test').Route) => { blockedWrites++; await route.abort('blockedbyclient'); };
    await client.page.route(url => paths.test(url.pathname), block);
    await adminPage.route(url => paths.test(url.pathname), block);
    const expectNoWrites = () => expect(blockedWrites, 'Safe test attempted a prohibited address write').toBe(0);
    try {
      await new RegistrationKycStatusPage(client.page).expectApproved({ ...source, runId: sourceRunId }, env.client.baseUrl!);
      await use({ client: new DigitalAddressPage(client.page), admin: new AdminWhitelistReviewPage(adminPage), expectNoWrites });
      expectNoWrites();
    } finally { await client.context.close(); }
  }
});
export { expect };
