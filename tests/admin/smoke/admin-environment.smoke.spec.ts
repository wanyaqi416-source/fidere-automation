import { env } from '../../../src/config/env';
import {
  expect,
  expectAdminSessionActive,
  test
} from '../../../fixtures/admin.fixture';

test('@smoke @L0 starts Chromium and opens the configured Admin environment', async ({
  baseURL,
  browserName,
  page
}) => {
  expect(browserName).toBe('chromium');

  await page.goto('about:blank');
  await expect(page).toHaveURL('about:blank');

  const adminBaseUrl = env.admin.baseUrl;

  expect(
    adminBaseUrl,
    'ADMIN_BASE_URL is missing. Set the real Admin test environment URL in .env.'
  ).toBeTruthy();
  expect(baseURL).toBe(adminBaseUrl);

  const response = await page.goto(adminBaseUrl!, {
    waitUntil: 'domcontentloaded'
  });

  expect(response, 'The Admin environment navigation returned no HTTP response.').not.toBeNull();
  expect(
    response!.status(),
    `The Admin environment returned HTTP ${response!.status()}.`
  ).toBeLessThan(400);

  await expectAdminSessionActive(page);
});
