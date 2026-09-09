import { expect, test } from '../../../fixtures/registration.fixture';
import { env } from '../../../src/config/env';
import {
  openPersonalJourneyClientSession,
  PersonalJourneyContextStore
} from '../../../src/registration';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { AdminClientUsersPage } from '../../../pages/admin/AdminClientUsersPage';
import { AdminFiatAccountReviewPage } from '../../../pages/admin/AdminFiatAccountReviewPage';
import { BankAccountManagementPage } from '../../../pages/client/BankAccountManagementPage';
import { LoginPage } from '../../../pages/client/LoginPage';
import { clientRouteUrl } from '../../../pages/client/HomePage';

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for the Personal Golden Journey preflight.`);
  return value;
}

test('Personal Golden Journey 客户端法币地址入口只读预检', async ({ browser }) => {
  const journey = new PersonalJourneyContextStore().list().find(candidate =>
    candidate.runId === (env.personalRegistration.adminApprovalSourceRunId ?? 'REGP-20260904020924')
  );
  if (!journey) throw new Error('The approved Personal Journey Context was not found.');

  const session = await openPersonalJourneyClientSession({
    browser,
    baseURL: required('CLIENT_BASE_URL', env.client.baseUrl),
    runId: journey.runId,
    email: journey.email,
    password: required('CLIENT_PASSWORD', env.client.password),
    otp: required('CLIENT_OTP', env.client.otp)
  });
  try {
    const links = await session.page.getByRole('link').evaluateAll(elements =>
      elements.map(element => ({
        text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
        href: element.getAttribute('href') ?? ''
      })).filter(item => item.text || item.href)
    );
    const buttons = await session.page.getByRole('button').allInnerTexts();
    console.log(`PERSONAL_GOLDEN_CLIENT_NAV=${JSON.stringify({ links, buttons })}`);
    await expect(session.page.getByText('总资产', { exact: true })).toBeVisible();
  } finally {
    await session.context.close();
  }
});

test('Personal Golden Journey Admin KYC状态只读诊断', async ({ adminPage }) => {
  const adminBaseUrl = required('ADMIN_BASE_URL', env.admin.baseUrl);
  await new AdminShellPage(adminPage).goto(adminBaseUrl);
  await adminPage.goto(new URL('/zh-CN/kyc/processingReviews', adminBaseUrl).toString(), {
    waitUntil: 'domcontentloaded'
  });
  await expect(adminPage).not.toHaveURL(/\/login|\/signin|\/sign-in/i);
  await expect(adminPage.locator('main')).toBeVisible();

  const targetName = 'TEST SANDBOX AH';
  const rows = await adminPage.locator('tbody tr').evaluateAll((elements, name) =>
    elements.map(element => (element.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(text => text.includes(name as string)),
    targetName
  );
  const links = await adminPage.getByRole('link').evaluateAll((elements, name) =>
    elements.map(element => ({
      text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
      href: element.getAttribute('href') ?? ''
    })).filter(item => item.text.includes(name as string) || item.href.includes('277')),
    targetName
  );
  console.log(`PERSONAL_GOLDEN_ADMIN_KYC=${JSON.stringify({ targetName, rows, links })}`);
});

test('Personal Golden Journey Admin KYC处理页只读诊断', async ({ adminPage }) => {
  const adminBaseUrl = required('ADMIN_BASE_URL', env.admin.baseUrl);
  const targetName = 'TEST SANDBOX AH';
  await adminPage.goto(new URL('/zh-CN/kyc/processingReviews', adminBaseUrl).toString(), {
    waitUntil: 'domcontentloaded'
  });
  await expect(adminPage).not.toHaveURL(/\/login|\/signin|\/sign-in/i);
  const row = adminPage.locator('tbody tr').filter({ hasText: targetName });
  await expect(row).toHaveCount(1);
  const processLink = row.getByRole('link', { name: '开始处理', exact: true });
  const processHref = await processLink.getAttribute('href');
  if (!processHref) throw new Error('The active KYC review does not expose its process URL.');
  await adminPage.goto(new URL(processHref, adminBaseUrl).toString(), { waitUntil: 'domcontentloaded' });
  await expect(adminPage.locator('main')).toBeVisible();

  const headings = await adminPage.getByRole('heading').allInnerTexts();
  const buttons = await adminPage.getByRole('button').allInnerTexts();
  const tabs = await adminPage.getByRole('tab').allInnerTexts();
  const inputs = await adminPage.locator('input, textarea, [role="combobox"]').evaluateAll(elements =>
    elements.map(element => ({
      tag: element.tagName.toLowerCase(),
      name: element.getAttribute('name') ?? '',
      placeholder: element.getAttribute('placeholder') ?? '',
      ariaLabel: element.getAttribute('aria-label') ?? '',
      disabled: element.hasAttribute('disabled')
    }))
  );
  console.log(`PERSONAL_GOLDEN_ADMIN_PROCESS=${JSON.stringify({ headings, buttons, tabs, inputs })}`);
});

test('Personal Golden Journey Admin文档审核控件只读诊断', async ({ adminPage }) => {
  const adminBaseUrl = required('ADMIN_BASE_URL', env.admin.baseUrl);
  const targetName = 'TEST SANDBOX AH';
  await adminPage.goto(new URL('/zh-CN/kyc/processingReviews', adminBaseUrl).toString(), {
    waitUntil: 'domcontentloaded'
  });
  const row = adminPage.locator('tbody tr').filter({ hasText: targetName });
  await expect(row).toHaveCount(1);
  const processHref = await row.getByRole('link', { name: '开始处理', exact: true }).getAttribute('href');
  if (!processHref) throw new Error('The active KYC review does not expose its process URL.');
  await adminPage.goto(new URL(processHref, adminBaseUrl).toString(), { waitUntil: 'domcontentloaded' });

  const viewDocument = adminPage.getByRole('button', { name: '查看文档', exact: true });
  await expect(viewDocument).toBeVisible();
  await viewDocument.click();
  const dialog = adminPage.getByRole('dialog').last();
  await expect(dialog).toBeVisible();
  const text = (await dialog.innerText())
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[masked-email]')
    .replace(/\b\d{7,}\b/g, '[masked-number]');
  const buttons = await dialog.getByRole('button').allInnerTexts();
  const comboboxes = await dialog.getByRole('combobox').count();
  const textareas = await dialog.locator('textarea').evaluateAll(elements =>
    elements.map(element => ({
      placeholder: element.getAttribute('placeholder') ?? '',
      disabled: element.hasAttribute('disabled')
    }))
  );
  console.log(`PERSONAL_GOLDEN_DOCUMENT_REVIEW=${JSON.stringify({ text, buttons, comboboxes, textareas })}`);
});

test('Personal Golden Journey Admin KYC接口只读诊断', async ({ adminPage }) => {
  const adminBaseUrl = required('ADMIN_BASE_URL', env.admin.baseUrl);
  const targetName = 'TEST SANDBOX AH';
  await adminPage.goto(new URL('/zh-CN/kyc/processingReviews', adminBaseUrl).toString(), {
    waitUntil: 'domcontentloaded'
  });
  const row = adminPage.locator('tbody tr').filter({ hasText: targetName });
  await expect(row).toHaveCount(1);
  const processHref = await row.getByRole('link', { name: '开始处理', exact: true }).getAttribute('href');
  if (!processHref) throw new Error('The active KYC review does not expose its process URL.');

  const observations: Array<{ method: string; path: string; status: number }> = [];
  const listener = (response: import('@playwright/test').Response) => {
    const url = new URL(response.url());
    if (url.origin !== new URL(adminBaseUrl).origin) return;
    if (!url.pathname.startsWith('/admin-api/')) return;
    observations.push({
      method: response.request().method(),
      path: url.pathname,
      status: response.status()
    });
  };
  adminPage.on('response', listener);
  const processResponsePromise = adminPage.waitForResponse(response =>
    new URL(response.url()).pathname === '/admin-api/operation/kyc/process',
    { timeout: 20_000 }
  );
  let processResponse: import('@playwright/test').Response | undefined;
  try {
    await adminPage.goto(new URL(processHref, adminBaseUrl).toString(), { waitUntil: 'networkidle' });
    processResponse = await processResponsePromise;
    await expect(adminPage.getByRole('heading', { name: '审核决定', exact: true })).toBeVisible();
  } finally {
    adminPage.off('response', listener);
  }
  const body = processResponse ? await processResponse.json().catch(() => undefined) : undefined;
  const safeStatusFields: Record<string, string | number | boolean | null> = {};
  const visit = (value: unknown, path: string, depth: number): void => {
    if (depth > 5 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.slice(0, 10).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (
        /status|state|progress|result|decision|review|audit|code|message|step|node|process|task/i.test(key) &&
        (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean' || child === null)
      ) {
        safeStatusFields[childPath] = child as string | number | boolean | null;
      }
      visit(child, childPath, depth + 1);
    }
  };
  visit(body, '', 0);
  console.log(`PERSONAL_GOLDEN_ADMIN_REVIEW_API=${JSON.stringify({ observations, safeStatusFields })}`);
});

test('Personal Golden Journey Admin已审核用户只读诊断', async ({ adminPage }) => {
  const adminBaseUrl = required('ADMIN_BASE_URL', env.admin.baseUrl);
  const source = new PersonalJourneyContextStore().load(
    env.personalRegistration.adminApprovalSourceRunId ?? 'REGP-20260904020924'
  );
  if (!source) throw new Error('The target Personal Journey was not found.');
  const users = new AdminClientUsersPage(adminPage);
  await users.goto(adminBaseUrl);
  await users.search(source.email);
  const matches = await users.matchingRows(source.email);
  const rows = matches.map(candidate => candidate.rowText
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[masked-email]')
    .replace(/\b\d{7,}\b/g, '[masked-number]'));
  console.log(`PERSONAL_GOLDEN_APPROVED_USER=${JSON.stringify({ candidateCount: matches.length, rows })}`);
});

test('Personal Golden Journey Admin审核日志只读诊断', async ({ adminPage }) => {
  const adminBaseUrl = required('ADMIN_BASE_URL', env.admin.baseUrl);
  await adminPage.goto(new URL('/zh-CN/kyc/auditLogs', adminBaseUrl).toString(), {
    waitUntil: 'domcontentloaded'
  });
  await expect(adminPage).not.toHaveURL(/\/login|\/signin|\/sign-in/i);
  await expect(adminPage.locator('main')).toBeVisible();
  const headers = await adminPage.getByRole('columnheader').allInnerTexts();
  const inputs = await adminPage.locator('input').evaluateAll(elements => elements.map(element => ({
    name: element.getAttribute('name') ?? '',
    placeholder: element.getAttribute('placeholder') ?? '',
    type: element.getAttribute('type') ?? ''
  })));
  const rows = (await adminPage.locator('tbody tr').allInnerTexts())
    .map(text => text.replace(/\s+/g, ' ').trim())
    .filter(text => text.includes('TEST SANDBOX AH') || text.includes('277'))
    .map(text => text
      .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[masked-email]')
      .replace(/\b\d{7,}\b/g, '[masked-number]'));
  console.log(`PERSONAL_GOLDEN_AUDIT_LOG=${JSON.stringify({ headers, inputs, rows })}`);
});

test('Personal Golden Journey Client KYC状态只读诊断', async ({ browser }) => {
  const clientBaseUrl = required('CLIENT_BASE_URL', env.client.baseUrl);
  const source = new PersonalJourneyContextStore().load('REGP-20260904020924');
  if (!source) throw new Error('The target Personal Journey was not found.');
  const context = await browser.newContext({
    baseURL: clientBaseUrl,
    storageState: { cookies: [], origins: [] }
  });
  const page = await context.newPage();
  const observations: Array<{ path: string; status: number; fields: Record<string, string | number | boolean | null> }> = [];
  const pendingBodies: Promise<void>[] = [];
  const listener = (response: import('@playwright/test').Response) => {
    const url = new URL(response.url());
    if (url.origin !== new URL(clientBaseUrl).origin || !url.pathname.startsWith('/api/')) return;
    if (!/(?:profile|member|kyc|status)/i.test(url.pathname)) return;
    pendingBodies.push((async () => {
      const body = await response.json().catch(() => undefined);
      const fields: Record<string, string | number | boolean | null> = {};
      const visit = (value: unknown, path: string, depth: number): void => {
        if (depth > 5 || value === null || value === undefined) return;
        if (Array.isArray(value)) {
          value.slice(0, 5).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
          return;
        }
        if (typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          const childPath = path ? `${path}.${key}` : key;
          if (
            /status|state|progress|result|review|code|message|step|authorization/i.test(key) &&
            (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean' || child === null)
          ) fields[childPath] = child as string | number | boolean | null;
          visit(child, childPath, depth + 1);
        }
      };
      visit(body, '', 0);
      observations.push({ path: url.pathname, status: response.status(), fields });
    })());
  };
  page.on('response', listener);
  try {
    const login = new LoginPage(page);
    await login.goto(clientRouteUrl(clientBaseUrl, 'login'));
    await login.fillCredentials({
      username: source.email,
      password: required('CLIENT_PASSWORD', env.client.password)
    });
    await login.submitCredentials();
    await login.expectOtpStep();
    await login.fillOtp(required('CLIENT_OTP', env.client.otp));
    await login.confirmLoginToAuthenticatedRoute();
    await page.goto(clientRouteUrl(clientBaseUrl, 'dashboard'), { waitUntil: 'networkidle' });
    await Promise.all(pendingBodies);
    const headings = await page.getByRole('heading').allInnerTexts();
    console.log(`PERSONAL_GOLDEN_CLIENT_KYC=${JSON.stringify({
      route: new URL(page.url()).pathname,
      headings,
      observations
    })}`);
  } finally {
    page.off('response', listener);
    await context.close();
  }
});

test('Personal Golden Journey 法币地址DOM只读诊断', async ({ browser }) => {
  const clientBaseUrl = required('CLIENT_BASE_URL', env.client.baseUrl);
  const source = new PersonalJourneyContextStore().load(
    env.personalRegistration.adminApprovalSourceRunId ?? 'REGP-20260904020924'
  );
  if (!source) throw new Error('The target Personal Journey was not found.');
  const session = await openPersonalJourneyClientSession({
    browser,
    baseURL: clientBaseUrl,
    runId: source.runId,
    email: source.email,
    password: required('CLIENT_PASSWORD', env.client.password),
    otp: required('CLIENT_OTP', env.client.otp)
  });
  const apiPaths = new Set<string>();
  const listener = (response: import('@playwright/test').Response) => {
    const url = new URL(response.url());
    if (url.origin === new URL(clientBaseUrl).origin && url.pathname.startsWith('/api/')) {
      apiPaths.add(`${response.request().method()} ${url.pathname} ${response.status()}`);
    }
  };
  session.page.on('response', listener);
  try {
    await session.page.goto(clientRouteUrl(clientBaseUrl, 'account-detail'), {
      waitUntil: 'networkidle'
    });
    const main = session.page.locator('main');
    await expect(main).toBeVisible();
    const headings = await main.getByRole('heading').allInnerTexts();
    const buttons = (await main.getByRole('button').allInnerTexts()).filter(Boolean);
    const links = await main.getByRole('link').evaluateAll(elements => elements.map(element => ({
      text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
      href: element.getAttribute('href') ?? ''
    })).filter(item => item.text || item.href));
    const controls = await main.locator('input, textarea, [role="combobox"]').evaluateAll(elements =>
      elements.map(element => ({
        role: element.getAttribute('role') ?? element.tagName.toLowerCase(),
        name: element.getAttribute('name') ?? '',
        placeholder: element.getAttribute('placeholder') ?? '',
        ariaLabel: element.getAttribute('aria-label') ?? '',
        disabled: element.hasAttribute('disabled')
      }))
    );
    console.log(`PERSONAL_GOLDEN_FIAT_ADDRESS_DOM=${JSON.stringify({
      route: new URL(session.page.url()).pathname,
      headings,
      buttons,
      links,
      controls,
      apiPaths: [...apiPaths]
    })}`);
  } finally {
    session.page.off('response', listener);
    await session.context.close();
  }
});

test('Personal Golden Journey 新增银行地址表单只读诊断', async ({ browser }) => {
  const clientBaseUrl = required('CLIENT_BASE_URL', env.client.baseUrl);
  const source = new PersonalJourneyContextStore().load(
    env.personalRegistration.adminApprovalSourceRunId ?? 'REGP-20260904020924'
  );
  if (!source) throw new Error('The target Personal Journey was not found.');
  const session = await openPersonalJourneyClientSession({
    browser,
    baseURL: clientBaseUrl,
    runId: source.runId,
    email: source.email,
    password: required('CLIENT_PASSWORD', env.client.password),
    otp: required('CLIENT_OTP', env.client.otp)
  });
  try {
    const url = new URL(clientRouteUrl(clientBaseUrl, 'account/transfer'));
    url.searchParams.set('mode', 'beneficiary');
    url.searchParams.set('fromAccountType', 'trust');
    await session.page.goto(url.toString(), { waitUntil: 'networkidle' });
    await expect(session.page.getByRole('heading', { name: '法币转出', exact: true })).toBeVisible();

    const addAddress = session.page.getByText('添加新的收款人信息', { exact: true });
    await expect(addAddress).toHaveCount(1);
    await addAddress.click();
    await expect.poll(async () => ({
      addAddressVisible: await addAddress.isVisible().catch(() => false),
      dialogCount: await session.page.getByRole('dialog').count(),
      route: new URL(session.page.url()).pathname
    }), {
      timeout: 10_000,
      intervals: [250, 500, 1_000],
      message: 'Waiting for the add-bank-address surface to settle.'
    }).not.toEqual({
      addAddressVisible: true,
      dialogCount: 0,
      route: '/zh-CN/account/transfer'
    });

    let visibleSurface = session.page.getByRole('dialog').last();
    let root = await visibleSurface.isVisible().catch(() => false)
      ? visibleSurface
      : session.page.locator('main');
    if (new URL(session.page.url()).pathname === '/zh-CN/user-profile') {
      const addBankAccount = session.page.getByRole('button', {
        name: '添加银行账户',
        exact: true
      });
      await expect(addBankAccount).toBeVisible();
      await addBankAccount.click();
      visibleSurface = session.page.getByRole('dialog').last();
      await expect(visibleSurface).toBeVisible();
      root = visibleSurface;
    }
    const headings = await root.getByRole('heading').allInnerTexts();
    const buttons = (await root.getByRole('button').allInnerTexts()).filter(Boolean);
    const controls = await root.locator('input, textarea, [role="combobox"]').evaluateAll(elements =>
      elements.filter(element => {
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none';
      }).map(element => ({
        role: element.getAttribute('role') ?? element.tagName.toLowerCase(),
        type: element.getAttribute('type') ?? '',
        name: element.getAttribute('name') ?? '',
        placeholder: element.getAttribute('placeholder') ?? '',
        ariaLabel: element.getAttribute('aria-label') ?? '',
        required: element.hasAttribute('required'),
        disabled: element.hasAttribute('disabled')
      }))
    );
    const labels = (await root.locator('label').allInnerTexts())
      .map(value => value.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const countryOptions: Record<string, string[]> = {};
    for (const combobox of await root.getByRole('combobox').all()) {
      const placeholder = await combobox.getAttribute('placeholder') ?? 'combobox';
      await combobox.click();
      const listbox = session.page.getByRole('listbox').last();
      await expect(listbox).toBeVisible();
      countryOptions[placeholder] = (await listbox.getByRole('option').allInnerTexts())
        .map(value => value.replace(/\s+/g, ' ').trim())
        .filter(value => /香港|Hong Kong/i.test(value));
      await session.page.keyboard.press('Escape');
      await expect(listbox).toBeHidden();
    }
    const visibleText = (await root.innerText())
      .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[masked-email]')
      .replace(/\b\d{7,}\b/g, '[masked-number]')
      .replace(/\s+/g, ' ')
      .trim();
    await session.page.screenshot({
      path: 'test-results/personal-golden-fiat-address-form.png',
      fullPage: true
    });
    console.log(`PERSONAL_GOLDEN_FIAT_ADDRESS_FORM=${JSON.stringify({
      route: new URL(session.page.url()).pathname,
      headings,
      buttons,
      labels,
      controls,
      countryOptions,
      visibleText
    })}`);
  } finally {
    await session.context.close();
  }
});

test('Personal Golden Journey Admin法币账户审核只读诊断', async ({ adminPage }) => {
  const adminBaseUrl = required('ADMIN_BASE_URL', env.admin.baseUrl);
  await adminPage.goto(new URL('/zh-CN/kyc/fatAccounts', adminBaseUrl).toString(), {
    waitUntil: 'networkidle'
  });
  await expect(adminPage).not.toHaveURL(/\/login|\/signin|\/sign-in/i);
  const main = adminPage.locator('main');
  await expect(main).toBeVisible();
  const headings = await main.getByRole('heading').allInnerTexts();
  const tabs = await main.getByRole('tab').allInnerTexts();
  const columns = await main.getByRole('columnheader').allInnerTexts();
  const buttons = (await main.getByRole('button').allInnerTexts()).filter(Boolean);
  const controls = await main.locator('input, [role="combobox"]').evaluateAll(elements =>
    elements.filter(element => {
      const style = getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none';
    }).map(element => ({
      role: element.getAttribute('role') ?? element.tagName.toLowerCase(),
      name: element.getAttribute('name') ?? '',
      placeholder: element.getAttribute('placeholder') ?? '',
      ariaLabel: element.getAttribute('aria-label') ?? ''
    }))
  );
  console.log(`PERSONAL_GOLDEN_ADMIN_FIAT_ACCOUNT=${JSON.stringify({
    route: new URL(adminPage.url()).pathname,
    headings,
    tabs,
    columns,
    buttons,
    controls
  })}`);
});

test('Personal Golden Journey 头像设置入口只读诊断', async ({ browser }) => {
  const clientBaseUrl = required('CLIENT_BASE_URL', env.client.baseUrl);
  const source = new PersonalJourneyContextStore().load(
    env.personalRegistration.adminApprovalSourceRunId ?? 'REGP-20260904020924'
  );
  if (!source) throw new Error('The target Personal Journey was not found.');
  const session = await openPersonalJourneyClientSession({
    browser,
    baseURL: clientBaseUrl,
    runId: source.runId,
    email: source.email,
    password: required('CLIENT_PASSWORD', env.client.password),
    otp: required('CLIENT_OTP', env.client.otp)
  });
  try {
    await session.page.goto(clientRouteUrl(clientBaseUrl, 'dashboard'), {
      waitUntil: 'networkidle'
    });
    const avatar = session.page.locator('.MuiAvatar-root:visible').filter({
      has: session.page.locator('svg.lucide-user')
    });
    await expect(avatar).toHaveCount(1);
    await avatar.click();
    const menu = session.page.getByRole('menu');
    await expect(menu).toBeVisible();
    const menuItems = await menu.getByRole('menuitem').allInnerTexts();
    const settings = menu.getByRole('menuitem', { name: '设置', exact: true });
    await expect(settings).toHaveCount(1);
    await settings.click();
    await expect(session.page).toHaveURL(/\/zh-CN\/user-profile(?:$|[?#])/);
    const bankTab = session.page.getByRole('button', { name: '银行账户管理', exact: true });
    await expect(bankTab).toBeVisible();
    await bankTab.click();
    await expect(session.page.getByRole('heading', { name: '银行账户管理', exact: true })).toBeVisible();
    console.log(`PERSONAL_GOLDEN_PROFILE_NAV=${JSON.stringify({
      avatarCandidateCount: 1,
      menuItems,
      route: new URL(session.page.url()).pathname,
      bankAccountManagementVisible: true
    })}`);
  } finally {
    await session.context.close();
  }
});

test('Personal Golden Journey Admin法币账户详情结构只读诊断', async ({ adminPage }) => {
  const adminBaseUrl = required('ADMIN_BASE_URL', env.admin.baseUrl);
  await adminPage.goto(new URL('/zh-CN/kyc/fatAccounts', adminBaseUrl).toString(), {
    waitUntil: 'networkidle'
  });
  await expect(adminPage).not.toHaveURL(/\/login|\/signin|\/sign-in/i);
  const pendingTab = adminPage.getByRole('tab', { name: '待审核', exact: true });
  await expect(pendingTab).toBeVisible();
  await pendingTab.click();
  const rows = adminPage.locator('tbody tr').filter({
    has: adminPage.getByRole('button', { name: '查看详情', exact: true })
  });
  expect(await rows.count()).toBeGreaterThan(0);
  await rows.first().getByRole('button', { name: '查看详情', exact: true }).click();
  await expect(adminPage).toHaveURL(/\/zh-CN\/kyc\/fatAccounts\/[^/?#]+(?:$|[?#])/);
  const main = adminPage.locator('main');
  await expect(main).toBeVisible();
  const headings = await main.getByRole('heading').allInnerTexts();
  const buttons = (await main.getByRole('button').allInnerTexts()).filter(Boolean);
  const labels = (await main.locator('label').allInnerTexts())
    .map(value => value.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const controls = await main.locator('input, textarea, [role="combobox"]').evaluateAll(elements =>
    elements.filter(element => {
      const style = getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none';
    }).map(element => ({
      role: element.getAttribute('role') ?? element.tagName.toLowerCase(),
      name: element.getAttribute('name') ?? '',
      placeholder: element.getAttribute('placeholder') ?? '',
      disabled: element.hasAttribute('disabled')
    }))
  );
  console.log(`PERSONAL_GOLDEN_ADMIN_FIAT_DETAIL=${JSON.stringify({
    routePattern: '/zh-CN/kyc/fatAccounts/{id}',
    headings,
    buttons,
    labels,
    controls
  })}`);
});

test('Personal Golden Journey 法币账户创建后只读Reconciliation', async ({ browser, adminPage }) => {
  const clientBaseUrl = required('CLIENT_BASE_URL', env.client.baseUrl);
  const adminBaseUrl = required('ADMIN_BASE_URL', env.admin.baseUrl);
  const source = new PersonalJourneyContextStore().load(
    env.personalRegistration.adminApprovalSourceRunId ?? 'REGP-20260904020924'
  );
  if (!source?.displayName || !source.sequence) {
    throw new Error('The target Personal Journey was not found.');
  }
  const bankAccount = `88000000${String(source.sequence).padStart(4, '0')}`;
  const bankName = `FIDERE SANDBOX BANK ${source.displayName.split(' ').at(-1)}`;
  const client = await openPersonalJourneyClientSession({
    browser,
    baseURL: clientBaseUrl,
    runId: source.runId,
    email: source.email,
    password: required('CLIENT_PASSWORD', env.client.password),
    otp: required('CLIENT_OTP', env.client.otp)
  });
  try {
    const bankAccounts = new BankAccountManagementPage(client.page);
    await bankAccounts.gotoFromProfileMenu(clientBaseUrl);
    const clientStatus = await bankAccounts.readAccountStatus(bankAccount, bankName);

    const adminAccounts = new AdminFiatAccountReviewPage(adminPage);
    await adminAccounts.goto(adminBaseUrl, '待审核');
    const adminCandidate = await adminAccounts.locateCandidate({
      email: source.email,
      displayName: source.displayName,
      bankName,
      bankAccount
    });
    console.log(`PERSONAL_GOLDEN_FIAT_RECONCILIATION=${JSON.stringify({
      accountSuffix: `****${bankAccount.slice(-4)}`,
      clientRecordExists: clientStatus !== undefined,
      clientStatus,
      adminCandidateCount: adminCandidate.candidateCount
    })}`);
  } finally {
    await client.context.close();
  }
});

test('Personal Golden Journey 法币账户二次确认只读诊断', async ({ browser }) => {
  const clientBaseUrl = required('CLIENT_BASE_URL', env.client.baseUrl);
  const source = new PersonalJourneyContextStore().load(
    env.personalRegistration.adminApprovalSourceRunId ?? 'REGP-20260904020924'
  );
  if (!source?.displayName || !source.sequence) {
    throw new Error('The target Personal Journey was not found.');
  }
  const bankAccount = `88000000${String(source.sequence).padStart(4, '0')}`;
  const client = await openPersonalJourneyClientSession({
    browser,
    baseURL: clientBaseUrl,
    runId: source.runId,
    email: source.email,
    password: required('CLIENT_PASSWORD', env.client.password),
    otp: required('CLIENT_OTP', env.client.otp)
  });
  try {
    const bankAccounts = new BankAccountManagementPage(client.page);
    await bankAccounts.gotoFromProfileMenu(clientBaseUrl);
    await bankAccounts.openAddForm();
    await bankAccounts.fill({
      accountHolderName: source.displayName,
      beneficiaryCountry: '中国香港特别行政区',
      city: 'HONG KONG',
      address: 'FIDERE SANDBOX AUTOMATION ADDRESS',
      bankCountry: '中国香港特别行政区',
      bankName: `FIDERE SANDBOX BANK ${source.displayName.split(' ').at(-1)}`,
      bankAddress: 'FIDERE SANDBOX BANK ADDRESS',
      bankAccount,
      swiftCode: 'SBOXHKHH'
    });
    const securityKeyDom = await bankAccounts.openSecurityKeyDialogOnce();
    console.log(`PERSONAL_GOLDEN_FIAT_CONFIRMATION=${JSON.stringify({
      dialog: 'Security Key Verification',
      visibleInputCount: securityKeyDom.visibleInputCount,
      buttonLabels: securityKeyDom.buttonLabels,
      formSubmitClicks: bankAccounts.formSubmitClicks(),
      securityVerificationClicks: bankAccounts.securityVerificationClicks()
    })}`);
    await bankAccounts.closeSecurityKeyWithoutVerifying();
    expect(bankAccounts.formSubmitClicks()).toBe(1);
    expect(bankAccounts.submissionClicks()).toBe(0);
    expect(bankAccounts.securityVerificationClicks()).toBe(0);
  } finally {
    await client.context.close();
  }
});
