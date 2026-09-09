export type MutationRuntime = {
  baseURL: string | undefined;
  workers: number;
  retries: number;
  repeatEach: number;
  safetySwitches: Readonly<Record<string, boolean>>;
};

export type MutationGuardSnapshot = {
  flowId: string;
  authenticationReady: boolean;
  uniqueAdminCandidate: boolean;
  clientMoneyConfirmations: number;
  clientSubmissions: number;
  securityKeyVerifications: number;
  adminActions: number;
};

function isRecognizedTestHost(hostname: string): boolean {
  return (
    ['localhost', '127.0.0.1', '::1'].includes(hostname) ||
    hostname.includes('sandbox') ||
    hostname.includes('staging') ||
    hostname.endsWith('.test')
  );
}

export function assertSandboxEnvironment(baseURL: string | undefined): void {
  if (!baseURL) throw new Error('A test base URL is required before mutation.');
  const { hostname } = new URL(baseURL);
  if (!isRecognizedTestHost(hostname)) {
    throw new Error(`Mutation is forbidden on non-test host: ${hostname}.`);
  }
}

export class MoneyMutationGuard {
  private authenticationReady = false;
  private uniqueAdminCandidate = false;
  private clientMoneyConfirmations = 0;
  private clientSubmissions = 0;
  private securityKeyVerifications = 0;
  private adminActions = 0;

  constructor(
    readonly flowId: string,
    private readonly requiresAdmin = true,
    private readonly requiresSecurityKey = false
  ) {
    if (!flowId.trim()) throw new Error('MoneyMutationGuard requires a flowId.');
  }

  validateRuntime(runtime: MutationRuntime): void {
    assertSandboxEnvironment(runtime.baseURL);
    if (runtime.workers !== 1) {
      throw new Error(`${this.flowId} mutation requires workers=1.`);
    }
    if (runtime.retries !== 0) {
      throw new Error(`${this.flowId} mutation requires retries=0.`);
    }
    if (runtime.repeatEach !== 1) {
      throw new Error(`${this.flowId} mutation requires repeatEach=1.`);
    }

    const disabled = Object.entries(runtime.safetySwitches)
      .filter(([, enabled]) => !enabled)
      .map(([name]) => name);
    if (disabled.length > 0) {
      throw new Error(`${this.flowId} mutation safety switches are closed: ${disabled.join(', ')}.`);
    }
  }

  markAuthenticationReady(clientReady: boolean, adminReady: boolean): void {
    if (!clientReady || (this.requiresAdmin && !adminReady)) {
      throw new Error(
        `${this.flowId} requires valid Client${this.requiresAdmin ? ' and Admin' : ''} sessions before mutation.`
      );
    }
    this.authenticationReady = true;
  }

  assertClientSubmissionAllowed(safetySwitches: Readonly<Record<string, boolean>>): void {
    if (!this.authenticationReady) {
      throw new Error(`${this.flowId} authentication preflight has not completed.`);
    }
    this.assertSwitches(safetySwitches);
    if (this.requiresSecurityKey && this.securityKeyVerifications !== 1) {
      throw new Error(
        `${this.flowId} Client business creation requires exactly one Security Key verification.`
      );
    }
    if (this.clientSubmissions > 0) {
      throw new Error(`${this.flowId} Client submission is limited to once per run.`);
    }
  }

  recordClientSubmission(): void {
    if (this.requiresSecurityKey && this.securityKeyVerifications !== 1) {
      throw new Error(
        `${this.flowId} cannot record Client business creation before Security Key verification.`
      );
    }
    if (this.clientSubmissions > 0) {
      throw new Error(`${this.flowId} Client submission was already recorded.`);
    }
    this.clientSubmissions += 1;
  }

  assertClientMoneyConfirmationAllowed(
    safetySwitches: Readonly<Record<string, boolean>>
  ): void {
    if (!this.authenticationReady) {
      throw new Error(`${this.flowId} authentication preflight has not completed.`);
    }
    this.assertSwitches(safetySwitches);
    if (this.clientMoneyConfirmations > 0) {
      throw new Error(`${this.flowId} Client money confirmation is limited to once per run.`);
    }
    if (this.clientSubmissions > 0) {
      throw new Error(`${this.flowId} Client business was already created.`);
    }
  }

  recordClientMoneyConfirmation(): void {
    if (this.clientMoneyConfirmations > 0) {
      throw new Error(`${this.flowId} Client money confirmation was already recorded.`);
    }
    this.clientMoneyConfirmations += 1;
  }

  assertSecurityKeyVerificationAllowed(
    safetySwitches: Readonly<Record<string, boolean>>
  ): void {
    if (!this.authenticationReady) {
      throw new Error(`${this.flowId} authentication preflight has not completed.`);
    }
    this.assertSwitches(safetySwitches);
    if (this.clientMoneyConfirmations !== 1) {
      throw new Error(
        `${this.flowId} Security Key verification requires exactly one Client money confirmation.`
      );
    }
    if (this.securityKeyVerifications > 0) {
      throw new Error(`${this.flowId} Security Key verification is limited to once per run.`);
    }
  }

  recordSecurityKeyVerification(): void {
    if (this.requiresSecurityKey && this.clientMoneyConfirmations !== 1) {
      throw new Error(
        `${this.flowId} Security Key verification requires one preceding Client money confirmation.`
      );
    }
    if (this.securityKeyVerifications > 0) {
      throw new Error(`${this.flowId} Security Key verification is limited to once per run.`);
    }
    this.securityKeyVerifications += 1;
  }

  recordUniqueAdminCandidate(candidateCount: number): void {
    if (this.clientSubmissions !== 1) {
      throw new Error(`${this.flowId} Admin matching requires Client submission evidence first.`);
    }
    if (candidateCount !== 1) {
      throw new Error(
        `${this.flowId} Admin candidateCount must equal 1; received ${candidateCount}.`
      );
    }
    this.uniqueAdminCandidate = true;
  }

  assertAdminActionAllowed(safetySwitches: Readonly<Record<string, boolean>>): void {
    if (!this.uniqueAdminCandidate) {
      throw new Error(`${this.flowId} Admin action requires candidateCount=1.`);
    }
    this.assertSwitches(safetySwitches);
    if (this.adminActions > 0) {
      throw new Error(`${this.flowId} Admin action is limited to once per run.`);
    }
  }

  recordAdminAction(): void {
    if (this.adminActions > 0) {
      throw new Error(`${this.flowId} Admin action was already recorded.`);
    }
    this.adminActions += 1;
  }

  snapshot(): MutationGuardSnapshot {
    return {
      flowId: this.flowId,
      authenticationReady: this.authenticationReady,
      uniqueAdminCandidate: this.uniqueAdminCandidate,
      clientMoneyConfirmations: this.clientMoneyConfirmations,
      clientSubmissions: this.clientSubmissions,
      securityKeyVerifications: this.securityKeyVerifications,
      adminActions: this.adminActions
    };
  }

  private assertSwitches(safetySwitches: Readonly<Record<string, boolean>>): void {
    const disabled = Object.entries(safetySwitches)
      .filter(([, enabled]) => !enabled)
      .map(([name]) => name);
    if (disabled.length > 0) {
      throw new Error(`${this.flowId} mutation safety switches are closed: ${disabled.join(', ')}.`);
    }
  }
}
