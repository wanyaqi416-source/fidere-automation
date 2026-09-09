import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { AccountTypeSelectionPage } from '../../../pages/client/AccountTypeSelectionPage';
import { CorporateRegistrationPage } from '../../../pages/client/CorporateRegistrationPage';
import { PersonalRegistrationPage } from '../../../pages/client/PersonalRegistrationPage';
import { env } from '../../../src/config/env';
import {
  corporateAuthPath,
  loadCorporateDraft,
  saveCorporateDraft
} from '../../../src/registration';
import { ensureCorporateDraftAuthentication } from './corporate-registration.helpers';

const reconOutputPath = path.resolve('.tmp/corporate-recon/recon-initial.json');

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for Corporate Registration Recon.`);
  return value;
}

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'REG-C-001 Corporate Registration initial Recon @registration @corporate @recon @L3',
  async ({ browser }) => {
    const clientBaseUrl = required('CLIENT_BASE_URL', env.client.baseUrl);
    const email = required('CORPORATE_REGISTRATION_EMAIL', env.corporateRegistration.email);
    const password = required('CLIENT_PASSWORD', env.client.password);
    const otp = required('CLIENT_REGISTER_OTP', env.personalRegistration.otp);
    const existingDraft = loadCorporateDraft();

    if (existingDraft && existingDraft.email !== email) {
      throw new Error('A different Corporate Registration Draft already exists; refusing to create another account.');
    }

    const context = await browser.newContext({
      baseURL: clientBaseUrl,
      storageState: existingDraft ? corporateAuthPath : { cookies: [], origins: [] }
    });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const failedRequests: Array<{ method: string; path: string; failure: string }> = [];
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', request => {
      const url = new URL(request.url());
      failedRequests.push({
        method: request.method(),
        path: url.pathname,
        failure: request.failure()?.errorText ?? 'unknown'
      });
    });

    let draft = existingDraft;
    if (!draft) {
      if (!env.allowClientMutationTests) {
        throw new Error('ALLOW_CLIENT_MUTATION_TESTS=true is required only for the one-time Corporate Draft account creation.');
      }

      const registration = new PersonalRegistrationPage(page);
      await registration.goto(clientBaseUrl);
      await registration.fillEmail(email);
      await registration.requestVerificationCode();
      await registration.verifyEmail(otp);
      await registration.fillPassword(password);
      await registration.acceptVisibleAgreements();
      await registration.submitRegistration();
      await registration.expectAuthenticatedOnboarding();

      const createdAt = new Date().toISOString();
      draft = {
        schemaVersion: 1,
        runId: `REGC-${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}`,
        email,
        stage: 'ACCOUNT_CREATED',
        accountCreatedAt: createdAt,
        updatedAt: createdAt,
        currentUrl: page.url(),
        finalSubmissionCount: 0
      };
      saveCorporateDraft(draft);
      mkdirSync(path.dirname(corporateAuthPath), { recursive: true });
      await context.storageState({ path: corporateAuthPath });
    }

    if (/\/account-type-selection(?:$|[?#])/.test(new URL(page.url()).pathname)) {
      const accountType = new AccountTypeSelectionPage(page);
      await accountType.expectOpen();
      await accountType.selectCorporate();
      draft = {
        ...draft,
        stage: 'CORPORATE_SELECTED',
        updatedAt: new Date().toISOString(),
        currentUrl: page.url()
      };
      saveCorporateDraft(draft);
      await context.storageState({ path: corporateAuthPath });
    } else if (!/\/registration\?type=(?:corporate|company)/.test(page.url())) {
      const accountTypeUrl = new URL('/zh-CN/account-type-selection', clientBaseUrl).toString();
      await page.goto(accountTypeUrl, {
        waitUntil: 'domcontentloaded'
      });
      await ensureCorporateDraftAuthentication({
        page,
        context,
        email,
        returnUrl: accountTypeUrl
      });
      const accountType = new AccountTypeSelectionPage(page);
      await accountType.expectOpen();
      await accountType.selectCorporate();
    }

    const corporate = new CorporateRegistrationPage(page);
    await corporate.expectOpen();
    const snapshot = {
      url: page.url(),
      capturedAt: new Date().toISOString(),
      bodyText: await corporate.visibleText(),
      controls: await corporate.inspectControls(),
      uploads: await corporate.inspectUploads(),
      consoleErrors,
      failedRequests
    };

    const domScriptUrls = await page.locator('script[src]').evaluateAll(elements =>
      elements
        .map(element => (element as HTMLScriptElement).src)
        .filter(Boolean)
    );
    const resourceUrls = await page.evaluate(() =>
      performance.getEntriesByType('resource').map(entry => entry.name)
    );
    const scriptUrls = [...new Set([...domScriptUrls, ...resourceUrls.filter(url => url.endsWith('.js'))])];
    const registrationScripts = scriptUrls.filter(scriptUrl =>
      /registration|page-[a-f0-9]+\.js/i.test(decodeURIComponent(scriptUrl))
    );
    const sourceDirectory = path.resolve('.tmp/corporate-recon/chunks');
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(
      path.join(sourceDirectory, 'script-urls.json'),
      `${JSON.stringify(scriptUrls, null, 2)}\n`,
      'utf8'
    );
    for (const [index, scriptUrl] of registrationScripts.entries()) {
      const response = await context.request.get(scriptUrl);
      if (!response.ok()) continue;
      writeFileSync(
        path.join(sourceDirectory, `registration-${index + 1}.js`),
        await response.body()
      );
    }

    mkdirSync(path.dirname(reconOutputPath), { recursive: true });
    writeFileSync(reconOutputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    await test.info().attach('corporate-registration-initial-recon', {
      body: Buffer.from(JSON.stringify(snapshot, null, 2)),
      contentType: 'application/json'
    });

    saveCorporateDraft({
      ...draft,
      stage: 'RECON_IN_PROGRESS',
      updatedAt: new Date().toISOString(),
      currentUrl: page.url(),
      finalSubmissionCount: 0
    });
    await context.storageState({ path: corporateAuthPath });
    await page.screenshot({
      path: path.resolve('.tmp/corporate-recon/recon-initial.png'),
      fullPage: true
    });
    await corporate.expectNoFinalSubmission();
    await expect(page).not.toHaveURL(/\/dashboard(?:$|[?#])/);
    await context.close();
  }
);
