import { clientRouteUrl } from '../../../pages/client/HomePage';
import { LoginPage } from '../../../pages/client/LoginPage';
import { PersonalOnboardingPage } from '../../../pages/client/PersonalOnboardingPage';
import { RegistrationAgreementSigner } from '../../../pages/client/registration/RegistrationAgreementSigner';
import { expect, test } from '../../../fixtures/registration.fixture';
import { env } from '../../../src/config/env';
import {
  FidereSigningStatusReader,
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
    const status = await new FidereSigningStatusReader(registrationPage).read();
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
      kycStep: status.kycStep,
      kycStepStatus: status.kycStepStatus,
      signingStatus: status.clientSigningStatus,
      visibleAlerts: alerts
    };
    console.log(`REG-P final Submit preflight: ${JSON.stringify(evidence)}`);
    await testInfo.attach('registration-final-submit-preflight.json', {
      body: Buffer.from(JSON.stringify(evidence, null, 2)),
      contentType: 'application/json'
    });
  }
);
