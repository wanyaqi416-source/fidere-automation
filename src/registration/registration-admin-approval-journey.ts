import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { RegistrationKycCase, RegistrationKycStage } from './registration-kyc-contract';

export const REGISTRATION_ADMIN_APPROVAL_STAGES = [
  'CLIENT_KYC_SUBMITTED',
  'ADMIN_LOCATED',
  'ADMIN_APPROVAL_ATTEMPTED',
  'ADMIN_APPROVED',
  'CLIENT_FINALIZED',
  'COMPLETED'
] as const;

export type RegistrationAdminApprovalStage =
  (typeof REGISTRATION_ADMIN_APPROVAL_STAGES)[number];

export type RegistrationApprovalAccountType = 'personal' | 'corporate';

export type RegistrationAdminApprovalJourney = {
  schemaVersion: 1;
  flowId: 'personal-registration-admin-approval' | 'corporate-registration-admin-approval';
  sourceRunId: string;
  accountType: RegistrationApprovalAccountType;
  displayName: string;
  email: string;
  clientSubmittedAt?: string;
  userId?: string;
  processPath?: string;
  applicationId?: string;
  kycStage?: RegistrationKycStage;
  kycVerifiedAt?: string;
  approvalAttempts?: Array<{ step: string; attemptedAt: string; confirmedAt?: string }>;
  stage: RegistrationAdminApprovalStage;
  reviewId?: string;
  adminApproveCount: 0 | 1;
  approvalPreExisted: boolean;
  adminFinalState?: string;
  clientFinalState?: string;
  createdAt: string;
  updatedAt: string;
};

const statePaths: Record<RegistrationApprovalAccountType, string> = {
  personal: resolve('.journey-context/registration-approval/reg-p-003-current.json'),
  corporate: resolve('.journey-context/registration-approval/reg-c-003-current.json')
};

function stageIndex(stage: RegistrationAdminApprovalStage): number {
  return REGISTRATION_ADMIN_APPROVAL_STAGES.indexOf(stage);
}

function assertState(value: RegistrationAdminApprovalJourney): void {
  if (value.schemaVersion !== 1) throw new Error('Unsupported Registration approval state schema.');
  if (!REGISTRATION_ADMIN_APPROVAL_STAGES.includes(value.stage)) {
    throw new Error('Unsupported Registration approval Resume stage.');
  }
  if (value.adminApproveCount < 0 || value.adminApproveCount > 1) {
    throw new Error('Registration Admin Approve count must be zero or one.');
  }
  if ('password' in value || 'otp' in value || 'token' in value || 'cookie' in value) {
    throw new Error('Registration approval state contains forbidden authentication data.');
  }
}

function writeAtomic(path: string, value: RegistrationAdminApprovalJourney): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, path);
}

export class RegistrationAdminApprovalJourneyStore {
  readonly path: string;
  private readonly legacyPath: string;
  private readonly activePath: string;

  constructor(
    readonly accountType: RegistrationApprovalAccountType,
    private readonly sourceRunId?: string,
    root = resolve('.journey-context/registration-approval')
  ) {
    if (sourceRunId && !/^[A-Z0-9._-]+$/i.test(sourceRunId)) {
      throw new Error('Registration approval sourceRunId contains unsupported characters.');
    }
    this.path = sourceRunId
      ? resolve(root, accountType, `${sourceRunId}.json`)
      : statePaths[accountType];
    this.legacyPath = resolve(root, accountType === 'personal' ? 'reg-p-003-current.json' : 'reg-c-003-current.json');
    this.activePath = resolve(root, `active-${accountType}.json`);
  }

  load(): RegistrationAdminApprovalJourney | undefined {
    const path = existsSync(this.path) ? this.path : this.legacyPath;
    if (!existsSync(path)) return undefined;
    const value = JSON.parse(readFileSync(path, 'utf8')) as RegistrationAdminApprovalJourney;
    if (this.sourceRunId && value.sourceRunId !== this.sourceRunId) {
      if (path === this.legacyPath) return undefined;
      throw new Error('KYC state sourceRunId mismatch.');
    }
    assertState(value);
    return value;
  }

