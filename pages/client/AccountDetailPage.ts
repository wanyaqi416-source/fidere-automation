import { expect, type Page } from '@playwright/test';

import {
  AccountBalanceReader,
  type AccountBalanceCriteria,
  type JurisdictionBalance
} from './AccountBalanceReader';
import { clientRouteUrl } from './HomePage';

export type { AccountBalanceCriteria, JurisdictionBalance } from './AccountBalanceReader';

export class AccountDetailPage {
  private readonly balances: AccountBalanceReader;

  constructor(readonly page: Page) {
    this.balances = new AccountBalanceReader(page);
  }

  async goto(baseURL: string): Promise<void> {
    await this.page.goto(clientRouteUrl(baseURL, 'account-detail'), {
      waitUntil: 'domcontentloaded'
    });
    await expect(this.page).toHaveURL(/\/account-detail(?:$|[?#])/);
    await expect(this.page.getByRole('heading', { name: /资产分布/ }).first()).toBeVisible();
  }

  async readBalance(criteria: AccountBalanceCriteria): Promise<JurisdictionBalance> {
    return this.balances.readBalance(criteria);
  }

  async readSnapshot(accountType: string, currency: string) {
    return this.balances.readSnapshot({ accountType, currency });
  }

  async readAvailableBalance(
    accountType: string,
    currency: string
  ): Promise<JurisdictionBalance> {
    return this.readBalance({ accountType, currency });
  }

  async readUniqueAvailableBalanceByCurrency(
    currency: string,
    accountType?: string
  ): Promise<JurisdictionBalance> {
    return this.balances.readUniqueBalanceByCurrency(currency, accountType);
  }
}
