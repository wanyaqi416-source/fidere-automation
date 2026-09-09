import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';

export const PERSONAL_REGISTRATION_STAGES = [
  'PREPARED',
  'REGISTRATION_SUBMITTED',
  'USER_REGISTERED',
  'CLIENT_AUTHENTICATED',
  'AUTHORIZATION_REQUIRED',
  'DOCUMENT_COMPLETED',
  'FIDERE_SIGNING_RECOGNIZED',
  'PROFILE_COMPLETED',
  'ADMIN_USER_LOCATED',
  'COMPLETED'
] as const;

export type PersonalRegistrationStage = (typeof PERSONAL_REGISTRATION_STAGES)[number];

export const PERSONAL_JOURNEY_LIFECYCLES = [
  'ACTIVE',
  'RESUMABLE',
  'COMPLETED',
  'ABANDONED'
] as const;

export type PersonalJourneyLifecycle = (typeof PERSONAL_JOURNEY_LIFECYCLES)[number];

export type PersonalJourneyContext = {
  schemaVersion: 1;
  runId: string;
  email: string;
  phone: string;
  sequence?: number;
  displayName?: string;
  userId?: string;
  registrationTime?: string;
  clientSubmittedAt?: string;
  clientStatus?: string;
  authorizationDocumentRecoveryCount?: number;
  signingSyncStatus?: 'PENDING' | 'FAILED' | 'RECOGNIZED';
  lifecycle?: PersonalJourneyLifecycle;
  abandonedReason?: string;
  stage: PersonalRegistrationStage;
  createdAt: string;
  updatedAt: string;
};

function stageIndex(stage: PersonalRegistrationStage): number {
  return PERSONAL_REGISTRATION_STAGES.indexOf(stage);
}

export function registrationStageAtLeast(
  current: PersonalRegistrationStage,
  expected: PersonalRegistrationStage
): boolean {
  return stageIndex(current) >= stageIndex(expected);
}

function assertContext(context: PersonalJourneyContext): void {
  if (context.schemaVersion !== 1) throw new Error('Unsupported Journey Context schema.');
  if (!/^[A-Z0-9._-]+$/i.test(context.runId)) {
    throw new Error('Journey Context runId contains unsupported characters.');
  }
  if (!PERSONAL_REGISTRATION_STAGES.includes(context.stage)) {
    throw new Error('Journey Context has an unsupported registration stage.');
  }
  if (context.lifecycle && !PERSONAL_JOURNEY_LIFECYCLES.includes(context.lifecycle)) {
    throw new Error('Journey Context has an unsupported lifecycle.');
  }
  if ('password' in context || 'otp' in context || 'token' in context || 'cookie' in context) {
    throw new Error('Journey Context contains forbidden authentication data.');
  }
  if (context.sequence !== undefined && (!Number.isInteger(context.sequence) || context.sequence < 1)) {
    throw new Error('Journey Context registration sequence is invalid.');
  }
  if (
    context.authorizationDocumentRecoveryCount !== undefined &&
    (!Number.isInteger(context.authorizationDocumentRecoveryCount) ||
      context.authorizationDocumentRecoveryCount < 0 ||
      context.authorizationDocumentRecoveryCount > 1)
  ) {
    throw new Error('Registration authorization document recovery count is invalid.');
  }
  if (
    context.displayName !== undefined &&
    !/^TEST SANDBOX (?:[A-Z]{2,}|\d{3})$/.test(context.displayName)
  ) {
    throw new Error('Journey Context test display name is invalid.');
  }
}

export class PersonalJourneyContextStore {
  constructor(private readonly root = resolve('.journey-context', 'personal')) {}

  pathFor(runId: string): string {
    if (!/^[A-Z0-9._-]+$/i.test(runId)) {
      throw new Error('Journey Context runId contains unsupported characters.');
    }
    return resolve(this.root, `${runId}.json`);
  }

  load(runId: string): PersonalJourneyContext | undefined {
    const path = this.pathFor(runId);
    if (!existsSync(path)) return undefined;
    const context = JSON.parse(readFileSync(path, 'utf8')) as PersonalJourneyContext;
    assertContext(context);
    return context;
  }

