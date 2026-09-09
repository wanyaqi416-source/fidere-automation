import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { JourneyStepId } from '../../config/journey-registry';

export type JourneyFlowDisposition =
  | 'PENDING'
  | 'PASS'
  | 'SKIPPED_NOT_APPLICABLE'
  | 'SKIPPED_PREREQUISITE'
  | 'SKIPPED_NOT_READY'
  | 'BLOCKED'
  | 'FAIL'
  | 'MANUAL_REVIEW';

export type JourneyFlowRecord = {
  id: JourneyStepId;
  disposition: JourneyFlowDisposition;
  startedAt?: string;
  completedAt?: string;
  reason?: string;
};

export type FreshUserJourneyContext = {
  schemaVersion: 1;
  journeyId: string;
  runId: string;
  stage: 'PREPARED' | 'RUNNING' | 'PAUSED' | 'COMPLETED';
  user: {
    accountType?: 'PERSONAL' | 'BUSINESS';
    displayName?: string;
    email?: string;
    phone?: string;
    userId?: string;
    kycStatus?: string;
  };
  account: {
    hongKongUsdBalance?: string;
  };
  references: {
    registrationRunId?: string;
    bootstrapDepositTxn?: string;
    exchangeOrderId?: string;
    exchangeLedgerTransactionId?: string;
    transferTrf?: string;
    transferAdminTxn?: string;
    depositTxn?: string;
    withdrawalTxn?: string;
    bahrainOpeningReference?: string;
    usOpeningReference?: string;
  };
  currentFlow?: JourneyStepId;
  flows: JourneyFlowRecord[];
  resumeFlow?: JourneyStepId;
  totalMutationCount: number;
  unknownMutationState: boolean;
  createdAt: string;
  updatedAt: string;
};

const forbiddenKeys = new Set([
  'password',
  'otp',
  'securityKey',
  'cookie',
  'cookies',
  'token',
  'authorization',
  'storageState'
]);

function assertSafeValue(value: unknown, path = 'context'): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) {
      throw new Error(`Fresh User Journey Context contains forbidden field: ${path}.${key}`);
    }
    assertSafeValue(child, `${path}.${key}`);
  }
}

function assertContext(context: FreshUserJourneyContext): void {
  if (context.schemaVersion !== 1) throw new Error('Unsupported Fresh User Journey schema.');
  if (!/^[A-Z0-9._-]+$/i.test(context.journeyId) || !/^[A-Z0-9._-]+$/i.test(context.runId)) {
    throw new Error('Fresh User Journey identifiers contain unsupported characters.');
  }
  if (!Number.isInteger(context.totalMutationCount) || context.totalMutationCount < 0) {
    throw new Error('Fresh User Journey mutation count is invalid.');
  }
  assertSafeValue(context);
}

export class FreshUserJourneyContextStore {
  constructor(private readonly root = resolve('.journey-context', 'fresh-user')) {}

  pathFor(journeyId: string): string {
    if (!/^[A-Z0-9._-]+$/i.test(journeyId)) {
      throw new Error('Fresh User Journey id contains unsupported characters.');
    }
    return resolve(this.root, `${journeyId}.json`);
  }

  create(input: { journeyId: string; runId: string }, now = new Date()): FreshUserJourneyContext {
    if (this.load(input.journeyId)) {
      throw new Error('Fresh User Journey already exists; resume it instead of creating another user.');
    }
    const timestamp = now.toISOString();
    const context: FreshUserJourneyContext = {
      schemaVersion: 1,
      journeyId: input.journeyId,
      runId: input.runId,
      stage: 'PREPARED',
      user: {},
      account: {},
      references: {},
      flows: [],
      totalMutationCount: 0,
      unknownMutationState: false,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.save(context);
    return context;
  }

  load(journeyId: string): FreshUserJourneyContext | undefined {
    const path = this.pathFor(journeyId);
    if (!existsSync(path)) return undefined;
    const context = JSON.parse(readFileSync(path, 'utf8')) as FreshUserJourneyContext;
    assertContext(context);
    return context;
  }

  save(context: FreshUserJourneyContext, now = new Date()): string {
    const next = { ...context, updatedAt: now.toISOString() };
    assertContext(next);
    const path = this.pathFor(next.journeyId);
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(next, null, 2), 'utf8');
    renameSync(temporaryPath, path);
    return path;
  }
}
