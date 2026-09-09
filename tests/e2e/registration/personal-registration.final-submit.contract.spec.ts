import { expect, test } from '@playwright/test';

import { PersonalOnboardingPage } from '../../../pages/client/PersonalOnboardingPage';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'REG-P final profile Submit contract @registration @personal @validation @L1',
  async ({ page }) => {
    let memberProfileRequests = 0;
    await page.route('https://sandbox.fidere.test/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/member-profile') {
        memberProfileRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ code: 0, data: { status: 'pending' } })
        });
        return;
      }
      if (request.resourceType() === 'document') {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html>
            <html lang="zh-CN">
              <head><meta charset="utf-8"></head>
              <body>
                <h1>授权</h1>
                <p>资料已提交，等待审核</p>
                <form id="profile-form">
                  <button type="submit" id="final-submit">提交</button>
                </form>
                <script>
                  const form = document.querySelector('#profile-form');
                  form['__reactProps$contract'] = { onSubmit: () => undefined };
                  form.addEventListener('submit', async event => {
                    event.preventDefault();
                    const response = await fetch('/api/member-profile', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ step: 'client_authorization' })
                    });
                    if (response.ok) history.replaceState({}, '', '/zh-CN/sign-success');
                  });
                </script>
              </body>
            </html>`
        });
        return;
      }
      await route.abort();
    });

    await page.goto('https://sandbox.fidere.test/zh-CN/registration?type=individual');
    const onboarding = new PersonalOnboardingPage(page);
    const evidence = await onboarding.submitSignedRegistrationProfileOnce();

    expect(evidence.path).toBe('/api/member-profile');
    expect(evidence.businessCode).toBe('0');
    expect(evidence.memberStatus).toBe('pending');
    expect(evidence.redirectedToSignSuccess).toBe(true);
    expect(evidence.pendingReviewPageVisible).toBe(true);
    expect(evidence.pendingReviewIndicator).toMatch(/等待审核/);
    expect(onboarding.profileFinalSubmitClickCount()).toBe(1);
    expect(memberProfileRequests).toBe(1);
    await expect(page).toHaveURL(/\/zh-CN\/sign-success$/);

    let secondSubmitError: unknown;
    try {
      await onboarding.submitSignedRegistrationProfileOnce();
    } catch (error) {
      secondSubmitError = error;
    }
    expect(secondSubmitError).toBeInstanceOf(Error);
    expect((secondSubmitError as Error).message).toContain('only once');
    expect(memberProfileRequests).toBe(1);
  }
);

test(
  'REG-P post-sign first Submit state desync recovery contract @registration @personal @validation @L1',
  async ({ page }) => {
    let memberProfileRequests = 0;
    await page.route('https://sandbox.fidere.test/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/create-kyc-doc') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 0,
            data: { signingUrl: 'https://app.documenso.com/embed/sign/contract-document' }
          })
        });
        return;
      }
      if (url.pathname === '/api/member-profile') {
        memberProfileRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ code: 0, data: { status: 'pending' } })
        });
        return;
      }
      if (request.resourceType() === 'document') {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html>
            <html lang="zh-CN">
              <head><meta charset="utf-8"></head>
              <body>
                <h1>授权</h1>
                <p>资料已提交，等待审核</p>
                <form id="profile-form">
                  <button type="submit" id="final-submit" class="MuiButton-root final-submit">提交</button>
                </form>
                <script>
                  const loadCount = Number(sessionStorage.getItem('contract-load-count') || '0') + 1;
                  sessionStorage.setItem('contract-load-count', String(loadCount));
                  const signatureRef = { current: loadCount > 1 };
                  const form = document.querySelector('#profile-form');
                  form['__reactProps$contract'] = { onSubmit: () => undefined };
                  fetch('/api/create-kyc-doc', { method: 'POST' });
                  form.addEventListener('submit', async event => {
                    event.preventDefault();
                    if (!signatureRef.current) {
                      const alert = document.createElement('div');
                      alert.setAttribute('role', 'alert');
                      alert.textContent = '请先签署文档后再提交';
                      document.body.appendChild(alert);
                      return;
                    }
                    const response = await fetch('/api/member-profile', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ step: 'client_authorization' })
                    });
                    if (response.ok) history.replaceState({}, '', '/zh-CN/sign-success');
                  });
                </script>
              </body>
            </html>`
        });
        return;
      }
      await route.abort();
    });

    await page.goto('https://sandbox.fidere.test/zh-CN/registration?type=individual');
    const initial = new PersonalOnboardingPage(page);
    const firstAttempt = await initial.attemptSignedRegistrationProfileSubmission({
      requestTimeout: 500
    });
    expect(firstAttempt.evidence).toBeUndefined();
    expect(firstAttempt.diagnostic.memberProfileRequestCount).toBe(0);
    expect(firstAttempt.diagnostic.blockedCondition).toBe('SIGNATURE_REF_FALSE');
    expect(firstAttempt.diagnostic.signBeforeSubmitMessageObserved).toBe(true);
    expect(firstAttempt.diagnostic.before.buttonDisabled).toBe(false);
    expect(firstAttempt.diagnostic.before.reactHandlerReady).toBe(true);

    const recovered = new PersonalOnboardingPage(page);
    const documentEvidence = await recovered.reloadAuthorizationForFinalSubmitRecovery();
    expect(documentEvidence.payloadKind).toBe('signingUrl');
    const recoveryAttempt = await recovered.attemptSignedRegistrationProfileSubmission();
    expect(recoveryAttempt.evidence?.pendingReviewPageVisible).toBe(true);
    expect(recoveryAttempt.diagnostic.memberProfileRequestCount).toBe(1);
    expect(recoveryAttempt.diagnostic.blockedCondition).toBe('NONE');
    expect(memberProfileRequests).toBe(1);
  }
);