  list(): PersonalJourneyContext[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => {
        const context = JSON.parse(
          readFileSync(resolve(this.root, entry.name), 'utf8')
        ) as PersonalJourneyContext;
        assertContext(context);
        return context;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  requireSingleJourney(): PersonalJourneyContext | undefined {
    const contexts = this.list();
    if (contexts.length > 1) {
      throw new Error(
        `REG-P-002 found ${contexts.length} Journey Contexts. Resolve them explicitly before registration.`
      );
    }
    return contexts[0];
  }

  findCurrentRecoverableJourney(): PersonalJourneyContext | undefined {
    return this.list()
      .filter(context =>
        this.lifecycleOf(context) !== 'ABANDONED' &&
        context.sequence !== undefined &&
        context.displayName !== undefined &&
        stageIndex(context.stage) >= stageIndex('USER_REGISTERED') &&
        stageIndex(context.stage) < stageIndex('PROFILE_COMPLETED')
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  lifecycleOf(context: PersonalJourneyContext): PersonalJourneyLifecycle {
    if (context.lifecycle) return context.lifecycle;
    if (stageIndex(context.stage) >= stageIndex('PROFILE_COMPLETED')) return 'COMPLETED';
    if (stageIndex(context.stage) >= stageIndex('USER_REGISTERED')) return 'RESUMABLE';
    return 'ACTIVE';
  }

  markAbandoned(
    current: PersonalJourneyContext,
    reason: string,
    now = new Date()
  ): PersonalJourneyContext {
    if (this.lifecycleOf(current) === 'COMPLETED') {
      throw new Error('A completed Personal Journey cannot be abandoned.');
    }
    const abandonedReason = reason.trim();
    if (!abandonedReason) throw new Error('Abandoned Personal Journey requires a reason.');
    const next = {
      ...current,
      lifecycle: 'ABANDONED' as const,
      abandonedReason,
      updatedAt: now.toISOString()
    };
    this.save(next);
    return next;
  }

  findByEmail(email: string): PersonalJourneyContext | undefined {
    const normalizedEmail = email.trim().toLowerCase();
    const matches = this.list().filter(
      context => context.email.trim().toLowerCase() === normalizedEmail
    );
    if (matches.length > 1) {
      throw new Error(
        `REG-P-002 found ${matches.length} Journey Contexts for the configured email.`
      );
    }
    return matches[0];
  }

  create(
    input: {
      runId: string;
      email: string;
      phone: string;
      sequence?: number;
      displayName?: string;
    },
    now = new Date()
  ): PersonalJourneyContext {
    if (this.load(input.runId)) {
      throw new Error('Journey Context already exists; resume it instead of registering again.');
    }
    const timestamp = now.toISOString();
    const context: PersonalJourneyContext = {
      schemaVersion: 1,
      ...input,
      stage: 'PREPARED',
      lifecycle: 'ACTIVE',
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.save(context);
    return context;
  }

  advance(
    current: PersonalJourneyContext,
    stage: PersonalRegistrationStage,
    updates: Pick<PersonalJourneyContext, 'userId' | 'registrationTime' | 'clientStatus' | 'clientSubmittedAt'> = {},
    now = new Date()
  ): PersonalJourneyContext {
    if (stageIndex(stage) <= stageIndex(current.stage)) {
      throw new Error(`Registration Journey must advance beyond ${current.stage}.`);
    }
    const lifecycle: PersonalJourneyLifecycle = stageIndex(stage) >= stageIndex('PROFILE_COMPLETED')
      ? 'COMPLETED'
      : stageIndex(stage) >= stageIndex('USER_REGISTERED')
        ? 'RESUMABLE'
        : 'ACTIVE';
    const next = { ...current, ...updates, stage, lifecycle, updatedAt: now.toISOString() };
    this.save(next);
    return next;
  }

  updatePreSubmitDisplayName(
    current: PersonalJourneyContext,
    displayName: string,
    now = new Date()
  ): PersonalJourneyContext {
    if (stageIndex(current.stage) >= stageIndex('PROFILE_COMPLETED')) {
      throw new Error('Registration display name cannot change after final profile submission.');
    }
    if (!/^TEST SANDBOX [A-Z]{2,}$/.test(displayName)) {
      throw new Error('Registration display name must use a pure alphabetic suffix.');
    }
    const next = { ...current, displayName, updatedAt: now.toISOString() };
    this.save(next);
    return next;
  }

  recordSigningSync(
    current: PersonalJourneyContext,
    status: NonNullable<PersonalJourneyContext['signingSyncStatus']>,
    input: { authorizationDocumentRecoveryAttempted?: boolean } = {},
    now = new Date()
  ): PersonalJourneyContext {
    const recoveryCount = input.authorizationDocumentRecoveryAttempted
      ? (current.authorizationDocumentRecoveryCount ?? 0) + 1
      : current.authorizationDocumentRecoveryCount;
    const next = {
      ...current,
      authorizationDocumentRecoveryCount: recoveryCount,
      signingSyncStatus: status,
      clientStatus: status === 'FAILED' ? 'Signing Sync Failed' : current.clientStatus,
      updatedAt: now.toISOString()
    };
    this.save(next);
    return next;
  }

  save(context: PersonalJourneyContext): string {
    assertContext(context);
    const existing = this.load(context.runId);
    if (existing && stageIndex(context.stage) < stageIndex(existing.stage)) {
      throw new Error('Registration Journey cannot move backwards.');
    }
    const path = this.pathFor(context.runId);
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(context, null, 2), 'utf8');
    renameSync(temporaryPath, path);
    return path;
  }
}
