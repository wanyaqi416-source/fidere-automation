import { expect, type Locator, type Page } from '@playwright/test';

import { Decimal, decimalFromText } from '../../src/utils/money';

export type AccountBalanceCriteria = {
  accountType: string;
  currency: string;
};

export type JurisdictionBalance = AccountBalanceCriteria & {
  availableBalance: Decimal;
  displayedText: string;
};

export type AccountBalanceSnapshot = AccountBalanceCriteria & {
  available: string; frozen: string; total: string; observedAt: string;
};

const availableBalanceHeader = /可用余额|可用金额/;

export class AccountBalanceReader {
  constructor(readonly page: Page) {}

  async readSnapshot(criteria: AccountBalanceCriteria): Promise<AccountBalanceSnapshot> {
    await this.readBalance(criteria);
    const heading = this.page.getByRole('heading', { name: criteria.accountType, exact: true });
    await expect(heading).toHaveCount(1);
    const table = await this.findUniqueAccountTable(heading);
    if (!table) throw new Error('Account snapshot table is not unique.');
    const headers = (await table.getByRole('columnheader').allTextContents()).map(text => text.trim());
    const rows = table.getByRole('row').filter({ has: this.page.getByText(criteria.currency, { exact: true }) });
    await expect(rows).toHaveCount(1);
    const cells = await rows.getByRole('cell').allTextContents();
    const read = (label: string) => {
      const index = headers.indexOf(label);
      if (index < 0) throw new Error(`Account snapshot column unavailable: ${label}`);
      return decimalFromText(cells[index], label).toFixed();
    };
    return { ...criteria, available: read('可用余额'), frozen: read('冻结金额'), total: read('余额'), observedAt: new Date().toISOString() };
  }

  async readBalance(criteria: AccountBalanceCriteria): Promise<JurisdictionBalance> {
    let resolved: JurisdictionBalance | undefined;
    await expect.poll(async () => {
      resolved = await this.readFromAccountTable(criteria) ??
        await this.readFromAccountContainers(criteria);
      return resolved ? 1 : 0;
    }, {
      message: `Could not uniquely read Client available balance for ${criteria.accountType} / ${criteria.currency}`,
      timeout: 20_000
    }).toBe(1);

    return resolved!;
  }

  async readUniqueBalanceByCurrency(
    currency: string,
    accountType?: string
  ): Promise<JurisdictionBalance> {
    let resolved: JurisdictionBalance | undefined;
    await expect.poll(async () => {
      const accountSummary = accountType
        ? await this.readAccountSummary(accountType, currency)
        : undefined;
      const candidates = [
        ...(accountSummary ? [accountSummary] : []),
        ...await this.collectCurrencyBalances(currency)
      ]
        .filter(candidate => !accountType || candidate.accountType === accountType);
      const unique = new Map(
        candidates.map(candidate => [
          `${candidate.accountType}\u0000${candidate.availableBalance.toString()}`,
          candidate
        ])
      );
      if (unique.size > 1) {
        throw new Error(
          `Expected one ${accountType ?? 'Client'} account with a ${currency} available balance, found ${unique.size}.`
        );
      }
      resolved = [...unique.values()][0];
      return unique.size;
    }, {
      message: `Could not uniquely read one ${accountType ?? 'Client'} account with a ${currency} available balance.`,
      timeout: 20_000
    }).toBe(1);
    return resolved!;
  }

