import { expect, test } from '@playwright/test';
import { PersonalRegistrationPage } from '../../pages/client/PersonalRegistrationPage';

for (const [message, fails] of [['验证码已发送', false], ['验证码发送失败', true]] as const) {
  test(`注册发送结果分类：${message}`, async ({ page }) => {
    await page.setContent('<button>获取验证码</button><div role="status"></div>');
    await page.evaluate(text => {
      let count = 0;
      document.querySelector('button')!.addEventListener('click', () => {
        document.querySelector('[role="status"]')!.textContent = text;
        document.body.dataset.requests = String(++count);
      });
    }, message);
    const registration = new PersonalRegistrationPage(page);
    if (fails) {
      await expect(registration.requestVerificationCode()).rejects.toThrow('EMAIL_OTP_SEND_FAILED');
    } else {
      await registration.requestVerificationCode();
    }
    await expect(page.locator('body')).toHaveAttribute('data-requests', '1');
  });
}
