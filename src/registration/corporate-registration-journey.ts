import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { isKnownDuplicateSandboxPhone, normalizeEmail, normalizePhone } from './personal-registration-data';
import { toAlphabeticSuffix } from './registration-sequence';

export const CORPORATE_REGISTRATION_STAGES = [
  'PREPARED',
  'ACCOUNT_CREATED',
  'BASIC_PROFILE',
  'OPERATIONS',
  'SOURCE_OF_ASSETS',
  'COMPLIANCE',
  'AUTHORIZED_REPRESENTATIVE',
  'DIRECTORS',
  'SHAREHOLDERS',
  'UBO',
  'DOCUMENTS',
  'AUTHORIZATION',
  'SIGNING_COMPLETED',
  'KYC_SUBMITTED',
  'COMPLETED'
] as const;

export type CorporateRegistrationJourneyStage =
  (typeof CORPORATE_REGISTRATION_STAGES)[number];

export type CorporateRegistrationJourney = {
  schemaVersion: 1;
  runId: string;
  sequence: number;
  nameSuffix: string;
  displayName: string;
  companyName?: string;
  email: string;
  phone: string;
  stage: CorporateRegistrationJourneyStage;
  accountCreateAttemptCount: 0 | 1;
  accountCreateCount: 0 | 1;
  uploadedDocumentIds: string[];
  directorCount: number;
  shareholderCount: number;
  uboCount: number;
  signingCompleted: boolean;
  finalSubmitCount: 0 | 1;
  clientFinalState?: string;
  registrationTime?: string;
  userId?: string;
  clientSubmittedAt?: string;
  createdAt: string;
  updatedAt: string;
};

type CorporateSequenceFile = {
  schemaVersion: 1;
  lastSequence: number;
};

type GeneratedCorporateUser = {
  runId: string;
  sequence: number;
  email: string;
  phone: string;
  displayName: string;
  status: 'reserved' | 'consumed';
  createdAt: string;
};

type GeneratedCorporateUsersFile = {
  schemaVersion: 1;
  users: GeneratedCorporateUser[];
};

const journeyPath = resolve('.journey-context/corporate/reg-c-002-current.json');
const journeyHistoryRoot = resolve('.journey-context/corporate/history');
const sequencePath = resolve('test-data/corporate-registration-sequence.json');
const generatedUsersPath = resolve('test-data/corporate-generated-users.local.json');

function stageIndex(stage: CorporateRegistrationJourneyStage): number {
  return CORPORATE_REGISTRATION_STAGES.indexOf(stage);
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, path);
}

function readSequence(): CorporateSequenceFile {
  if (!existsSync(sequencePath)) return { schemaVersion: 1, lastSequence: 0 };
  const value = JSON.parse(readFileSync(sequencePath, 'utf8')) as CorporateSequenceFile;
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.lastSequence) || value.lastSequence < 0) {
    throw new Error('Corporate registration sequence file is invalid.');
  }
  return value;
}

function readGeneratedUsers(): GeneratedCorporateUsersFile {
  if (!existsSync(generatedUsersPath)) return { schemaVersion: 1, users: [] };
  const value = JSON.parse(readFileSync(generatedUsersPath, 'utf8')) as GeneratedCorporateUsersFile;
  if (value.schemaVersion !== 1 || !Array.isArray(value.users)) {
    throw new Error('Corporate generated-user registry is invalid.');
  }
  return value;
}