  private async readAccountSummary(
    accountType: string,
    currency: string
  ): Promise<JurisdictionBalance | undefined> {
    const labels = await this.page.getByText(
      new RegExp(`账户余额[：:]\\s*${accountType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    ).all();
    for (const label of labels) {
      if (!(await label.isVisible())) continue;
      let container = label.locator('..');
      for (let level = 0; level < 5; level += 1) {
        const text = (await container.innerText()).replace(/\s+/g, ' ').trim();
        const currencyPattern = new RegExp(
          `${currency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(-?[\\d,]+(?:\\.\\d+)?)`
        );
        const displayedText = currencyPattern.exec(text)?.[1] ??
          (currency === 'USD' ? /\$\s*(-?[\d,]+(?:\.\d+)?)/.exec(text)?.[1] : undefined);
        if (displayedText) {
          return {
            accountType,
            currency,
            availableBalance: new Decimal(displayedText.replace(/,/g, '')),
            displayedText
          };
        }
        container = container.locator('..');
      }
    }
    return undefined;
  }

  private async collectCurrencyBalances(currency: string): Promise<JurisdictionBalance[]> {
    const candidates: JurisdictionBalance[] = [];
    for (const table of await this.page.getByRole('table').all()) {
      if (!(await table.isVisible())) continue;
      const headers = (await table.getByRole('columnheader').allTextContents())
        .map(value => value.trim());
      const balanceIndex = headers.findIndex(header => availableBalanceHeader.test(header));
      if (balanceIndex < 0) continue;

      for (const row of await table.getByRole('row').all()) {
        const cells = row.getByRole('cell');
        if ((await cells.count()) <= balanceIndex) continue;
        if ((await cells.getByText(currency, { exact: true }).count()) !== 1) continue;
        const accountType = await this.readClosestAccountHeading(table);
        if (!accountType) continue;
        const displayedText = (await cells.nth(balanceIndex).innerText()).trim();
        candidates.push({
          accountType,
          currency,
          availableBalance: decimalFromText(displayedText, 'unique currency available balance'),
          displayedText
        });
      }
    }

    for (const currencyLabel of await this.page.getByText(currency, { exact: true }).all()) {
      if (!(await currencyLabel.isVisible())) continue;
      let container = currencyLabel.locator('..');
      for (let level = 0; level < 7; level += 1) {
        const text = (await container.innerText()).replace(/\s+/g, ' ').trim();
        if (!availableBalanceHeader.test(text)) {
          container = container.locator('..');
          continue;
        }
        const accountType = text.match(
          /香港账户|美国账户|新加坡账户|巴林账户|数字资产账户|信托账户/
        )?.[0];
        const escapedCurrency = currency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const balanceText = text.match(
          new RegExp(`(?:可用余额|可用金额)[^\\d-]*?(?:${escapedCurrency}\\s*)?(-?[\\d,]+(?:\\.\\d+)?)`)
        )?.[1] ?? text.match(
          new RegExp(`${escapedCurrency}\\s*(-?[\\d,]+(?:\\.\\d+)?)[^\\d]*(?:可用余额|可用金额)`)
        )?.[1];
        if (accountType && balanceText) {
          candidates.push({
            accountType,
            currency,
            availableBalance: new Decimal(balanceText.replace(/,/g, '')),
            displayedText: balanceText
          });
          break;
        }
        container = container.locator('..');
      }
    }

    return candidates;
  }

  private async readFromAccountTable(
    criteria: AccountBalanceCriteria
  ): Promise<JurisdictionBalance | undefined> {
    const headings = await this.page.getByRole('heading', {
      name: criteria.accountType,
      exact: true
    }).all();

    for (const heading of headings) {
      if (!(await heading.isVisible())) continue;
      const table = await this.findUniqueAccountTable(heading);
      if (!table) continue;

      const headers = (await table.getByRole('columnheader').allTextContents())
        .map(value => value.trim());
      const balanceIndex = headers.findIndex(header => availableBalanceHeader.test(header));
      if (balanceIndex < 0) continue;

      const matchingRows: Locator[] = [];
      for (const row of await table.getByRole('row').all()) {
        const cells = row.getByRole('cell');
        if ((await cells.count()) === 0) continue;
        if ((await cells.getByText(criteria.currency, { exact: true }).count()) === 1) {
          matchingRows.push(row);
        }
      }
      if (matchingRows.length === 0) continue;
      if (matchingRows.length > 1) {
        throw new Error(
          `Expected one ${criteria.currency} balance row in ${criteria.accountType}, found ${matchingRows.length}`
        );
      }

      const cells = matchingRows[0].getByRole('cell');
      if ((await cells.count()) <= balanceIndex) {
        throw new Error(
          `Available balance column is missing for ${criteria.accountType} / ${criteria.currency}`
        );
      }
      const displayedText = (await cells.nth(balanceIndex).innerText()).trim();
      return {
        ...criteria,
        availableBalance: decimalFromText(displayedText, 'jurisdiction available balance'),
        displayedText
      };
    }

    return undefined;
  }

  private async findUniqueAccountTable(accountHeading: Locator): Promise<Locator | undefined> {
    let container = accountHeading;
    for (let level = 0; level < 6; level += 1) {
      container = container.locator('..');
      const matchingTables: Locator[] = [];
      for (const table of await container.getByRole('table').all()) {
        const headers = (await table.getByRole('columnheader').allTextContents())
          .map(value => value.trim());
        if (headers.some(header => availableBalanceHeader.test(header))) {
          matchingTables.push(table);
        }
      }
      if (matchingTables.length === 1) return matchingTables[0];
    }
    return undefined;
  }

  private async readClosestAccountHeading(table: Locator): Promise<string | undefined> {
    let container = table.locator('..');
    for (let level = 0; level < 6; level += 1) {
      const headings = await container.getByRole('heading').allTextContents();
      const accountHeadings = headings
        .map(value => value.replace(/\s+/g, ' ').trim())
        .filter(value => /账户/.test(value));
      if (accountHeadings.length === 1) return accountHeadings[0];
      container = container.locator('..');
    }
    return undefined;
  }

  private async readFromAccountContainers(
    criteria: AccountBalanceCriteria
  ): Promise<JurisdictionBalance | undefined> {
    const accountLabels = await this.page.getByText(criteria.accountType, { exact: true }).all();
    const balances = new Map<string, string>();

    for (const accountLabel of accountLabels) {
      if (!(await accountLabel.isVisible())) continue;
      let container: Locator = accountLabel;
      for (let level = 0; level < 6; level += 1) {
        container = container.locator('..');
        const text = (await container.innerText()).trim();
        if (!text.includes(criteria.currency) || !availableBalanceHeader.test(text)) continue;

        const escapedCurrency = criteria.currency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = text.match(
          new RegExp(
            `(?:可用余额|可用金额)[^\\d-]*?(?:${escapedCurrency}\\s*)?(-?[\\d,]+(?:\\.\\d+)?)`
          )
        );
        if (match) {
          balances.set(match[1].replace(/,/g, ''), match[0]);
          break;
        }
      }
    }

    if (balances.size !== 1) return undefined;
    const [value, displayedText] = [...balances.entries()][0];
    return {
      ...criteria,
      availableBalance: new Decimal(value),
      displayedText
    };
  }
}
