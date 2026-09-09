import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const PERSONAL_POST_REGISTRATION_STAGES = [
  'CLIENT_KYC_SUBMITTED',
  'KYC_PROFILE_APPROVED',
  'KYC_DOCUMENT_APPROVAL_ATTEMPTED',
  'KYC_APPROVED',
  'CLIENT_USABLE',
  'FIAT_ADDRESS_CREATE_ATTEMPTED',
  'FIAT_ADDRESS_CREATED',
  'FIAT_ADDRESS_APPROVAL_ATTEMPTED',
  'FIAT_ADDRESS_APPROVED',
  'DEPOSIT_SUBMISSION_ATTEMPTED',
  'DEPOSIT_CREATED',
  'DEPOSIT_APPROVAL_ATTEMPTED',
  'DEPOSIT_APPROVED',
  'BALANCE_READY',
  'COMPLETED'
] as const;

export type PersonalPostRegistrationStage =
  (typeof PERSONAL_POST_REGISTRATION_STAGES)[number];

export type GoldenJourneyAccountType = 'PERSONAL' | 'BUSINESS';

export type PersonalPostRegistrationJourney = {
  schemaVersion: 1;
  journeyId: string;
  sourceRunId: string;
  accountType: GoldenJourneyAccountType;
  displayName: string;
  email: string;
  stage: PersonalPostRegistrationStage;
  reviewId?: string;
  profileApproveCount: 0 | 1;
  documentApproveCount: 0 | 1;
  fiatAddressCreateCount: 0 | 1;
  fiatAddressApproveCount: 0 | 1;
  depositSubmitCount: 0 | 1;
  depositApproveCount: 0 | 1;
  fiatAddressReference?: string;
  fiatAddressAccountSuffix?: string;
  fiatAddressSubmittedAt?: string;
  depositTransactionId?: string;
  depositAmount?: string;
  depositSubmittedAt?: string;
  depositAdminReference?: string;
  depositActualAmount?: string;
  depositClientStatus?: string;
  depositAdminStatus?: string;
  balanceBefore?: string;
  balanceAfter?: string;
  withdrawal?: {
    runId: string;
    accountType: string;
    currency: string;
    requestedAmount: string;
    balanceBefore: string;
    previousTransactionIds: string[];
    submittedBalance?: string;
    feeAmount?: string;
    netAmount?: string;
    expectedDebit?: string;
    balanceAfter?: string;
    confirmationClicks: 0 | 1;
    securityVerificationClicks: 0 | 1;
    approvalClicks: 0 | 1;
    paymentChannel?: string;
    paymentBank?: string;
    clientStatus?: string;
    adminStatus?: string;
  };
  createdAt: string;
  updatedAt: string;
};

function stageIndex(stage: PersonalPostRegistrationStage): number {
  return PERSONAL_POST_REGISTRATION_STAGES.indexOf(stage);
}

function assertState(state: PersonalPostRegistrationJourney): void {
  if (state.schemaVersion !== 1 || !PERSONAL_POST_REGISTRATION_STAGES.includes(state.stage)) {
    throw new Error('Unsupported Personal post-registration Journey state.');
  }
  for (const count of [
    state.profileApproveCount,
    state.documentApproveCount,
    state.fiatAddressCreateCount,
    state.fiatAddressApproveCount,
    state.depositSubmitCount,
    state.depositApproveCount
  ]) {
    if (count !== 0 && count !== 1) throw new Error('Golden Journey mutation counts must be zero or one.');
  }
  if (state.withdrawal) {
    for (const count of [state.withdrawal.confirmationClicks, state.withdrawal.securityVerificationClicks, state.withdrawal.approvalClicks]) {
      if (count !== 0 && count !== 1) throw new Error('Journey Withdrawal clicks must be zero or one.');
    }
  }
  if ('password' in state || 'otp' in state || 'token' in state || 'cookie' in state) {
    throw new Error('Golden Journey state contains forbidden authentication data.');
  }
}

export class PersonalPostRegistrationJourneyStore {
  readonly path: string;

  constructor(readonly sourceRunId: string) {
    if (!/^[A-Z0-9._-]+$/i.test(sourceRunId)) throw new Error('Unsupported sourceRunId.');
    this.path = resolve('.journey-context/personal-post-registration', `${sourceRunId}.json`);
  }

  load(): PersonalPostRegistrationJourney | undefined {
    if (!existsSync(this.path)) return undefined;
    const state = JSON.parse(readFileSync(this.path, 'utf8')) as PersonalPostRegistrationJourney;
    assertState(state);
    return state;
  }

