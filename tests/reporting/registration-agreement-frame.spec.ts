import { expect, test } from '@playwright/test';

import { RegistrationAgreementSigner } from '../../pages/client/registration/RegistrationAgreementSigner';

test.describe('Registration completed iframe @readonly @L2', () => {
  for (const replaceFrame of [false, true]) {
    test(`reads completion with iframe replacement=${replaceFrame}`, async ({ page }) => {
      await page.route('https://sandbox.fidere.test/**', route => route.fulfill({
        contentType: 'text/html',
        body: new URL(route.request().url()).pathname === '/registration'
          ? '<h1>Authorization</h1><iframe src="/agreement"></iframe>'
          : '<h3>Document Completed!</h3><img alt="signature">'
      }));
      await page.goto('https://sandbox.fidere.test/registration');
      const signer = new RegistrationAgreementSigner(page);
      await signer.open('TEST SANDBOX AI');
      const originalFrame = page.frames().find(frame => frame !== page.mainFrame())!;

      if (replaceFrame) {
        await page.locator('iframe').evaluate(element => {
          const replacement = document.createElement('iframe');
          replacement.src = '/agreement-completed';
          element.replaceWith(replacement);
        });
        await expect.poll(() => originalFrame.isDetached()).toBe(true);
      }

      await expect(signer.inspectCompletedAgreement()).resolves.toEqual({
        completed: true,
        remainingFields: 0
      });
      expect(signer.fieldSignClickCount()).toBe(0);
      expect(signer.completionActionClickCount()).toBe(0);
      expect(signer.confirmationClickCount()).toBe(0);
    });
  }
});
