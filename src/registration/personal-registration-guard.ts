import { assertSandboxEnvironment } from '../flow-engine/mutation-guard';

export type PersonalRegistrationRuntime = {
  baseURL: string | undefined;
  workers: number;
  retries: number;
  repeatEach: number;
  allowClientMutationTests: boolean;
};

export class PersonalRegistrationGuard {
  private adminAuthenticationReady = false;
  private dataReady = false;
  private otpRequests = 0;
  private registrationSubmissions = 0;
  private profileFinalSubmissions = 0;
  private profileFinalSubmissionAttempts = 0;
  private firstProfileAttemptHadNoRequest = false;
  private registrationSignatureFieldCompleted = false;
  private registrationRemainingFields?: number;
  private authorizationStepCompleted = false;
  private registrationSigningCompleted = false;

  validateRuntime(runtime: PersonalRegistrationRuntime): void {
    assertSandboxEnvironment(runtime.baseURL);
    if (runtime.workers !== 1) throw new Error('REG-P-002 requires workers=1.');
    if (runtime.retries !== 0) throw new Error('REG-P-002 requires retries=0.');
    if (runtime.repeatEach !== 1) throw new Error('REG-P-002 requires repeatEach=1.');
    if (!runtime.allowClientMutationTests) {
      throw new Error('REG-P-002 requires ALLOW_CLIENT_MUTATION_TESTS=true for one approved run.');
    }
  }

  markAdminAuthenticationReady(): void {
    this.adminAuthenticationReady = true;
  }

  markJourneyDataReady(): void {
    this.dataReady = true;
  }

  assertOtpRequestAllowed(): void {
    this.assertPreconditions();
    if (this.otpRequests > 0) throw new Error('Registration OTP request is limited to once per run.');
    if (this.registrationSubmissions > 0) throw new Error('User registration was already submitted.');
  }

  recordOtpRequest(): void {
    if (this.otpRequests > 0) throw new Error('Registration OTP request was already recorded.');
    this.otpRequests += 1;
  }

  assertRegistrationSubmissionAllowed(): void {
    this.assertPreconditions();
    if (this.otpRequests !== 1) {
      throw new Error('Registration submission requires exactly one OTP request.');
    }
    if (this.registrationSubmissions > 0) {
      throw new Error('User registration is limited to once per journey.');
    }
  }

  recordRegistrationSubmission(): void {
    if (this.registrationSubmissions > 0) {
      throw new Error('User registration was already recorded.');
    }
    this.registrationSubmissions += 1;
  }

  restoreRegisteredUser(): void {
    if (this.registrationSubmissions > 0) return;
    this.otpRequests = 1;
    this.registrationSubmissions = 1;
  }

  markRegistrationSigningCompleted(input: {
    signatureFieldCompleted: boolean;
    remainingFields: number;
    authorizationStepCompleted: boolean;
    fidereSigningRecognized: boolean;
  }): void {
    this.registrationSignatureFieldCompleted = input.signatureFieldCompleted;
    this.registrationRemainingFields = input.remainingFields;
    this.authorizationStepCompleted = input.authorizationStepCompleted;
    this.registrationSigningCompleted =
      input.signatureFieldCompleted &&
      input.remainingFields === 0 &&
      input.authorizationStepCompleted &&
      input.fidereSigningRecognized;
    if (!this.registrationSigningCompleted) {
      throw new Error(
        'Registration signing gate requires a completed signature field, zero remaining fields, Fidere recognition, and a completed Authorization step.'
      );
    }
  }

  assertProfileFinalSubmissionAllowed(): void {
    this.assertPreconditions();
    if (this.registrationSubmissions !== 1) {
      throw new Error('Personal profile completion requires one registered user.');
    }
    if (this.profileFinalSubmissions > 0) {
      throw new Error('Personal profile final submission is limited to once per journey.');
    }
    if (
      !this.registrationSignatureFieldCompleted ||
      this.registrationRemainingFields !== 0 ||
      !this.authorizationStepCompleted ||
      !this.registrationSigningCompleted
    ) {
      throw new Error(
        'Personal profile final submission is blocked until Registration Agreement signing is complete with zero remaining fields and a completed Authorization step.'
      );
    }
  }

  assertProfileFinalSubmissionAttemptAllowed(
    mode: 'post-sign-initial' | 'state-desync-recovery'
  ): void {
    this.assertProfileFinalSubmissionAllowed();
    if (mode === 'post-sign-initial' && this.profileFinalSubmissionAttempts !== 0) {
      throw new Error('The post-sign initial profile submission attempt was already used.');
    }
    if (
      mode === 'state-desync-recovery' &&
      (this.profileFinalSubmissionAttempts !== 1 || !this.firstProfileAttemptHadNoRequest)
    ) {
      throw new Error(
        'Profile submission recovery requires exactly one prior click with no member-profile request.'
      );
    }
  }

  recordProfileFinalSubmissionAttempt(input: {
    mode: 'post-sign-initial' | 'state-desync-recovery';
    requestObserved: boolean;
  }): void {
    if (this.profileFinalSubmissionAttempts >= 2) {
      throw new Error('Personal profile submission permits at most two bounded A/B attempts.');
    }
    if (input.mode === 'post-sign-initial' && this.profileFinalSubmissionAttempts !== 0) {
      throw new Error('Unexpected duplicate post-sign initial submission attempt.');
    }
    if (
      input.mode === 'state-desync-recovery' &&
      (this.profileFinalSubmissionAttempts !== 1 || !this.firstProfileAttemptHadNoRequest)
    ) {
      throw new Error('Unexpected profile submission recovery attempt.');
    }
    this.profileFinalSubmissionAttempts += 1;
    if (input.mode === 'post-sign-initial' && !input.requestObserved) {
      this.firstProfileAttemptHadNoRequest = true;
    }
  }

  recordProfileFinalSubmission(): void {
    if (this.profileFinalSubmissions > 0) {
      throw new Error('Personal profile final submission was already recorded.');
    }
    this.profileFinalSubmissions += 1;
  }

  snapshot() {
    return {
      adminAuthenticationReady: this.adminAuthenticationReady,
      dataReady: this.dataReady,
      otpRequests: this.otpRequests,
      registrationSubmissions: this.registrationSubmissions,
      profileFinalSubmissions: this.profileFinalSubmissions,
      profileFinalSubmissionAttempts: this.profileFinalSubmissionAttempts,
      firstProfileAttemptHadNoRequest: this.firstProfileAttemptHadNoRequest,
      registrationSignatureFieldCompleted: this.registrationSignatureFieldCompleted,
      registrationRemainingFields: this.registrationRemainingFields,
      authorizationStepCompleted: this.authorizationStepCompleted,
      registrationSigningCompleted: this.registrationSigningCompleted
    };
  }

  private assertPreconditions(): void {
    if (!this.dataReady) {
      throw new Error('Unique Sandbox registration data preflight has not passed.');
    }
  }
}