  initialize(input: {
    accountType: GoldenJourneyAccountType;
    displayName: string;
    email: string;
    reviewId?: string;
    stage?: PersonalPostRegistrationStage;
    profileApproveCount?: 0 | 1;
  }): PersonalPostRegistrationJourney {
    const existing = this.load();
    if (existing) return existing;
    const now = new Date().toISOString();
    const state: PersonalPostRegistrationJourney = {
      schemaVersion: 1,
      journeyId: `POSTREG-${this.sourceRunId}`,
      sourceRunId: this.sourceRunId,
      accountType: input.accountType,
      displayName: input.displayName,
      email: input.email,
      stage: input.stage ?? 'CLIENT_KYC_SUBMITTED',
      reviewId: input.reviewId,
      profileApproveCount: input.profileApproveCount ?? 0,
      documentApproveCount: 0,
      fiatAddressCreateCount: 0,
      fiatAddressApproveCount: 0,
      depositSubmitCount: 0,
      depositApproveCount: 0,
      createdAt: now,
      updatedAt: now
    };
    this.save(state);
    return state;
  }

  advance(
    state: PersonalPostRegistrationJourney,
    stage: PersonalPostRegistrationStage,
    updates: Partial<Omit<PersonalPostRegistrationJourney, 'schemaVersion' | 'journeyId' | 'sourceRunId' | 'stage'>> = {}
  ): PersonalPostRegistrationJourney {
    if (stageIndex(stage) <= stageIndex(state.stage)) {
      throw new Error(`Personal post-registration Journey must advance beyond ${state.stage}.`);
    }
    const next = { ...state, ...updates, stage, updatedAt: new Date().toISOString() };
    this.save(next);
    return next;
  }

  recordDocumentApprovalAttempt(state: PersonalPostRegistrationJourney): PersonalPostRegistrationJourney {
    if (state.stage !== 'KYC_PROFILE_APPROVED' || state.documentApproveCount !== 0) {
      throw new Error('KYC document approval is not eligible for another attempt.');
    }
    return this.advance(state, 'KYC_DOCUMENT_APPROVAL_ATTEMPTED', { documentApproveCount: 1 });
  }

  recordFiatAddressCreateAttempt(
    state: PersonalPostRegistrationJourney,
    accountSuffix: string
  ): PersonalPostRegistrationJourney {
    if (state.stage !== 'CLIENT_USABLE' || state.fiatAddressCreateCount !== 0) {
      throw new Error('Fiat address creation is not eligible for another attempt.');
    }
    return this.advance(state, 'FIAT_ADDRESS_CREATE_ATTEMPTED', {
      fiatAddressCreateCount: 1,
      fiatAddressAccountSuffix: accountSuffix
    });
  }

  recordFiatAddressApprovalAttempt(
    state: PersonalPostRegistrationJourney
  ): PersonalPostRegistrationJourney {
    if (state.stage !== 'FIAT_ADDRESS_CREATED' || state.fiatAddressApproveCount !== 0) {
      throw new Error('Fiat address approval is not eligible for another attempt.');
    }
    return this.advance(state, 'FIAT_ADDRESS_APPROVAL_ATTEMPTED', {
      fiatAddressApproveCount: 1
    });
  }

  recordDepositSubmissionAttempt(
    state: PersonalPostRegistrationJourney,
    input: { amount: string; balanceBefore: string; submittedAt: string }
  ): PersonalPostRegistrationJourney {
    if (state.stage !== 'FIAT_ADDRESS_APPROVED' || state.depositSubmitCount !== 0) {
      throw new Error('Deposit submission is not eligible for another attempt.');
    }
    return this.advance(state, 'DEPOSIT_SUBMISSION_ATTEMPTED', {
      depositSubmitCount: 1,
      depositAmount: input.amount,
      balanceBefore: input.balanceBefore,
      depositSubmittedAt: input.submittedAt
    });
  }

  recordDepositApprovalAttempt(
    state: PersonalPostRegistrationJourney,
    adminReference?: string
  ): PersonalPostRegistrationJourney {
    if (state.stage !== 'DEPOSIT_CREATED' || state.depositApproveCount !== 0) {
      throw new Error('Deposit approval is not eligible for another attempt.');
    }
    return this.advance(state, 'DEPOSIT_APPROVAL_ATTEMPTED', {
      depositApproveCount: 1,
      depositAdminReference: adminReference ?? state.depositAdminReference
    });
  }

  save(state: PersonalPostRegistrationJourney): void {
    assertState(state);
    const existing = this.load();
    if (existing && existing.sourceRunId !== state.sourceRunId) {
      throw new Error('Golden Journey state cannot replace another source user.');
    }
    if (existing && stageIndex(state.stage) < stageIndex(existing.stage)) {
      throw new Error('Golden Journey state cannot move backwards.');
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temporary, this.path);
  }
}

export function postRegistrationStageAtLeast(
  current: PersonalPostRegistrationStage,
  expected: PersonalPostRegistrationStage
): boolean {
  return stageIndex(current) >= stageIndex(expected);
}
