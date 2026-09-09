import { test, expect } from '../../../fixtures/registration.fixture';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { HomePage } from '../../../pages/client/HomePage';
import { Navigation } from '../../../pages/client/Navigation';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment } from '../../../src/flow-engine';
import {
  maskRegistrationEmail,
  openPersonalJourneyClientSession,
  PersonalJourneyContextStore
} from '../../../src/registration';

test.describe.configure({ mode: 'serial', retries: 0 });

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for Trust Beneficiary Recon.`);
  return value;
}

async function visibleTexts(locators: import('@playwright/test').Locator[]): Promise<string[]> {
  const values: string[] = [];
  for (const locator of locators) {
    if (await locator.isVisible().catch(() => false)) {
      const value = ((await locator.getAttribute('aria-label')) ??
        (await locator.getAttribute('placeholder')) ??
        (await locator.innerText().catch(() => ''))).trim();
      if (value && !values.includes(value)) values.push(value);
    }
  }
  return values;
}

test('TRUST-BEN-RECON 信托受益人双端只读页面勘察', { tag: ['@trust', '@beneficiary', '@readonly', '@recon'] }, async ({ browser, adminPage }) => {
  test.setTimeout(180_000);
  expect(env.allowClientMutationTests).toBe(false);
  expect(env.allowAdminMutationTests).toBe(false);
  const clientBaseUrl = required('CLIENT_BASE_URL', env.client.baseUrl);
  const adminBaseUrl = required('ADMIN_BASE_URL', env.admin.baseUrl);
  assertSandboxEnvironment(clientBaseUrl);
  assertSandboxEnvironment(adminBaseUrl);
  const sourceRunId = env.personalRegistration.adminApprovalSourceRunId ?? 'REGP-20260904020924';
  const source = new PersonalJourneyContextStore().load(sourceRunId);
  if (!source?.displayName || !source.email || source.stage !== 'COMPLETED') {
    throw new Error('A completed Personal Journey source is required; never create a new user or trust.');
  }
  const client = await openPersonalJourneyClientSession({
    browser, baseURL: clientBaseUrl, runId: sourceRunId, email: source.email,
    password: required('CLIENT_PASSWORD', env.client.password), otp: required('CLIENT_OTP', env.client.otp)
  });
  try {
    const home = new HomePage(client.page);
    await home.gotoDashboard(clientBaseUrl);
    await new Navigation(client.page).open('trust');
    await expect(client.page).toHaveURL(/\/trust(?:$|[?#])/);
    await expect(client.page.getByRole('heading', { name: '信托信息' })).toBeVisible();
    const addBeneficiary = client.page.getByRole('button', { name: /添加受益人|新增受益人/ }).first();
    await expect(addBeneficiary).toBeVisible();
    const clientSummary = {
      user: source.displayName,
      email: maskRegistrationEmail(source.email),
      headings: await visibleTexts(await client.page.getByRole('heading').all()),
      buttons: await visibleTexts(await client.page.getByRole('button').all()),
      tabs: await visibleTexts(await client.page.getByRole('tab').all())
    };
    console.log(`TRUST_BEN_CLIENT_PAGE=${JSON.stringify(clientSummary)}`);
    await addBeneficiary.click();
    const form = client.page.getByRole('dialog').filter({ hasText: /受益人/ }).last();
    await expect(form).toBeVisible();
    console.log(`TRUST_BEN_CLIENT_FORM=${JSON.stringify({
      headings: await visibleTexts(await form.getByRole('heading').all()),
      buttons: await visibleTexts(await form.getByRole('button').all()),
      textboxes: await visibleTexts(await form.getByRole('textbox').all()),
      comboboxes: await visibleTexts(await form.getByRole('combobox').all()),
      spinbuttons: await visibleTexts(await form.getByRole('spinbutton').all()),
      labels: (await form.locator('label').allTextContents()).map(value => value.trim()).filter(Boolean)
    })}`);
    const controlStructure = await form.locator('input').evaluateAll(inputs => inputs.map(element => {
      const input = element as HTMLInputElement;
      return ({
      type: input.type,
      name: input.getAttribute('name'),
      placeholder: input.getAttribute('placeholder'),
      role: input.getAttribute('role'),
      ariaLabel: input.getAttribute('aria-label')
    }); }));
    console.log(`TRUST_BEN_CLIENT_CONTROLS=${JSON.stringify(controlStructure)}`);
    const optionSets: string[][] = [];
    for (const combobox of await form.getByRole('combobox').all()) {
      await combobox.click();
      const options = await client.page.getByRole('option').allTextContents();
      optionSets.push(options.map(value => value.trim()).filter(Boolean));
      await client.page.keyboard.press('Escape');
    }
    console.log(`TRUST_BEN_CLIENT_OPTIONS=${JSON.stringify(optionSets)}`);

    const adminShell = new AdminShellPage(adminPage);
    await adminShell.goto(adminBaseUrl);
    await adminShell.expectSessionActive();
    await adminPage.goto(new URL('/zh-CN/kyc/trust', adminBaseUrl).toString(), { waitUntil: 'domcontentloaded' });
    await expect(adminPage).not.toHaveURL(/\/login|\/signin|\/sign-in/i);
    await expect(adminPage.getByText('信托管理', { exact: true }).first()).toBeVisible();
    console.log(`TRUST_BEN_ADMIN_LIST=${JSON.stringify({
      inputs: await visibleTexts(await adminPage.getByRole('textbox').all()),
      tabs: await visibleTexts(await adminPage.getByRole('tab').all()),
      headers: (await adminPage.getByRole('columnheader').allTextContents()).map(value => value.trim()).filter(Boolean),
      buttons: await visibleTexts(await adminPage.getByRole('button').all())
    })}`);
    const search = adminPage.getByRole('textbox').first();
    await expect(search).toBeVisible();
    await search.fill(source.email);
    await search.press('Enter');
    const userRows = adminPage.getByRole('row').filter({ hasText: source.email });
    await expect.poll(() => userRows.count(), { timeout: 20_000 }).toBe(1);
    const row = userRows.first();
    const details = row.getByRole('button', { name: /查看详情|详情/ }).first();
    await expect(details).toBeVisible();
    await details.click();
    await expect(adminPage).not.toHaveURL(/\/kyc\/trust$/);
    console.log(`TRUST_BEN_ADMIN_DETAIL=${JSON.stringify({
      headings: await visibleTexts(await adminPage.getByRole('heading').all()),
      tabs: await visibleTexts(await adminPage.getByRole('tab').all()),
      buttons: await visibleTexts(await adminPage.getByRole('button').all()),
      labels: (await adminPage.locator('label').allTextContents()).map(value => value.trim()).filter(Boolean)
    })}`);
    const beneficiaryTab = adminPage.getByRole('tab', { name: /受益人管理|受益人/ }).first();
    await expect(beneficiaryTab).toBeVisible();
    await beneficiaryTab.click();
    console.log(`TRUST_BEN_ADMIN_TAB=${JSON.stringify({
      headers: (await adminPage.getByRole('columnheader').allTextContents()).map(value => value.trim()).filter(Boolean),
      buttons: await visibleTexts(await adminPage.getByRole('button').all()),
      text: (await adminPage.locator('main').innerText().catch(() => '')).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+/gi, '[MASKED_EMAIL]').replace(/\b\d{6,}\b/g, '[MASKED_NUMBER]').slice(0, 2500)
    })}`);
  } finally {
    await client.context.close();
  }
});