function createRunId(now: Date): string {
  return `REGC-${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
}

function identityFor(
  sequence: number,
  now: Date,
  users: readonly GeneratedCorporateUser[],
  emailOverride?: string,
  phoneOverride?: string
) {
  const nameSuffix = toAlphabeticSuffix(sequence);
  const timestamp = now.toISOString().replace(/\D/g, '').slice(2, 14);
  const email = normalizeEmail(
    emailOverride ?? `regc.${nameSuffix.toLowerCase()}.${timestamp}@sandbox.fidere.test`
  );
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('CORPORATE_REGISTRATION_EMAIL is not a valid email address.');
  }
  if (users.some(user => normalizeEmail(user.email) === email)) {
    throw new Error('Corporate registration email already exists in the local registry.');
  }
  const seed = Number(`${timestamp.slice(-7)}${sequence % 10}`) % 100_000_000;

  for (let offset = 0; offset < 20; offset += 1) {
    const phone = phoneOverride
      ? normalizePhone(phoneOverride)
      : `166${String((seed + offset) % 100_000_000).padStart(8, '0')}`;
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      throw new Error('CORPORATE_REGISTRATION_PHONE is not a valid Sandbox phone format.');
    }
    if (isKnownDuplicateSandboxPhone(phone)) continue;
    if (users.some(user => normalizePhone(user.phone) === phone)) continue;
    if (users.some(user => normalizeEmail(user.email) === email)) {
      throw new Error('Corporate email generation collided with the local registry.');
    }
    return {
      nameSuffix,
      displayName: `TEST SANDBOX CORP ${nameSuffix}`,
      email,
      phone
    };
  }
  throw new Error('Corporate Sandbox phone generation exhausted its bounded candidates.');
}

function assertJourney(value: CorporateRegistrationJourney): void {
  if (value.schemaVersion !== 1 || !CORPORATE_REGISTRATION_STAGES.includes(value.stage)) {
    throw new Error('Corporate Journey has an unsupported schema or stage.');
  }
  if (!/^TEST SANDBOX CORP [A-Z]{2,}$/.test(value.displayName)) {
    throw new Error('Corporate Journey display name must use a pure alphabetic suffix.');
  }
  if (value.accountCreateCount < 0 || value.accountCreateCount > 1) {
    throw new Error('Corporate account creation count is invalid.');
  }
  if (value.finalSubmitCount < 0 || value.finalSubmitCount > 1) {
    throw new Error('Corporate final submit count is invalid.');
  }
  if ('password' in value || 'otp' in value || 'token' in value || 'cookie' in value) {
    throw new Error('Corporate Journey contains forbidden authentication data.');
  }
}

export class CorporateRegistrationJourneyStore {
  loadRun(runId: string): CorporateRegistrationJourney | undefined {
    if (!/^[A-Z0-9._-]+$/i.test(runId)) throw new Error('Invalid Corporate source runId.');
    const current = this.load();
    if (current?.runId === runId) return current;
    const path = resolve(journeyHistoryRoot, `${runId}.json`);
    if (!existsSync(path)) return undefined;
    const value = JSON.parse(readFileSync(path, 'utf8')) as CorporateRegistrationJourney;
    assertJourney(value);
    if (value.runId !== runId) throw new Error('Corporate source runId mismatch.');
    return value;
  }
  readonly path = journeyPath;

  load(): CorporateRegistrationJourney | undefined {
    if (!existsSync(this.path)) return undefined;
    const value = JSON.parse(readFileSync(this.path, 'utf8')) as CorporateRegistrationJourney;
    assertJourney(value);
    return value;
  }

  create(
    now = new Date(),
    emailOverride?: string,
    phoneOverride?: string,
    options: { archiveIncomplete?: boolean; companyName?: string } = {}
  ): CorporateRegistrationJourney {
    const existing = this.load();
    if (existing && existing.stage !== 'COMPLETED' && !options.archiveIncomplete) {
      throw new Error(`REG-C-002 already has Journey ${existing.runId}; resume it instead of creating another account.`);
    }
    if (existing) {
      writeJsonAtomic(resolve(journeyHistoryRoot, `${existing.runId}.json`), existing);
    }
    const sequenceState = readSequence();
    const sequence = sequenceState.lastSequence + 1;
    const registry = readGeneratedUsers();
    const identity = identityFor(
      sequence,
      now,
      registry.users,
      emailOverride,
      phoneOverride
    );
    const timestamp = now.toISOString();
    const journey: CorporateRegistrationJourney = {
      schemaVersion: 1,
      runId: createRunId(now),
      sequence,
      ...identity,
      companyName: options.companyName?.trim() || identity.displayName,
      stage: 'PREPARED',
      accountCreateAttemptCount: 0,
      accountCreateCount: 0,
      uploadedDocumentIds: [],
      directorCount: 0,
      shareholderCount: 0,
      uboCount: 0,
      signingCompleted: false,
      finalSubmitCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    registry.users.push({
      runId: journey.runId,
      sequence,
      email: journey.email,
      phone: journey.phone,
      displayName: journey.displayName,
      status: 'reserved',
      createdAt: timestamp
    });
    writeJsonAtomic(sequencePath, { schemaVersion: 1, lastSequence: sequence });
    writeJsonAtomic(generatedUsersPath, registry);
    writeJsonAtomic(this.path, journey);
    return journey;
  }

  markAccountCreated(current: CorporateRegistrationJourney, now = new Date()): CorporateRegistrationJourney {
    if (
      current.accountCreateAttemptCount !== 1 ||
      current.accountCreateCount !== 0 ||
      current.stage !== 'PREPARED'
    ) {
      throw new Error('Corporate account may be created only once from PREPARED.');
    }
    const registry = readGeneratedUsers();
    const user = registry.users.find(candidate => candidate.runId === current.runId);
    if (!user) throw new Error('Corporate generated-user reservation is missing.');
    user.status = 'consumed';
    writeJsonAtomic(generatedUsersPath, registry);
    return this.update(current, {
      stage: 'ACCOUNT_CREATED',
      accountCreateCount: 1,
      registrationTime: now.toISOString()
    }, now);
  }

  recordAccountCreateAttempt(current: CorporateRegistrationJourney): CorporateRegistrationJourney {
    if (current.stage !== 'PREPARED' || current.accountCreateAttemptCount !== 0) {
      throw new Error('Corporate account creation may be attempted only once.');
    }
    return this.update(current, { accountCreateAttemptCount: 1 });
  }

  advance(
    current: CorporateRegistrationJourney,
    stage: CorporateRegistrationJourneyStage,
    updates: Partial<Omit<CorporateRegistrationJourney, 'schemaVersion' | 'runId' | 'stage'>> = {},
    now = new Date()
  ): CorporateRegistrationJourney {
    if (stageIndex(stage) <= stageIndex(current.stage)) {
      throw new Error(`Corporate Journey must advance beyond ${current.stage}.`);
    }
    return this.update(current, { ...updates, stage }, now);
  }

  update(
    current: CorporateRegistrationJourney,
    updates: Partial<Omit<CorporateRegistrationJourney, 'schemaVersion' | 'runId'>>,
    now = new Date()
  ): CorporateRegistrationJourney {
    const next = { ...current, ...updates, updatedAt: now.toISOString() };
    this.save(next);
    return next;
  }

  recordDocument(current: CorporateRegistrationJourney, documentId: string): CorporateRegistrationJourney {
    if (current.uploadedDocumentIds.includes(documentId)) return current;
    return this.update(current, {
      uploadedDocumentIds: [...current.uploadedDocumentIds, documentId]
    });
  }

  save(value: CorporateRegistrationJourney): void {
    assertJourney(value);
    const existing = this.load();
    if (existing && existing.runId !== value.runId) {
      throw new Error('REG-C-002 cannot replace its active Corporate Journey.');
    }
    if (existing && stageIndex(value.stage) < stageIndex(existing.stage)) {
      throw new Error('Corporate Journey cannot move backwards.');
    }
    writeJsonAtomic(this.path, value);
  }
}

export function corporateJourneyStageAtLeast(
  current: CorporateRegistrationJourneyStage,
  expected: CorporateRegistrationJourneyStage
): boolean {
  return stageIndex(current) >= stageIndex(expected);
}
