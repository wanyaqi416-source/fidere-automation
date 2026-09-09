import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

type RegistrationSequenceFile = {
  schemaVersion: 1;
  lastSequence: number;
};

export type RegistrationTestName = {
  sequence: number;
  sequenceText: string;
  nameSuffix: string;
  displayName: string;
  firstName: 'TEST';
  lastName: string;
};

const ALPHABET_SIZE = 26;
const MINIMUM_SUFFIX_WIDTH = 2;

export function toAlphabeticSuffix(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('Registration sequence must be a positive safe integer.');
  }

  let offset = sequence - 1;
  let width = MINIMUM_SUFFIX_WIDTH;
  let blockSize = ALPHABET_SIZE ** width;
  while (offset >= blockSize) {
    offset -= blockSize;
    width += 1;
    blockSize = ALPHABET_SIZE ** width;
    if (!Number.isSafeInteger(blockSize)) {
      throw new Error('Registration alphabetic sequence is exhausted.');
    }
  }

  const letters = Array.from({ length: width }, () => 'A');
  for (let index = width - 1; index >= 0; index -= 1) {
    letters[index] = String.fromCharCode(65 + (offset % ALPHABET_SIZE));
    offset = Math.floor(offset / ALPHABET_SIZE);
  }
  return letters.join('');
}

export function registrationTestNameForSequence(sequence: number): RegistrationTestName {
  const sequenceText = String(sequence);
  const nameSuffix = toAlphabeticSuffix(sequence);
  return {
    sequence,
    sequenceText,
    nameSuffix,
    displayName: `TEST SANDBOX ${nameSuffix}`,
    firstName: 'TEST',
    lastName: `SANDBOX ${nameSuffix}`
  };
}

function resolveWorkspacePath(path: string): string {
  const absolutePath = resolve(process.cwd(), path);
  const workspaceRelativePath = relative(process.cwd(), absolutePath);
  if (workspaceRelativePath.startsWith('..') || workspaceRelativePath === '') {
    throw new Error('Registration sequence file must be inside the workspace.');
  }
  return absolutePath;
}

function readSequence(path: string): RegistrationSequenceFile {
  if (!existsSync(path)) return { schemaVersion: 1, lastSequence: 0 };
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<RegistrationSequenceFile>;
  if (
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.lastSequence) ||
    value.lastSequence! < 0 ||
    value.lastSequence! === Number.MAX_SAFE_INTEGER
  ) {
    throw new Error('Registration sequence file has an unsupported value.');
  }
  return value as RegistrationSequenceFile;
}

export class RegistrationSequenceStore {
  readonly path: string;

  constructor(path = 'test-data/registration-sequence.json') {
    this.path = resolveWorkspacePath(path);
  }

  nextSequence(): number {
    return readSequence(this.path).lastSequence + 1;
  }

  reserveNext(runId: string): RegistrationTestName {
    if (!/^[A-Z0-9._-]+$/i.test(runId)) {
      throw new Error('Registration sequence requires a safe runId.');
    }
    const current = readSequence(this.path);
    const sequence = current.lastSequence + 1;
    const next: RegistrationSequenceFile = { schemaVersion: 1, lastSequence: sequence };
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${runId}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(next, null, 2), 'utf8');
    renameSync(temporaryPath, this.path);

    return registrationTestNameForSequence(sequence);
  }
}
