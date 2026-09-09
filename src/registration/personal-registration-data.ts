import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

export type RegistrationPoolEntryStatus = 'available' | 'reserved' | 'consumed';

export type RegistrationPoolEntry = {
  id: string;
  email: string;
  phone: string;
  sandboxOnly: true;
  status: RegistrationPoolEntryStatus;
  journeyRunId?: string;
  reservedAt?: string;
  consumedAt?: string;
};

type RegistrationPoolFile = {
  schemaVersion: 1;
  entries: RegistrationPoolEntry[];
};

export type RegistrationDataReadiness = {
  ready: boolean;
  availableCount: number;
  canGenerate: boolean;
  blockers: string[];
};

const knownDuplicatePhoneHashes = new Set([
  '428ff2c7f60ad932dd93130bb39a2ef907ec105fddd670c1e2cb1a5cd04354fa'
]);

function hashPhone(value: string): string {
  return createHash('sha256').update(normalizePhone(value)).digest('hex');
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizePhone(value: string): string {
  return value.replace(/\D/g, '');
}

export function maskRegistrationEmail(value: string): string {
  const normalized = normalizeEmail(value);
  const [local = '', domain = ''] = normalized.split('@');
  return `${local.slice(0, 3)}***@${domain}`;
}

export function maskRegistrationPhone(value: string): string {
  const normalized = normalizePhone(value);
  return normalized.length >= 7
    ? `${normalized.slice(0, 3)}****${normalized.slice(-4)}`
    : '***';
}

export function isKnownDuplicateSandboxPhone(value: string): boolean {
  return knownDuplicatePhoneHashes.has(hashPhone(value));
}

function assertLocalWorkspacePath(path: string): string {
  const resolved = resolve(process.cwd(), path);
  const workspaceRelativePath = relative(process.cwd(), resolved);
  if (
    workspaceRelativePath.startsWith('..') ||
    workspaceRelativePath === '' ||
    resolve(process.cwd(), workspaceRelativePath) !== resolved
  ) {
    throw new Error('Personal registration data pool must be a file inside the workspace.');
  }
  return resolved;
}

function assertEntry(entry: RegistrationPoolEntry): void {
  if (!/^[A-Z0-9._-]+$/i.test(entry.id)) {
    throw new Error('Registration pool entry id contains unsupported characters.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(entry.email))) {
    throw new Error(`Registration pool entry ${entry.id} has an invalid Sandbox email.`);
  }
  const phone = normalizePhone(entry.phone);
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    throw new Error(`Registration pool entry ${entry.id} has an invalid Sandbox phone format.`);
  }
  if (entry.sandboxOnly !== true) {
    throw new Error(`Registration pool entry ${entry.id} is not marked sandboxOnly.`);
  }
  if (isKnownDuplicateSandboxPhone(phone)) {
    throw new Error(`Registration pool entry ${entry.id} uses a known duplicate Sandbox phone.`);
  }
  if (!['available', 'reserved', 'consumed'].includes(entry.status)) {
    throw new Error(`Registration pool entry ${entry.id} has an unsupported status.`);
  }
}

function parsePool(path: string): RegistrationPoolFile {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RegistrationPoolFile>;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error('Personal registration data pool has an unsupported schema.');
  }

  const entries = (parsed.entries as Array<RegistrationPoolEntry & { password?: unknown }>).map(
    ({ password: _legacyPassword, ...entry }) => entry
  );
  entries.forEach(assertEntry);
  const emails = entries.map(entry => normalizeEmail(entry.email));
  const phones = entries.map(entry => normalizePhone(entry.phone));
  if (new Set(emails).size !== emails.length) {
    throw new Error('Personal registration data pool contains duplicate emails.');
  }
  if (new Set(phones).size !== phones.length) {
    throw new Error('Personal registration data pool contains duplicate phones.');
  }

  return { schemaVersion: 1, entries };
}

export class PersonalRegistrationDataPool {
  readonly path: string;

  constructor(path: string) {
    this.path = assertLocalWorkspacePath(path);
  }

  readiness(): RegistrationDataReadiness {
    if (!existsSync(this.path)) {
      return {
        ready: false,
        availableCount: 0,
        canGenerate: false,
        blockers: [
          'Sandbox personal registration data pool is missing. Create the ignored local pool from test-data/personal-registration-pool.example.json.'
        ]
      };
    }

    try {
      const pool = parsePool(this.path);
      const availableCount = pool.entries.filter(entry => entry.status === 'available').length;
      return {
        ready: availableCount > 0,
        availableCount,
        canGenerate: false,
        blockers:
          availableCount > 0
            ? []
            : ['Sandbox personal registration data pool has no available email/phone pair.']
      };
    } catch (error) {
      return {
        ready: false,
        availableCount: 0,
        canGenerate: false,
        blockers: [error instanceof Error ? error.message : String(error)]
      };
    }
  }

