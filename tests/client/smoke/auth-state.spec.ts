import { HomePage } from '../../../pages/client/HomePage';
import { Navigation } from '../../../pages/client/Navigation';
import { expect, test } from '../../../fixtures/client.fixture';

test('@smoke @L0 登录状态可以被客户端测试复用', async ({ baseURL, page }) => {
  if (!baseURL) {
    throw new Error('CLIENT_BASE_URL is required for Client smoke tests.');
  }

  const homePage = new HomePage(page);
  const navigation = new Navigation(page);

  await test.step('使用 auth/client.json 打开客户端受保护首页', async () => {
    await homePage.gotoDashboard(baseURL);
  });

  await test.step('验证没有被重定向回登录页', async () => {
    await homePage.expectNoLoginRedirect();
  });

  await test.step('验证当前登录状态有效', async () => {
    await homePage.expectDashboardLoaded();
    await expect(navigation.dashboardLink).toBeVisible();

    const storageState = await page.context().storageState();
    expect(
      storageState.cookies.some(cookie => /next-auth\.session-token$/.test(cookie.name)),
      'Client tests should reuse an authenticated NextAuth session cookie.'
    ).toBe(true);
  });

  await test.step('验证页面没有明显登录失效或系统错误', async () => {
    await homePage.expectNoObviousError();
  });
});
