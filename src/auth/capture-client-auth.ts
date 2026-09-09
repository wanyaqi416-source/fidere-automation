import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { LoginPage } from '../../pages/client/LoginPage';

type CaptureClientAuthOptions = {
  page: Page;
  baseURL: string;
  username: string;
  password: string;
  otp: string;
  storageStatePath: string;
  systemName: string;
};

async function authStep<T>(
  title: string,
  failureMessage: string,
  action: () => Promise<T>
): Promise<T> {
  return test.step(title, async () => {
    try {
      return await action();
    } catch (error) {
      throw new Error(failureMessage, { cause: error });
    }
  });
}

export async function captureClientAuth(options: CaptureClientAuthOptions): Promise<void> {
  const loginPage = new LoginPage(options.page);

  await authStep('打开客户端登录页', `${options.systemName}登录页无法打开或账号输入框未显示。`, async () => {
    await loginPage.goto(options.baseURL);
  });

  await authStep('填写客户端账号和密码', `${options.systemName}账号或密码输入失败。`, async () => {
    await loginPage.fillCredentials({ username: options.username, password: options.password });
  });

  await authStep('进入邮箱验证码步骤', `${options.systemName}验证码发送失败或验证码输入页面未显示。`, async () => {
    await loginPage.submitCredentials();
    await loginPage.expectOtpStep();
  });

  await authStep('填写固定测试验证码', `${options.systemName}验证码填写失败。`, async () => {
    await loginPage.fillOtp(options.otp);
  });

  await authStep(
    '提交登录并等待仪表板',
    `${options.systemName}登录失败：提交验证码后仍停留在登录页或未进入仪表板。`,
    async () => {
      await loginPage.confirmLogin();
    }
  );

  await authStep(
    '验证客户端登录成功',
    `${options.systemName}登录成功标志缺失：URL、页面标题、仪表板导航或总资产区域不符合预期。`,
    async () => {
      await loginPage.expectLoggedIn();
    }
  );

  await authStep('覆盖保存客户端登录状态', `${options.systemName}登录状态保存失败。`, async () => {
    await mkdir(dirname(options.storageStatePath), { recursive: true });
    const storageState = await options.page.context().storageState({ path: options.storageStatePath });
    expect(
      storageState.cookies.some(cookie => /next-auth\.session-token$/.test(cookie.name)),
      `${options.systemName}登录状态缺少认证会话 Cookie。`
    ).toBe(true);
  });
}