  addAvailable(input: Pick<RegistrationPoolEntry, 'id' | 'email' | 'phone' | 'sandboxOnly'>): RegistrationPoolEntry {
    const pool = existsSync(this.path)
      ? parsePool(this.path)
      : { schemaVersion: 1 as const, entries: [] };
    const entry: RegistrationPoolEntry = { ...input, status: 'available' };
    assertEntry(entry);
    const email = normalizeEmail(entry.email);
    const phone = normalizePhone(entry.phone);
    if (pool.entries.some(candidate => normalizeEmail(candidate.email) === email)) {
      throw new Error('Generated registration email already exists in the local data pool.');
    }
    if (pool.entries.some(candidate => normalizePhone(candidate.phone) === phone)) {
      throw new Error('Generated registration phone already exists in the local data pool.');
    }
    pool.entries.push(entry);
    this.write(pool);
    return { ...entry };
  }

  scrubLegacyCredentials(): boolean {
    if (!existsSync(this.path)) return false;
    const raw = JSON.parse(readFileSync(this.path, 'utf8')) as {
      entries?: Array<Record<string, unknown>>;
    };
    const containsLegacyCredential = raw.entries?.some(entry => 'password' in entry) ?? false;
    if (!containsLegacyCredential) return false;
    this.write(parsePool(this.path));
    return true;
  }

  peekAvailable(emailOverride?: string): RegistrationPoolEntry | undefined {
    if (!existsSync(this.path)) return undefined;
    const pool = parsePool(this.path);
    const entry = pool.entries.find(candidate => candidate.status === 'available');
    if (!entry) return undefined;
    if (!emailOverride) return { ...entry };
    const email = normalizeEmail(emailOverride);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('PERSONAL_REGISTRATION_EMAIL is not a valid email address.');
    }
    if (
      pool.entries.some(candidate =>
        candidate.id !== entry.id && normalizeEmail(candidate.email) === email
      )
    ) {
      throw new Error('The configured registration email already belongs to another pool entry.');
    }
    return { ...entry, email };
  }

  reserve(
    runId: string,
    expectedEntryId?: string,
    emailOverride?: string,
    now = new Date()
  ): RegistrationPoolEntry {
    if (!/^[A-Z0-9._-]+$/i.test(runId)) {
      throw new Error('Registration runId contains unsupported characters.');
    }
    if (!existsSync(this.path)) {
      throw new Error('Sandbox personal registration data pool is missing.');
    }

    const pool = parsePool(this.path);
    const entry = expectedEntryId
      ? pool.entries.find(candidate =>
          candidate.id === expectedEntryId && candidate.status === 'available'
        )
      : pool.entries.find(candidate => candidate.status === 'available');
    if (!entry) {
      throw new Error(
        expectedEntryId
          ? 'The preflighted Sandbox registration entry is no longer available.'
          : 'Sandbox personal registration data pool has no available entry.'
      );
    }

    if (emailOverride) {
      const email = normalizeEmail(emailOverride);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error('PERSONAL_REGISTRATION_EMAIL is not a valid email address.');
      }
      if (
        pool.entries.some(candidate =>
          candidate.id !== entry.id && normalizeEmail(candidate.email) === email
        )
      ) {
        throw new Error('The configured registration email already belongs to another pool entry.');
      }
      entry.email = email;
    }

    entry.status = 'reserved';
    entry.journeyRunId = runId;
    entry.reservedAt = now.toISOString();
    this.write(pool);
    return { ...entry };
  }

  markConsumed(runId: string, now = new Date()): RegistrationPoolEntry {
    const pool = parsePool(this.path);
    const entry = pool.entries.find(candidate => candidate.journeyRunId === runId);
    if (!entry || entry.status !== 'reserved') {
      throw new Error('Registration data can only be consumed from this journey reservation.');
    }
    entry.status = 'consumed';
    entry.consumedAt = now.toISOString();
    this.write(pool);
    return { ...entry };
  }

  findByRunId(runId: string): RegistrationPoolEntry | undefined {
    if (!existsSync(this.path)) return undefined;
    const entry = parsePool(this.path).entries.find(candidate => candidate.journeyRunId === runId);
    return entry ? { ...entry } : undefined;
  }

  reservedRunIds(): string[] {
    if (!existsSync(this.path)) return [];
    return parsePool(this.path).entries
      .filter(entry => entry.status === 'reserved' && entry.journeyRunId)
      .map(entry => entry.journeyRunId!);
  }

  releaseUnsubmitted(runId: string): RegistrationPoolEntry {
    const pool = parsePool(this.path);
    const entry = pool.entries.find(candidate => candidate.journeyRunId === runId);
    if (!entry || entry.status !== 'reserved') {
      throw new Error('Only a reserved registration identity can be released.');
    }
    entry.status = 'available';
    delete entry.journeyRunId;
    delete entry.reservedAt;
    this.write(pool);
    return { ...entry };
  }

  private write(pool: RegistrationPoolFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(pool, null, 2), 'utf8');
    renameSync(temporaryPath, this.path);
  }
}
