import { expect, type Page } from '@playwright/test';
import { clientRouteUrl } from './HomePage';

export class ClientSettingsPage {
  constructor(readonly page: Page) {}

  async gotoFromProfileMenu(baseURL: string): Promise<void> {
    await this.page.goto(clientRouteUrl(baseURL, 'dashboard'), { waitUntil: 'domcontentloaded' });
    const avatar = this.page.locator('.MuiAvatar-root:visible').filter({ has: this.page.locator('svg.lucide-user') });
    await expect(avatar).toHaveCount(1);
    await avatar.click();
    const menu = this.page.getByRole('menu');
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: '设置', exact: true }).click();
    await expect(this.page).toHaveURL(/\/zh-CN\/user-profile(?:$|[?#])/);
  }
}
