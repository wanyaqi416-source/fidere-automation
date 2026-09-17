import { AccountBalanceReader } from '../../../pages/client/AccountBalanceReader';
import { BahrainAccountOpeningPage } from '../../../pages/client/BahrainAccountOpeningPage';
import { JurisdictionAccountChooserPage } from '../../../pages/client/JurisdictionAccountChooserPage';
import { SingaporeAccountOpeningPage } from '../../../pages/client/SingaporeAccountOpeningPage';
import { test } from '../../../fixtures/client.fixture';
import {
  evaluateJurisdictionOpeningPreflight,
  type LauncherJurisdiction
} from '../../../scripts/launcher-jurisdiction-opening-run';
import { env } from '../../../src/config/env';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });

test('巴林/新加坡开户菜单只读预检 @readonly @L2', async ({ page }) => {
  test.setTimeout(120_000);
  const target = process.env.JURISDICTION_OPENING_TARGET as LauncherJurisdiction | undefined;
  const email = process.env.OPENING_TEST_EMAIL?.trim().toLowerCase();
  if (!target || !['BH', 'SG'].includes(target) || !email || !env.client.baseUrl) {
    throw new Error('JURISDICTION_OPENING_PREFLIGHT_CONFIG_REQUIRED');
  }
  if (env.exchange.allowMoneyTests || env.allowClientMutationTests || env.allowAdminMutationTests) {
    throw new Error('JURISDICTION_OPENING_PREFLIGHT_MUST_BE_READ_ONLY');
  }

  const accountName = target === 'BH' ? '巴林账户' : '新加坡账户';
  const chooser = new JurisdictionAccountChooserPage(page);
  const balances = new AccountBalanceReader(page);
  await chooser.goto(env.client.baseUrl);
  const currentBalance = (await balances.readSnapshot({ accountType: '香港账户', currency: 'USD' })).available;
  await chooser.openChooser();
  const option = await chooser.readOption(accountName);

  if (option.status !== '可申请') {
    console.log('JURISDICTION_MENU_PREFLIGHT ' + JSON.stringify(evaluateJurisdictionOpeningPreflight({
      target, email, accountStatus: option.status
    })));
    return;
  }

  await chooser.openApplication(accountName);
  const application = target === 'BH'
    ? new BahrainAccountOpeningPage(page)
    : new SingaporeAccountOpeningPage(page);
  await application.expectPreflightLoaded();
  const requirement = await application.readOpeningRequirement();
  if (requirement.currency !== 'USD') throw new Error(`${accountName}开户费币种不是USD。`);
  console.log('JURISDICTION_MENU_PREFLIGHT ' + JSON.stringify(evaluateJurisdictionOpeningPreflight({
    target,
    email,
    accountStatus: option.status,
    currentBalance,
    requiredBalance: requirement.openingFee.toFixed(2)
  })));
});
