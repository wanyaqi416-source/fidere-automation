import { HomePage } from '../../../pages/client/HomePage';
import { Navigation } from '../../../pages/client/Navigation';
import { expect, test } from '../../../fixtures/client.fixture';

test('@smoke @L0 客户端首页可以正常打开', async ({ baseURL, page }) => {
  if (!baseURL) {
    throw new Error('CLIENT_BASE_URL is required for Client smoke tests.');
  }

  const homePage = new HomePage(page);
  const navigation = new Navigation(page);

  await test.step('打开客户端首页', async () => {
    await homePage.gotoDashboard(baseURL);
  });

  await test.step('验证首页路由和标题', async () => {
    await homePage.expectDashboardLoaded();
  });

  await test.step('验证首页核心区域可见', async () => {
    await expect(homePage.totalAssets).toBeVisible();
    await expect(homePage.portfolioHeading).toBeVisible();
    await expect(homePage.assetAllocationHeading).toBeVisible();
    await expect(navigation.dashboardLink).toBeVisible();
  });

  await test.step('验证首页没有明显错误状态', async () => {
    await homePage.expectNoObviousError();
  });
});