  initialize(input: {
    flowId: RegistrationAdminApprovalJourney['flowId'];
    sourceRunId: string;
    displayName: string;
    email: string;
    clientSubmittedAt?: string;
    userId?: string;
    reviewId?: string;
  }): RegistrationAdminApprovalJourney {
    const existing = this.load();
    if (existing) {
      if (existing.sourceRunId !== input.sourceRunId || existing.email !== input.email) {
        throw new Error(
          `${input.flowId} already has a Resume state for another submitted account; replacement is forbidden.`
        );
      }
      if ((input.reviewId && existing.reviewId && input.reviewId !== existing.reviewId) ||
          (input.userId && existing.userId && input.userId !== existing.userId)) {
        throw new Error('KYC state cannot bind another user or reviewId.');
      }
      return existing;
    }

    const now = new Date().toISOString();
    const value: RegistrationAdminApprovalJourney = {
      schemaVersion: 1,
      flowId: input.flowId,
      sourceRunId: input.sourceRunId,
      accountType: this.accountType,
      displayName: input.displayName,
      email: input.email,
      clientSubmittedAt: input.clientSubmittedAt,
      userId: input.userId,
      reviewId: input.reviewId,
      kycStage: this.accountType === 'personal' ? 'PERSONAL_REGISTRATION_SUBMITTED' : 'BUSINESS_REGISTRATION_SUBMITTED',
      approvalAttempts: [],
      stage: 'CLIENT_KYC_SUBMITTED',
      adminApproveCount: 0,
      approvalPreExisted: false,
      createdAt: now,
      updatedAt: now
    };
    this.save(value);
    return value;
  }

  advance(
    current: RegistrationAdminApprovalJourney,
    stage: RegistrationAdminApprovalStage,
    updates: Partial<Omit<RegistrationAdminApprovalJourney, 'schemaVersion' | 'flowId' | 'sourceRunId' | 'accountType' | 'stage'>> = {}
  ): RegistrationAdminApprovalJourney {
    if (stageIndex(stage) <= stageIndex(current.stage)) {
      throw new Error(`Registration approval Journey must advance beyond ${current.stage}.`);
    }
    const next: RegistrationAdminApprovalJourney = {
      ...current,
      ...updates,
      stage,
      updatedAt: new Date().toISOString()
    };
    this.save(next);
    return next;
  }

  recordApproveAttempt(
    current: RegistrationAdminApprovalJourney
  ): RegistrationAdminApprovalJourney {
    if (current.stage !== 'ADMIN_LOCATED') {
      throw new Error(`Admin Approve may start only from ADMIN_LOCATED; received ${current.stage}.`);
    }
    if (current.adminApproveCount !== 0) {
      throw new Error('Registration Admin Approve has already been attempted for this Resume.');
    }
    return this.advance(current, 'ADMIN_APPROVAL_ATTEMPTED', { adminApproveCount: 1 });
  }

  save(value: RegistrationAdminApprovalJourney): void {
    assertState(value);
    const existing = this.load();
    if (existing && existing.sourceRunId !== value.sourceRunId) {
      throw new Error('Registration approval Resume state cannot replace another submitted account.');
    }
    if (existing && stageIndex(value.stage) < stageIndex(existing.stage)) {
      throw new Error('Registration approval Resume state cannot move backwards.');
    }
    if (existing && value.adminApproveCount < existing.adminApproveCount) {
      throw new Error('Registration Admin Approve count cannot decrease.');
    }
    if (existing && (existing.email !== value.email || existing.accountType !== value.accountType ||
        (existing.reviewId && existing.reviewId !== value.reviewId) ||
        (existing.userId && existing.userId !== value.userId) ||
        (existing.applicationId && existing.applicationId !== value.applicationId) ||
        (existing.processPath && existing.processPath !== value.processPath))) {
      throw new Error('KYC Resume cannot switch the original user or reviewId.');
    }
    const attempts = value.approvalAttempts ?? [];
    if (new Set(attempts.map(item => item.step)).size !== attempts.length) {
      throw new Error('KYC review step may be attempted only once.');
    }
    for (const previous of existing?.approvalAttempts ?? []) {
      const next = attempts.find(item => item.step === previous.step);
      if (!next || next.attemptedAt !== previous.attemptedAt ||
          (previous.confirmedAt && next.confirmedAt !== previous.confirmedAt)) {
        throw new Error('KYC approval attempt journal cannot be reset.');
      }
    }
    writeAtomic(this.path, value);
  }

