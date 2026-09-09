import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

export type FlowExecutionStage = 'PREPARED' | 'CLIENT_CREATED' | 'COMPLETED';

export type FlowExecutionResult = {
  schemaVersion: 1;
  flowId: string;
  runId: string;
  stage: FlowExecutionStage;
  mutationPerformed: boolean;
  reference?: string;
  accountType?: string;
  currency?: string;
  amount?: string;
  balanceBefore?: string;
  balanceAfter?: string;
  updatedAt: string;
};

const forbiddenKeys = new Set([
  'password',
  'otp',
  'securityKey',
  'cookie',
  'token',
  'authorization',
  'storageState'
]);

function assertSafe(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) throw new Error(`Flow execution result contains forbidden field ${key}.`);
    assertSafe(child);
  }
}

function resolveResultPath(path: string): string {
  const absolute = resolve(process.cwd(), path);
  const workspaceRelative = relative(process.cwd(), absolute);
  if (workspaceRelative.startsWith('..') || workspaceRelative === '') {
    throw new Error('Flow execution result path must be inside the workspace.');
  }
  return absolute;
}

export function writeFlowExecutionResult(
  path: string | undefined,
  input: Omit<FlowExecutionResult, 'schemaVersion' | 'updatedAt'>,
  now = new Date()
): void {
  if (!path) return;
  const result: FlowExecutionResult = {
    schemaVersion: 1,
    ...input,
    updatedAt: now.toISOString()
  };
  assertSafe(result);
  const absolute = resolveResultPath(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp`;
  writeFileSync(temporary, JSON.stringify(result, null, 2), 'utf8');
  renameSync(temporary, absolute);
}

export function readFlowExecutionResult(path: string): FlowExecutionResult | undefined {
  const absolute = resolveResultPath(path);
  if (!existsSync(absolute)) return undefined;
  const result = JSON.parse(readFileSync(absolute, 'utf8')) as FlowExecutionResult;
  if (result.schemaVersion !== 1 || !['PREPARED', 'CLIENT_CREATED', 'COMPLETED'].includes(result.stage)) {
    throw new Error('Flow execution result has an unsupported schema or stage.');
  }
  assertSafe(result);
  return result;
}
