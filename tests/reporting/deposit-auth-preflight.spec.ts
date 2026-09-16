import { expect, test, type Page } from '@playwright/test';
import { runDepositAuthPreflight } from '../../src/deposit/deposit-auth-preflight';
import { DepositExecutionGuard } from '../../src/deposit/deposit-e2e';

const clientBaseUrl = 'https://client.sandbox.test/zh-CN';
const adminBaseUrl = 'https://admin.sandbox.test/zh-CN';
const clientHtml = '<title>Fidere Trust | Dashboard</title><main><span>总资产</span></main>';
const adminHtml = '<nav>工作台</nav><button>入账认领</button><table><thead><tr><th scope="col">提交时间</th></tr></thead><tbody><tr><td>2026-09-14</td></tr></tbody></table>';

async function localPreflightPages(clientPage: Page, adminPage: Page, beforeAdmin?: () => Promise<void>) {
  const requests: string[] = [];
  await clientPage.route('**/*', async route => {
    expect(route.request().method()).toBe('GET');
    requests.push('Client ' + new URL(route.request().url()).pathname);
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: clientHtml });
  });
  await adminPage.route('**/*', async route => {
    expect(route.request().method()).toBe('GET');
    requests.push('Admin ' + new URL(route.request().url()).pathname);
    await beforeAdmin?.();
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: adminHtml });
  });
  return requests;
}

test('入金只读预检先展示Client首页，双端验证后才允许提交', async ({ context, page: clientPage }) => {
  const adminPage = await context.newPage();
  const requests = await localPreflightPages(clientPage, adminPage, async () => {
    expect(clientPage.url()).toBe(clientBaseUrl + '/dashboard');
    await expect(clientPage.getByText('总资产', { exact: true })).toBeVisible();
  });
  const guard = new DepositExecutionGuard();
  expect(() => guard.assertClientSubmissionAllowed(true, true)).toThrow();
  await runDepositAuthPreflight({ clientPage, adminPage, clientBaseUrl, adminBaseUrl, guard });
  expect(requests).toEqual(['Client /zh-CN/dashboard', 'Admin /zh-CN', 'Admin /zh-CN/operation/fiatAssets']);
  expect(() => guard.assertClientSubmissionAllowed(true, true)).not.toThrow();
  expect(() => guard.assertClientSubmissionAllowed(false, false)).toThrow();
  expect(context.pages()).toHaveLength(2);
});

test('Admin检查期间Client窗口关闭时保留原因，不重建页面或放行入金', async ({ context, page: clientPage }) => {
  const adminPage = await context.newPage();
  await localPreflightPages(clientPage, adminPage, async () => {
    if (!clientPage.isClosed()) await clientPage.close();
  });
  const guard = new DepositExecutionGuard();
  await expect(runDepositAuthPreflight({ clientPage, adminPage, clientBaseUrl, adminBaseUrl, guard }))
    .rejects.toThrow('Client 浏览器窗口在入金认证预检期间已关闭');
  expect(() => guard.assertClientSubmissionAllowed(true, true)).toThrow();
  expect(context.pages()).toEqual([adminPage]);
});

test('Admin窗口已关闭时准确报告Admin，不恢复或绕过认证', async ({ context, page: clientPage }) => {
  const adminPage = await context.newPage();
  await localPreflightPages(clientPage, adminPage);
  await adminPage.close();
  const guard = new DepositExecutionGuard();
  await expect(runDepositAuthPreflight({ clientPage, adminPage, clientBaseUrl, adminBaseUrl, guard }))
    .rejects.toThrow('Admin 浏览器窗口在入金认证预检期间已关闭');
  expect(() => guard.assertClientSubmissionAllowed(true, true)).toThrow();
  expect(context.pages()).toEqual([clientPage]);
});

test('Admin认证失败保留原始HTTP错误，Client首页展示不等于提交授权', async ({ context, page: clientPage }) => {
  const adminPage = await context.newPage();
  await localPreflightPages(clientPage, adminPage);
  await adminPage.route('**/*', route => route.fulfill({ status: 401, body: 'Unauthorized' }));
  const guard = new DepositExecutionGuard();
  await expect(runDepositAuthPreflight({ clientPage, adminPage, clientBaseUrl, adminBaseUrl, guard }))
    .rejects.toThrow('The Admin environment returned HTTP 401.');
  expect(() => guard.assertClientSubmissionAllowed(true, true)).toThrow();
  expect(context.pages()).toHaveLength(2);
});
