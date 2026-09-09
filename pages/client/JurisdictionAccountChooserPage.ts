import { expect, type Locator, type Page } from '@playwright/test';

export type JurisdictionAccountName = '美国账户' | '新加坡账户' | '巴林账户';

export type JurisdictionAccountOption = {
  name: JurisdictionAccountName;
  status: '已开通' | '可申请' | '申请中' | '已拒绝' | '失败';
  description: string;
  actionAvailable: boolean;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class JurisdictionAccountChooserPage {
  private applicationClicks = 0;

  constructor(readonly page: Page) {}

  async goto(baseURL: string): Promise<void> {
    await this.page.goto(new URL('/zh-CN/account-detail', baseURL).toString(), {
      waitUntil: 'domcontentloaded'
    });
    await expect(this.page).toHaveURL(/\/account-detail/);
    await expect(this.openingButton).toBeVisible({ timeout: 20_000 });
  }

  async openChooser(): Promise<void> {
    await this.openingButton.click();
    await expect(this.dialog).toBeVisible();
    await expect(this.dialog).toContainText(/美国账户|新加坡账户|巴林账户/, {
      timeout: 20_000
    });
  }

  async readOption(name: JurisdictionAccountName): Promise<JurisdictionAccountOption> {
    const label = this.dialog.getByText(name, { exact: true });
    await expect(label).toBeVisible();
    const description = await label.evaluate((element, accountName) => {
      let current = element.parentElement;
      while (current) {
        const text = (current.innerText ?? '').replace(/\s+/g, ' ').trim();
        const accountNameCount = ['美国账户', '新加坡账户', '巴林账户', '日本账户']
          .filter(name => text.includes(name)).length;
        if (
          text.includes(accountName) &&
          accountNameCount === 1 &&
          /已开通|创建|继续填写|审核|处理中|申请中|失败|拒绝/.test(text)
        ) {
          return text;
        }
        current = current.parentElement;
      }
      throw new Error(`Unable to resolve the jurisdiction account card for ${accountName}.`);
    }, name);
    const action = this.dialog.getByRole('button', {
      name: new RegExp(`^${escapeRegExp(name)}`)
    });
    const actionCount = await action.count();
    if (actionCount > 1) {
      throw new Error(`Jurisdiction account ${name} has ${actionCount} ambiguous actions.`);
    }
    return {
      name,
      status: description.includes('已开通')
        ? '已开通'
        : /拒绝/.test(description)
          ? '已拒绝'
          : /失败/.test(description)
            ? '失败'
            : /待审核|审核中|处理中|申请中/.test(description)
              ? '申请中'
              : '可申请',
      description,
      actionAvailable: actionCount === 1
    };
  }

  async openApplication(name: JurisdictionAccountName): Promise<void> {
    const action = this.dialog.getByRole('button', {
      name: new RegExp(`^${escapeRegExp(name)}`)
    });
    await expect(action).toHaveCount(1);
    if (this.applicationClicks > 0) {
      throw new Error('A jurisdiction application entry may be opened only once per Page Object run.');
    }
    this.applicationClicks += 1;
    await action.click();
    await expect(this.dialog).toBeHidden();
  }

  async expectAccountSection(name: JurisdictionAccountName): Promise<void> {
    const sectionLabel = this.page.getByText(name, { exact: true });
    await expect(sectionLabel).toHaveCount(1);
    await expect(sectionLabel).toBeVisible({ timeout: 20_000 });
  }

  async openExistingAccountOverview(name: JurisdictionAccountName): Promise<string> {
    const viewAll = this.page.getByRole('button', { name: '查看全部', exact: true });
    await expect(viewAll).toHaveCount(1);
    await viewAll.click();
    const heading = this.page.getByRole('heading', { name, exact: true });
    await expect(heading).toHaveCount(1);
    await expect(heading).toBeVisible({ timeout: 20_000 });
    return new URL(this.page.url()).pathname;
  }

  applicationClickCount(): number {
    return this.applicationClicks;
  }

  private get openingButton(): Locator {
    return this.page.getByRole('button', { name: '开设其他账户', exact: true });
  }

  private get dialog(): Locator {
    return this.page.getByRole('dialog').filter({ hasText: '选择开通账户' });
  }
}
