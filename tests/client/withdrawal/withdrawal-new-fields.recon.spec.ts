import { WithdrawalPage } from '../../../pages/client/WithdrawalPage';
import { expect, test } from '../../../fixtures/client.fixture';
import { getWithdrawalTestConfig } from './withdrawalTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });

test('法币出金新增可选字段DOM Recon @client @withdrawal @readonly @recon', async ({ baseURL, page }) => {
  if (!baseURL) throw new Error('CLIENT_BASE_URL is required for Withdrawal field recon.');
  const config = getWithdrawalTestConfig();
  const withdrawal = new WithdrawalPage(page);

  await withdrawal.goto(baseURL);
  await withdrawal.selectAccount(config.accountType);
  await withdrawal.selectCurrency(config.currencyLabel);
  await withdrawal.selectBeneficiary({
    name: config.beneficiaryName,
    accountSuffix: config.beneficiaryAccountSuffix,
    currency: config.currency
  });
  await withdrawal.selectPurpose(config.purpose);
  await withdrawal.fillAmount(config.testAmount);

  const transferMethods = await withdrawal.readTransferMethodOptions();
  expect(transferMethods.length).toBeGreaterThan(0);

  const comboboxes = [];
  for (const locator of await page.getByRole('combobox').all()) {
    if (!(await locator.isVisible())) continue;
    let container = locator;
    let nearbyText = '';
    for (let level = 0; level < 4; level += 1) {
      container = container.locator('..');
      nearbyText = (await container.innerText()).replace(/\s+/g, ' ').trim();
      if (nearbyText.length >= 2) break;
    }
    comboboxes.push({
      ariaLabel: await locator.getAttribute('aria-label'),
      name: await locator.getAttribute('name'),
      id: await locator.getAttribute('id'),
      text: (await locator.innerText()).replace(/\s+/g, ' ').trim(),
      nearbyText: nearbyText.slice(0, 160)
    });
  }

  const uploads = [];
  for (const locator of await page.locator('input[type="file"]').all()) {
    let container = locator;
    let nearbyText = '';
    for (let level = 0; level < 6; level += 1) {
      container = container.locator('..');
      nearbyText = (await container.innerText()).replace(/\s+/g, ' ').trim();
      if (/支持|文件|附件|上传|support|document|upload/i.test(nearbyText)) break;
    }
    uploads.push({
      accept: await locator.getAttribute('accept'),
      multiple: await locator.getAttribute('multiple'),
      name: await locator.getAttribute('name'),
      id: await locator.getAttribute('id'),
      nearbyText: nearbyText.slice(0, 240)
    });
  }

  console.log(`WITHDRAWAL_NEW_FIELDS=${JSON.stringify({ comboboxes, uploads, transferMethods })}`);
  expect(comboboxes.length).toBeGreaterThanOrEqual(4);
  expect(uploads).toHaveLength(1);
  expect(withdrawal.confirmationClicks()).toBe(0);
  expect(withdrawal.securityVerificationClicks()).toBe(0);
});
