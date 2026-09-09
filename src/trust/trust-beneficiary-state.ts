import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const TRUST_BENEFICIARY_FLOW_ID = 'trust-beneficiary-golden-journey';

export const TRUST_BENEFICIARY_STAGES = [
  'TRUST_READY',
  'BENEFICIARY_CREATE_ATTEMPTED',
  'BENEFICIARY_CREATION_UNCONFIRMED',
  'BENEFICIARY_SECURITY_REQUIRED',
  'BENEFICIARY_SECURITY_VERIFICATION_ATTEMPTED',
  'BENEFICIARY_POST_SECURITY_UNCONFIRMED',
  'BENEFICIARY_CREATED',
  'BENEFICIARY_BANK_ACCOUNT_CREATE_ATTEMPTED',
  'BENEFICIARY_BANK_ACCOUNT_CREATED',
  'ADMIN_TRUST_FOUND',
  'ADMIN_BENEFICIARY_FOUND',
  'ADMIN_BENEFICIARY_APPROVAL_ATTEMPTED',
  'ADMIN_BENEFICIARY_APPROVED',
  'ADMIN_BANK_ACCOUNT_FOUND',
  'ADMIN_BANK_ACCOUNT_APPROVAL_ATTEMPTED',
  'ADMIN_BANK_ACCOUNT_APPROVED',
  'CLIENT_BENEFICIARY_APPROVED',
  'CLIENT_BANK_ACCOUNT_APPROVED',
  'BENEFICIARY_DATA_VERIFIED'
] as const;

export type TrustBeneficiaryStage = (typeof TRUST_BENEFICIARY_STAGES)[number];

export type TrustBeneficiaryState = {
  schemaVersion: 1;
  runId: string;
  sourceRunId: string;
  sourceUserHash: string;
  trustNumber?: string;
  beneficiaryName: string;
  beneficiaryReference?: string;
  beneficiaryEmailHash: string;
  beneficiaryIdSuffix: string;
  beneficiaryStatus?: string;
  bankAccountSuffix: string;
  bankAccountReference?: string;
  bankAccountStatus?: string;
  beneficiaryCreateCount: 0 | 1;
  beneficiaryConfirmationClickCount?: 0 | 1 | 2;
  securityVerificationCount?: 0 | 1;
  securityDialogObserved?: boolean;
  bankAccountCreateCount: 0 | 1;
  bankAccountConfirmationClickCount?: 0 | 1;
  bankSecurityVerificationCount?: 0 | 1;
  beneficiaryApproveCount: 0 | 1;
  bankAccountApproveCount: 0 | 1;
  beneficiarySubmittedAt?: string;
  bankAccountSubmittedAt?: string;
  stage: TrustBeneficiaryStage;
  createdAt: string;
  updatedAt: string;
};

export function trustIdentityHash(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

export function trustBeneficiaryStageAtLeast(current: TrustBeneficiaryStage, expected: TrustBeneficiaryStage): boolean {
  return TRUST_BENEFICIARY_STAGES.indexOf(current) >= TRUST_BENEFICIARY_STAGES.indexOf(expected);
}

function validate(state: TrustBeneficiaryState): TrustBeneficiaryState {
  if (state.schemaVersion !== 1 || !/^[A-Z0-9._-]+$/i.test(state.runId) || !/^[A-Z0-9._-]+$/i.test(state.sourceRunId)) {
    throw new Error('Unsupported Trust Beneficiary Resume state.');
  }
  if (!TRUST_BENEFICIARY_STAGES.includes(state.stage)) throw new Error('Unsupported Trust Beneficiary stage.');
  for (const count of [state.beneficiaryCreateCount, state.bankAccountCreateCount, state.beneficiaryApproveCount, state.bankAccountApproveCount]) {
    if (count !== 0 && count !== 1) throw new Error('Trust Beneficiary mutation counts must be zero or one.');
  }
  if (state.beneficiaryConfirmationClickCount !== undefined && ![0, 1, 2].includes(state.beneficiaryConfirmationClickCount)) {
    throw new Error('Beneficiary confirmation click count must be zero, one, or one bounded recovery click.');
  }
  if (state.securityVerificationCount !== undefined && ![0, 1].includes(state.securityVerificationCount)) {
    throw new Error('Security Key verification count must be zero or one.');
  }
  if (state.bankAccountConfirmationClickCount !== undefined && ![0, 1].includes(state.bankAccountConfirmationClickCount)) {
    throw new Error('Bank Account confirmation click count must be zero or one.');
  }
  if (state.bankSecurityVerificationCount !== undefined && ![0, 1].includes(state.bankSecurityVerificationCount)) {
    throw new Error('Bank Account Security Key verification count must be zero or one.');
  }
  const serialized = JSON.stringify(state);
  if (/password|otp|securityKey|cookie|token|authorization/i.test(serialized)) {
    throw new Error('Trust Beneficiary state contains forbidden authentication data.');
  }
  return state;
}

export class TrustBeneficiaryStateStore {
  readonly path: string;

  constructor(readonly runId: string) {
    if (!/^[A-Z0-9._-]+$/i.test(runId)) throw new Error('Unsupported Trust Beneficiary runId.');
    this.path = resolve('.flow-state', TRUST_BENEFICIARY_FLOW_ID, `${runId}.json`);
  }

  load(): TrustBeneficiaryState | undefined {
    if (!existsSync(this.path)) return undefined;
    return validate(JSON.parse(readFileSync(this.path, 'utf8')) as TrustBeneficiaryState);
  }

  initialize(input: Omit<TrustBeneficiaryState, 'schemaVersion' | 'stage' | 'createdAt' | 'updatedAt' |
    'trustNumber' | 'beneficiaryReference' | 'beneficiaryStatus' | 'bankAccountReference' | 'bankAccountStatus' |
    'beneficiarySubmittedAt' | 'bankAccountSubmittedAt' | 'beneficiaryCreateCount' | 'bankAccountCreateCount' |
    'beneficiaryApproveCount' | 'bankAccountApproveCount' | 'beneficiaryConfirmationClickCount' |
    'securityVerificationCount' | 'securityDialogObserved'>): TrustBeneficiaryState {
    const existing = this.load();
    if (existing) return existing;
    const now = new Date().toISOString();
    const state: TrustBeneficiaryState = {
      schemaVersion: 1, ...input, stage: 'TRUST_READY', createdAt: now, updatedAt: now,
      beneficiaryCreateCount: 0, beneficiaryConfirmationClickCount: 0, securityVerificationCount: 0,
      securityDialogObserved: false, bankAccountCreateCount: 0, beneficiaryApproveCount: 0, bankAccountApproveCount: 0
    };
    this.save(state);
    return state;
  }

  advance(state: TrustBeneficiaryState, stage: TrustBeneficiaryStage, updates: Partial<TrustBeneficiaryState> = {}): TrustBeneficiaryState {
    if (TRUST_BENEFICIARY_STAGES.indexOf(stage) <= TRUST_BENEFICIARY_STAGES.indexOf(state.stage)) {
      throw new Error(`Trust Beneficiary state must advance beyond ${state.stage}.`);
    }
    const next = validate({ ...state, ...updates, stage, updatedAt: new Date().toISOString() });
    this.save(next);
    return next;
  }

  save(state: TrustBeneficiaryState): void {
    validate(state);
    const existing = this.load();
    if (existing && TRUST_BENEFICIARY_STAGES.indexOf(state.stage) < TRUST_BENEFICIARY_STAGES.indexOf(existing.stage)) {
      throw new Error('Trust Beneficiary state cannot move backwards.');
    }
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(`${this.path}.tmp`, this.path);
  }
}
