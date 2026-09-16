import { clientRouteUrl } from '../../../pages/client/HomePage';
import { LoginPage } from '../../../pages/client/LoginPage';
import { PersonalOnboardingPage } from '../../../pages/client/PersonalOnboardingPage';
import { RegistrationAgreementSigner } from '../../../pages/client/registration/RegistrationAgreementSigner';
import { expect, test } from '../../../fixtures/registration.fixture';
import { env } from '../../../src/config/env';
import {
  PersonalJourneyContextStore,
  registrationTestNameForSequence
} from '../../../src/registration';

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for Registration final Submit Preflight.`);
  return value;
}

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'Registration completed document final Submit preflight @registration @personal @readonly',
  async ({ registrationPage }, testInfo) => {
    test.setTimeout(90_000);
    const baseUrl = required('CLIENT_BASE_URL', env.client.baseUrl);
    const email = required('PERSONAL_REGISTRATION_EMAIL', env.personalRegistration.email);
    const journey = new PersonalJourneyContextStore().findByEmail(email);
    expect(journey?.sequence).toBeTruthy();
    const testName = registrationTestNameForSequence(journey!.sequence!);

    const login = new LoginPage(registrationPage);
    await login.goto(clientRouteUrl(baseUrl, 'login'));
    await login.fillCredentials({
      username: email,
      password: required('CLIENT_PASSWORD', env.client.password)
    });
    await login.submitCredentials();
    await login.expectOtpStep();
    await login.fillOtp(required('CLIENT_OTP', env.client.otp));
    await login.confirmLoginToAuthenticatedRoute();
    await registrationPage.goto(new URL('/zh-CN/registration?type=individual', baseUrl).toString(), {
      waitUntil: 'domcontentloaded'
    });

    const onboarding = new PersonalOnboardingPage(registrationPage);
    expect(await onboarding.currentStep()).toBe('authorization');
    const signer = new RegistrationAgreementSigner(registrationPage);
    await signer.open(testName.displayName);
    const completed = await signer.inspectCompletedAgreement();
    const readiness = await onboarding.inspectFinalSubmitReadiness();
    const button = onboarding.submitButton;
    const buttonState = await button.evaluate(element => {
      const value = element as HTMLButtonElement;
      return {
        tag: value.tagName,
        type: value.type,
        disabled: value.disabled,
        ariaDisabled: value.getAttribute('aria-disabled'),
        formAction: value.form?.action ? new URL(value.form.action).pathname : null,
        formMethod: value.form?.method ?? null
      };
    });
    const reactHandlers = await button.evaluate(element => {
      const readHandler = (target: Element | null, name: string) => {
        if (!target) return undefined;
        const record = target as unknown as Record<string, unknown>;
        for (const key of Object.keys(record)) {
          if (!key.startsWith('__reactProps$')) continue;
          const props = record[key];
          if (typeof props !== 'object' || props === null) continue;
          const handler = (props as Record<string, unknown>)[name];
          if (typeof handler === 'function') return String(handler).slice(0, 4_000);
        }
        return undefined;
      };
      const value = element as HTMLButtonElement;
      return {
        onClick: readHandler(value, 'onClick'),
        onSubmit: readHandler(value.form, 'onSubmit')
      };
    });
    const bundleGuards: Array<{ script: string; needle: string; snippet: string }> = [];
    const declaredScriptUrls = await registrationPage.locator('script[src]').evaluateAll(nodes =>
      nodes.map(node => (node as HTMLScriptElement).src).filter(Boolean)
    );
    const loadedScriptUrls = await registrationPage.evaluate(() =>
      performance.getEntriesByType('resource')
        .map(entry => entry.name)
        .filter(url => /\.js(?:$|\?)/i.test(url))
    );
    const scriptUrls = [...new Set([...declaredScriptUrls, ...loadedScriptUrls])];
    for (const scriptUrl of scriptUrls) {
      if (new URL(scriptUrl).origin !== new URL(registrationPage.url()).origin) continue;
      const response = await registrationPage.request.get(scriptUrl);
      if (!response.ok()) continue;
      const source = await response.text();
      for (const needle of [
        'member-profile',
        'client_authorization_status',
        'authorization_status'
      ]) {
        const index = source.indexOf(needle);
        if (index < 0) continue;
        bundleGuards.push({
          script: new URL(scriptUrl).pathname,
          needle,
          snippet: source.slice(Math.max(0, index - 1_500), index + 1_500)
        });
      }
    }
    const alerts: string[] = [];
    for (const alert of await registrationPage.getByRole('alert').all()) {
      if (!await alert.isVisible()) continue;
      const text = (await alert.innerText()).replace(/\s+/g, ' ').trim();
      if (text) alerts.push(text.slice(0, 300));
    }
    const evidence = {
      documentCompleted: completed.completed,
      remainingFields: completed.remainingFields,
      finalSubmitEnabled: await onboarding.isFinalSubmitEnabled(),
      finalSubmitHandlerReady: await onboarding.isFinalSubmitHandlerReady(),
      readiness,
      buttonState,
      reactHandlers,
      bundleGuards,
      kycStep: 'Not queried',
      kycStepStatus: 'Sandbox endpoint is encrypted',
      signingStatus: 'Verified by completed document and final-submit readiness',
      visibleAlerts: alerts
    };
    console.log(`REG-P final Submit preflight: ${JSON.stringify(evidence)}`);
    await testInfo.attach('registration-final-submit-preflight.json', {
      body: Buffer.from(JSON.stringify(evidence, null, 2)),
      contentType: 'application/json'
    });
  }
);
