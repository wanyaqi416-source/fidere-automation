import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { isValidEmail } from '../src/utils/runtime-email.js';

type TrustLauncherPointer = {
  runId: string;
};

type TrustRunState = {
  stage?: string;
};

const flowStateRoot = resolve('.flow-state', 'trust-beneficiary-golden-journey');
const pointerPath = resolve('.flow-state', 'launcher', 'trust-beneficiary.json');

function statePath(runId: string): string {
  return resolve(flowStateRoot, `${runId}.json`);
}

function readState(runId: string): TrustRunState | undefined {
  const path = statePath(runId);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as TrustRunState;
}

function currentRun(): string | undefined {
  if (!existsSync(pointerPath)) return undefined;
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as TrustLauncherPointer;
  const state = readState(pointer.runId);
  return state?.stage === 'BENEFICIARY_DATA_VERIFIED' ? undefined : pointer.runId;
}

function nextSequence(): number {
  if (!existsSync(flowStateRoot)) return 1;
  return readdirSync(flowStateRoot)
    .map(name => Number(name.match(/-(\d+)\.json$/)?.[1] ?? 0))
    .reduce((highest, value) => Math.max(highest, value), 0) + 1;
}

export function launcherTrustEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const email = environment.CLIENT_USERNAME?.trim() ?? '';
  if (!isValidEmail(email)) {
    throw new Error('TRUST_BENEFICIARY_USER_REQUIRED: 请在 CLIENT_USERNAME 配置合法的Personal测试用户邮箱。');
  }

  const configuredRunId = environment.TRUST_BENEFICIARY_RUN_ID?.trim();
  const runId = configuredRunId || currentRun() ||
    `TBEN-MENU9-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(nextSequence()).padStart(2, '0')}`;

  mkdirSync(dirname(pointerPath), { recursive: true });
  writeFileSync(pointerPath, `${JSON.stringify({ runId }, null, 2)}\n`, 'utf8');
  return {
    TRUST_BENEFICIARY_RUN_ID: runId,
    TRUST_BENEFICIARY_USER_EMAIL: email
  };
}
