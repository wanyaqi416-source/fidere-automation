import { test } from '@playwright/test';

import { captureClientAuth } from '../../src/auth/capture-client-auth';
import { authStatePaths } from '../../src/config/auth';
import { env } from '../../src/config/env';
import { assertClientTestEnvironment } from '../../src/utils/clientSafety';

test.describe.configure({ mode: 'serial', retries: 0 });

test('客户端自动登录并生成最新状态', { tag: ['@auth-setup', '@client'] }, async ({
  baseURL,
  page
}) => {
  assertClientTestEnvironment(baseURL);

  if (!baseURL) {
    throw new Error('客户端自动登录失败：CLIENT_BASE_URL 未配置。');
  }

  const { username, password, otp } = env.client;

  if (!username || !password || !otp) {
    throw new Error(
      '客户端自动登录失败：CLIENT_USERNAME、CLIENT_PASSWORD 和 CLIENT_OTP 必须在本地环境中配置。'
    );
  }

  await captureClientAuth({
    page,
    baseURL,
    username,
    password,
    otp,
    storageStatePath: authStatePaths.client,
    systemName: '客户端'
  });
});