  bindCase(current: RegistrationAdminApprovalJourney, candidate: RegistrationKycCase): RegistrationAdminApprovalJourney {
    return this.updateKyc(current, {
      userId: candidate.userId, reviewId: candidate.reviewId, processPath: candidate.processPath,
      applicationId: candidate.applicationId,
      kycStage: current.kycVerifiedAt ? 'CLIENT_KYC_APPROVED' : this.accountType === 'personal'
        ? 'ADMIN_PERSONAL_CASE_FOUND' : 'ADMIN_BUSINESS_CASE_FOUND',
      stage: stageIndex(current.stage) < stageIndex('ADMIN_LOCATED') ? 'ADMIN_LOCATED' : current.stage
    });
  }

  recordStageApprovalAttempt(current: RegistrationAdminApprovalJourney, step: string): RegistrationAdminApprovalJourney {
    if (!current.reviewId || !current.processPath) throw new Error('KYC approval requires a pinned case.');
    if (current.approvalAttempts?.some(item => item.step === step)) {
      throw new Error('KYC_APPROVAL_ALREADY_ATTEMPTED: query the original case; do not click again.');
    }
    return this.updateKyc(current, {
      adminApproveCount: 1,
      stage: stageIndex(current.stage) < stageIndex('ADMIN_APPROVAL_ATTEMPTED') ? 'ADMIN_APPROVAL_ATTEMPTED' : current.stage,
      approvalAttempts: [...current.approvalAttempts ?? [], { step, attemptedAt: new Date().toISOString() }]
    });
  }

  confirmStageApproval(current: RegistrationAdminApprovalJourney, step: string): RegistrationAdminApprovalJourney {
    return this.updateKyc(current, {
      approvalAttempts: (current.approvalAttempts ?? []).map(item => item.step === step
        ? { ...item, confirmedAt: item.confirmedAt ?? new Date().toISOString() } : item)
    });
  }

  updateKyc(current: RegistrationAdminApprovalJourney, updates: Partial<RegistrationAdminApprovalJourney>): RegistrationAdminApprovalJourney {
    const next = { ...current, ...updates, updatedAt: new Date().toISOString() };
    this.save(next);
    return next;
  }

  markActive(sourceRunId: string): void {
    if (sourceRunId !== this.sourceRunId) throw new Error('Active KYC source must match the pinned store.');
    mkdirSync(dirname(this.activePath), { recursive: true });
    const temporary = `${this.activePath}.tmp`;
    writeFileSync(temporary, JSON.stringify({ sourceRunId, accountType: this.accountType }), 'utf8');
    renameSync(temporary, this.activePath);
  }

  static activeSourceRunId(accountType: RegistrationApprovalAccountType, root = resolve('.journey-context/registration-approval')): string | undefined {
    const path = resolve(root, `active-${accountType}.json`);
    if (!existsSync(path)) return undefined;
    const value = JSON.parse(readFileSync(path, 'utf8')) as { sourceRunId: string; accountType: string };
    if (value.accountType !== accountType || !/^[A-Z0-9._-]+$/i.test(value.sourceRunId)) throw new Error('Invalid active KYC source.');
    return value.sourceRunId;
  }
}

export function registrationApprovalStageAtLeast(
  current: RegistrationAdminApprovalStage,
  expected: RegistrationAdminApprovalStage
): boolean {
  return stageIndex(current) >= stageIndex(expected);
}
