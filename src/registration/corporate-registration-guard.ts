import { assertSandboxEnvironment } from '../flow-engine/mutation-guard';

export class CorporateRegistrationGuard {
  private accountCreateAttempts = 0;
  private signingCompleted = false;
  private finalSubmitAttempts = 0;

  validateRuntime(input: {
    baseURL: string | undefined;
    workers: number;
    retries: number;
    repeatEach: number;
    allowClientMutationTests: boolean;
  }): void {
    assertSandboxEnvironment(input.baseURL);
    if (input.workers !== 1) throw new Error('REG-C-002 requires workers=1.');
    if (input.retries !== 0) throw new Error('REG-C-002 requires retries=0.');
    if (input.repeatEach !== 1) throw new Error('REG-C-002 requires repeatEach=1.');
    if (!input.allowClientMutationTests) {
      throw new Error('REG-C-002 requires ALLOW_CLIENT_MUTATION_TESTS=true for this approved run.');
    }
  }

  restore(input: {
    accountCreateAttemptCount: number;
    signingCompleted: boolean;
    finalSubmitCount: number;
  }): void {
    this.accountCreateAttempts = input.accountCreateAttemptCount;
    this.signingCompleted = input.signingCompleted;
    this.finalSubmitAttempts = input.finalSubmitCount;
  }

  assertAccountCreationAllowed(): void {
    if (this.accountCreateAttempts !== 0) {
      throw new Error('REG-C-002 corporate account creation is limited to once per Journey.');
    }
  }

  recordAccountCreationAttempt(): void {
    this.assertAccountCreationAllowed();
    this.accountCreateAttempts += 1;
  }

  markSigningCompleted(): void {
    this.signingCompleted = true;
  }

  assertFinalSubmissionAllowed(): void {
    if (!this.signingCompleted) {
      throw new Error('Corporate KYC final submission is blocked until signing is completed.');
    }
    if (this.finalSubmitAttempts !== 0) {
      throw new Error('Corporate KYC final submission is limited to once per Journey.');
    }
  }

  recordFinalSubmissionAttempt(): void {
    this.assertFinalSubmissionAllowed();
    this.finalSubmitAttempts += 1;
  }
}

