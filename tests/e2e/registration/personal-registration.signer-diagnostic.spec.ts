import { writeFile } from 'node:fs/promises';

import { expect, test } from '../../../fixtures/registration.fixture';

import { clientRouteUrl } from '../../../pages/client/HomePage';
import { LoginPage } from '../../../pages/client/LoginPage';
import { env } from '../../../src/config/env';
import { PersonalJourneyContextStore } from '../../../src/registration';

test.describe.configure({ mode: 'serial', retries: 0 });

test('REG-P signer field navigation diagnostic @diagnostic @readonly', async ({
  registrationPage
}, testInfo) => {
  test.setTimeout(90_000);
  const journey = new PersonalJourneyContextStore().findCurrentRecoverableJourney();
  expect(journey).toBeTruthy();
  expect(env.client.baseUrl).toBeTruthy();
  expect(env.client.password).toBeTruthy();
  expect(env.client.otp).toBeTruthy();

  const login = new LoginPage(registrationPage);
  await login.goto(clientRouteUrl(env.client.baseUrl!, 'login'));
  await login.fillCredentials({
    username: journey!.email,
    password: env.client.password!
  });
  await login.submitCredentials();
  await login.expectOtpStep();
  await login.fillOtp(env.client.otp!);
  await login.confirmLoginToAuthenticatedRoute();
  await registrationPage.goto(
    new URL('/zh-CN/registration?type=individual', env.client.baseUrl).toString(),
    { waitUntil: 'domcontentloaded' }
  );

  let signerFrame = registrationPage.mainFrame();
  await expect.poll(async () => {
    for (const frame of registrationPage.frames()) {
      if (frame === registrationPage.mainFrame() || frame.isDetached()) continue;
      const heading = frame.getByRole('heading', { name: /^Sign Document$/i });
      if ((await heading.count()) === 1 && await heading.isVisible()) {
        signerFrame = frame;
        return true;
      }
    }
    return false;
  }, {
    timeout: 30_000,
    intervals: [250, 500, 1_000]
  }).toBe(true);

  const snapshot = () => signerFrame.evaluate(() => {
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 &&
        style.display !== 'none' && style.visibility !== 'hidden';
    };
    const describe = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role'),
        text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100),
        ariaLabel: element.getAttribute('aria-label'),
        ariaDescribedBy: element.getAttribute('aria-describedby'),
        dataTestId: element.getAttribute('data-testid'),
        dataFieldId: element.getAttribute('data-field-id'),
        className: typeof element.className === 'string'
          ? element.className.replace(/\s+/g, ' ').trim().slice(0, 180)
          : '',
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        visible: visible(element)
      };
    };
    const all = Array.from(document.querySelectorAll('*'));
    const scrollables = all
      .filter(element => {
        const style = getComputedStyle(element);
        return element.scrollHeight > element.clientHeight + 20 &&
          /(auto|scroll)/.test(style.overflowY);
      })
      .map(element => ({
        ...describe(element),
        scrollTop: Math.round(element.scrollTop),
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight
      }))
      .slice(0, 20);
    const fieldLike = all
      .filter(element =>
        element.hasAttribute('aria-describedby') ||
        element.hasAttribute('data-field-id') ||
        /field/i.test(typeof element.className === 'string' ? element.className : '')
      )
      .map(describe)
      .slice(0, 100);
    const buttons = Array.from(document.querySelectorAll('button'))
      .filter(visible)
      .map(describe);
    const tooltips = Array.from(document.querySelectorAll('[role="tooltip"]'))
      .map(describe);
    const scripts = Array.from(document.scripts)
      .map(script => script.src)
      .filter(Boolean)
      .map(value => {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
      });
    const scriptResources = performance.getEntriesByType('resource')
      .map(entry => entry.name)
      .filter(value => /\.(?:js|mjs)(?:$|\?)/i.test(value))
      .map(value => {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
      });
    return {
      documentScrollY: Math.round(window.scrollY),
      bodyScrollHeight: document.body.scrollHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      activeElement: document.activeElement ? describe(document.activeElement) : null,
      buttons,
      tooltips,
      fieldLike,
      scrollables,
      scripts,
      scriptResources
    };
  });

  const before = await snapshot();
  const frameElement = await signerFrame.frameElement();
  await frameElement.evaluate(element => (element as Element).scrollIntoView({
    block: 'end',
    inline: 'nearest'
  }));
  const nextField = signerFrame.getByRole('button', { name: /^Next Field$/i });
  await expect(nextField).toHaveCount(1);
  await expect(nextField).toBeEnabled();
  await nextField.click();

  let navigationSignal = 'none';
  try {
    await signerFrame.waitForFunction(() => {
      const visible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const tooltip = Array.from(document.querySelectorAll('[role="tooltip"]'))
        .some(element => visible(element) && /Click to insert field/i.test(element.textContent ?? ''));
      const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).some(visible);
      const deepScroll = Array.from(document.querySelectorAll('*')).some(element =>
        element.scrollHeight > element.clientHeight + 20 && element.scrollTop > 100
      );
      return tooltip || dialog || deepScroll;
    }, undefined, { timeout: 8_000 });
    navigationSignal = 'observed';
  } catch (error) {
    navigationSignal = error instanceof Error ? error.name : 'timeout';
  }

  const afterFirstClick = await snapshot();
  let secondNavigationSignal = 'not-required';
  if (
    navigationSignal !== 'observed' &&
    afterFirstClick.scrollables.some(container => container.scrollHeight > container.clientHeight * 2)
  ) {
    await nextField.click();
    await signerFrame.evaluate(async () => {
      const container = Array.from(document.querySelectorAll('*')).find(element => {
        const style = getComputedStyle(element);
        return element.scrollHeight > element.clientHeight * 2 &&
          /(auto|scroll)/.test(style.overflowY);
      });
      if (!container) throw new Error('Documenso document scroll container is unavailable.');
      await new Promise<void>(resolve => {
        let previous = container.scrollTop;
        let stableFrames = 0;
        let observedMovement = false;
        let frames = 0;
        const tick = (): void => {
          frames += 1;
          const current = container.scrollTop;
          if (Math.abs(current - previous) < 1) {
            stableFrames += 1;
          } else {
            observedMovement = true;
            stableFrames = 0;
          }
          previous = current;
          if ((observedMovement && stableFrames >= 8) || frames >= 600) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    });
    try {
      await signerFrame.waitForFunction(() => {
        const visible = (element: Element): boolean => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const tooltip = Array.from(document.querySelectorAll('[role="tooltip"]'))
          .some(element => visible(element) && /Click to insert field/i.test(element.textContent ?? ''));
        const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).some(visible);
        const deepScroll = Array.from(document.querySelectorAll('*')).some(element =>
          element.scrollHeight > element.clientHeight + 20 && element.scrollTop > 100
        );
        return tooltip || dialog || deepScroll;
      }, undefined, { timeout: 8_000 });
      secondNavigationSignal = 'observed';
    } catch (error) {
      secondNavigationSignal = error instanceof Error ? error.name : 'timeout';
    }
  }
  const afterSecondClick = await snapshot();
  const fieldPrompt = signerFrame.getByText(/^Click to insert field$/i);
  let fieldHitTest: Record<string, unknown> | undefined;
  if ((await fieldPrompt.count()) === 1 && await fieldPrompt.isVisible()) {
    const tooltipId = await fieldPrompt.getAttribute('id');
    if (tooltipId) {
      const field = signerFrame.locator(`[aria-describedby=${JSON.stringify(tooltipId)}]`);
      const fieldBox = await field.boundingBox();
      const frameBox = await frameElement.boundingBox();
      const internal = await field.evaluate(element => {
        const describeHit = (hit: Element | null) => hit ? {
          tag: hit.tagName.toLowerCase(),
          text: (hit.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
          className: typeof hit.className === 'string'
            ? hit.className.replace(/\s+/g, ' ').trim().slice(0, 160)
            : '',
          ariaDescribedBy: hit.getAttribute('aria-describedby'),
          dataTestId: hit.getAttribute('data-testid')
        } : null;
        const rect = element.getBoundingClientRect();
        const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        const hit = document.elementFromPoint(point.x, point.y);
        return {
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          point,
          hit: describeHit(hit),
          directHit: hit === element,
          descendantHit: Boolean(hit && element.contains(hit))
        };
      });
      const outerPoint = fieldBox ? {
        x: fieldBox.x + fieldBox.width / 2,
        y: fieldBox.y + fieldBox.height / 2
      } : undefined;
      const outerHit = outerPoint
        ? await registrationPage.evaluate(point => {
            const hit = document.elementFromPoint(point.x, point.y);
            return hit ? {
              tag: hit.tagName.toLowerCase(),
              text: (hit.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
              className: typeof hit.className === 'string'
                ? hit.className.replace(/\s+/g, ' ').trim().slice(0, 160)
                : ''
            } : null;
          }, outerPoint)
        : null;
      fieldHitTest = { tooltipId, fieldBox, frameBox, internal, outerPoint, outerHit };
    }
  }
  const diagnosticPath = testInfo.outputPath('registration-field-navigation-diagnostic.json');
  await writeFile(
    diagnosticPath,
    JSON.stringify({
      navigationSignal,
      secondNavigationSignal,
      before,
      afterFirstClick,
      afterSecondClick,
      fieldHitTest
    }, null, 2),
    'utf8'
  );
  await testInfo.attach('registration-field-navigation-diagnostic.json', {
    path: diagnosticPath,
    contentType: 'application/json'
  });
  await registrationPage.screenshot({
    path: testInfo.outputPath('registration-field-navigation.png'),
    fullPage: false
  });
});
