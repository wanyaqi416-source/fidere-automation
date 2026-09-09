import { type Locator } from '@playwright/test';

import { HomePage } from '../../../pages/client/HomePage';
import {
  Navigation,
  type ClientPageKey
} from '../../../pages/client/Navigation';
import { expect, test } from '../../../fixtures/client.fixture';

type ClientReadOnlyPage = {
  key: ClientPageKey;
  name: string;
  expectedUrl: RegExp;
  expectedTitle: RegExp;
  coreLocator: (homePage: HomePage, navigation: Navigation) => Locator;
};

const readOnlyPages: ClientReadOnlyPage[] = [
  {
    key: 'dashboard',
    name: '仪表板',
    expectedUrl: /\/dashboard(?:$|[?#])/,
    expectedTitle: /Fidere Trust \| Dashboard/,
    coreLocator: homePage => homePage.totalAssets
  },
  {
    key: 'account',
    name: '账户',
    expectedUrl: /\/account-detail(?:$|[?#])/,
    expectedTitle: /Fidere Trust \| Account Detail/,
    coreLocator: homePage => homePage.page.getByRole('heading', { name: '资产分布' })
  },
  {
    key: 'trading',
    name: '交易',
    expectedUrl: /\/trading(?:$|[?#])/,
    expectedTitle: /Fidere Trust \| Trading/,
    coreLocator: homePage => homePage.page.getByRole('heading', { name: '交易流水' })
  },
  {
    key: 'trust',
    name: '信托服务',
    expectedUrl: /\/trust(?:$|[?#])/,
    expectedTitle: /Fidere Trust \| Trust Services/,
    coreLocator: homePage => homePage.page.getByRole('heading', { name: '信托信息' })
  }
];

for (const clientPage of readOnlyPages) {
  test(`@smoke @L0 客户端${clientPage.name}页面可以通过一级菜单打开`, async ({
    baseURL,
    page
  }) => {
    if (!baseURL) {
      throw new Error('CLIENT_BASE_URL is required for Client navigation tests.');
    }

    const homePage = new HomePage(page);
    const navigation = new Navigation(page);
    const coreLocator = clientPage.coreLocator(homePage, navigation);

    await test.step('打开客户端首页', async () => {
      await homePage.gotoDashboard(baseURL);
      await homePage.expectDashboardLoaded();
    });

    await test.step(`点击一级菜单：${clientPage.name}`, async () => {
      await navigation.open(clientPage.key);
    });

    await test.step(`验证${clientPage.name}页面路由和核心内容`, async () => {
      await expect(page).toHaveURL(clientPage.expectedUrl);
      await expect(page).toHaveTitle(clientPage.expectedTitle);
      await expect(coreLocator).toBeVisible();
      await homePage.expectNoLoginRedirect();
      await homePage.expectNoObviousError();
    });
  });
}

test('@smoke @L0 客户端投资一级菜单当前仅作为入口展示', async ({ baseURL, page }) => {
  if (!baseURL) {
    throw new Error('CLIENT_BASE_URL is required for Client navigation tests.');
  }

  const homePage = new HomePage(page);
  const navigation = new Navigation(page);

  await test.step('打开客户端首页', async () => {
    await homePage.gotoDashboard(baseURL);
    await homePage.expectDashboardLoaded();
  });

  await test.step('验证投资入口可见但不执行写操作', async () => {
    await expect(navigation.investmentEntry).toBeVisible();
    await expect(navigation.investmentEntry).toHaveAttribute('aria-haspopup', 'menu');
  });
});
