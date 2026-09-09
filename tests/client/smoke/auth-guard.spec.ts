import { LoginPage } from '../../../pages/client/LoginPage';
import { HomePage, clientRouteUrl } from '../../../pages/client/HomePage';
import { expect, test } from '../../../fixtures/client.fixture';

test('@smoke @L0 未登录用户不能访问客户端受保护页面', async ({ baseURL, browser }) => {
  if (!baseURL) {
    throw new Error('CLIENT_BASE_URL is required for Client auth guard tests.');
  }

  const context = await browser.newContext({
    locale: 'zh-CN',
    storageState: { cookies: [], origins: [] }
  });
  const page = await context.newPage();
  const loginPage = new LoginPage(page);
  const homePage = new HomePage(page);

  try {
    await test.step('使用无登录状态的 BrowserContext 访问客户端首页', async () => {
      await page.goto(clientRouteUrl(baseURL, 'dashboard'), {
        waitUntil: 'domcontentloaded'
      });
    });

    await test.step('验证请求被重定向到登录页', async () => {
      await expect(loginPage.emailInput).toBeVisible();
      await expect(page).toHaveURL(/\/login(?:$|[?#])/);
    });

    await test.step('验证未泄露登录后的核心内容', async () => {
      await expect(homePage.totalAssets).not.toBeVisible();
      await expect(homePage.portfolioHeading).not.toBeVisible();
    });
  } finally {
    await context.close();
  }
});
