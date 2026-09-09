import { test } from '@playwright/test';

import { captureClientAuth } from '../../src/auth/capture-client-auth';
import { authStatePaths } from '../../src/config/auth';
import { env } from '../../src/config/env';
import { assertClientTestEnvironment } from '../../src/utils/clientSafety';

test.describe.configure({ mode: 'serial', retries: 0 });

test('开户专用客户端自动登录并生成独立状态', { tag: ['@auth-setup', '@client', '@account-opening'] }, async ({
  baseURL,
  page
}) => {
  assertClientTestEnvironment(baseURL);
  if (!baseURL) throw new Error('开户专用客户端登录失败：CLIENT_BASE_URL未配置。');

  const username = env.accountOpening.testEmail;
  const { password, otp } = env.client;
  if (!username || !password || !otp) {
    throw new Error(
      '开户专用客户端登录失败：OPENING_TEST_EMAIL、CLIENT_PASSWORD和CLIENT_OTP必须在本地环境中配置。'
    );
  }

  await captureClientAuth({
    page,
    baseURL,
    username,
    password,
    otp,
    storageStatePath: authStatePaths.openingClient,
    systemName: '开户专用客户端'
  });
});
