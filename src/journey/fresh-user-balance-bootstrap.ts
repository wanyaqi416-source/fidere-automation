import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Decimal from 'decimal.js';

export const FRESH_USER_BOOTSTRAP_STAGES = [
  'PREPARED',
  'BOOTSTRAP_CONFIRMATION_REQUIRED',
  'BOOTSTRAP_SUBMISSION_ATTEMPTED',
  'BOOTSTRAP_SUBMITTED',
  'BOOTSTRAP_COMPLETED'
] as const;

export type FreshUserBootstrapStage = (typeof FRESH_USER_BOOTSTRAP_STAGES)[number];

export type FreshUserBootstrapState = {
  schemaVersion: 1;
  journeyId: string;
  userEmail: string;
  accountType: '香港账户';
  currency: 'USD';
  bootstrapAmount: string;
  stage: FreshUserBootstrapStage;
  depositTxn?: string;
  balanceBefore?: string;
  balanceAfter?: string;
  submissionClicks?: 0 | 1;
  submissionAttemptedAt?: string;
  finalConfirmationClicks?: 0 | 1;
  confirmationOpenClicks?: number;
  legacyConfirmationOnlyReconciledAt?: string;
  createdAt: string;
  updatedAt: string;
};

function assertState(state: FreshUserBootstrapState): void {
  if (state.schemaVersion !== 1 || !FRESH_USER_BOOTSTRAP_STAGES.includes(state.stage)) {
    throw new Error('Fresh User Bootstrap state has an unsupported schema or stage.');
  }
  if (!/^[A-Z0-9._-]+$/i.test(state.journeyId)) {
    throw new Error('Fresh User Bootstrap journeyId contains unsupported characters.');
  }
  if (!new Decimal(state.bootstrapAmount).isPositive()) {
    throw new Error('Fresh User Bootstrap amount must be positive.');
  }
  if ('password' in state || 'otp' in state || 'token' in state || 'cookie' in state) {
    throw new Error('Fresh User Bootstrap state contains forbidden authentication data.');
  }
}

export class FreshUserBalanceBootstrapStore {
  constructor(private readonly root = resolve('.journey-context/fresh-user/bootstrap')) {}

  pathFor(journeyId: string): string {
    if (!/^[A-Z0-9._-]+$/i.test(journeyId)) {
      throw new Error('Fresh User Bootstrap journeyId contains unsupported characters.');
    }
    return resolve(this.root, `${journeyId}.json`);
  }

  resultPathFor(journeyId: string): string {
    return resolve(this.root, `${journeyId}.flow-result.json`);
  }

  load(journeyId: string): FreshUserBootstrapState | undefined {
    const path = this.pathFor(journeyId);
    if (!existsSync(path)) return undefined;
    const state = JSON.parse(readFileSync(path, 'utf8')) as FreshUserBootstrapState;
    assertState(state);
    return state;
  }

  prepare(input: {
    journeyId: string;
    userEmail: string;
    bootstrapAmount: string;
  }, now = new Date()): FreshUserBootstrapState {
    const existing = this.load(input.journeyId);
    if (existing) {
      if (
        existing.userEmail !== input.userEmail ||
        !new Decimal(existing.bootstrapAmount).equals(input.bootstrapAmount)
      ) {
        throw new Error('Fresh User Bootstrap Resume state does not match this Journey.');
      }
      return existing;
    }
    const timestamp = now.toISOString();
    const state: FreshUserBootstrapState = {
      schemaVersion: 1,
      journeyId: input.journeyId,
      userEmail: input.userEmail,
      accountType: '香港账户',
      currency: 'USD',
      bootstrapAmount: new Decimal(input.bootstrapAmount).toString(),
      stage: 'PREPARED',
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.save(state);
    return state;
  }

  recordSubmitted(
    current: FreshUserBootstrapState,
    input: { depositTxn?: string; balanceBefore?: string },
    now = new Date()
  ): FreshUserBootstrapState {
    if (current.stage !== 'PREPARED' && current.stage !== 'BOOTSTRAP_SUBMISSION_ATTEMPTED') return current;
    const next = {
      ...current,
      ...input,
      stage: 'BOOTSTRAP_SUBMITTED' as const,
      updatedAt: now.toISOString()
    };
    this.save(next);
    return next;
  }

  recordSubmissionAttempt(current: FreshUserBootstrapState, balanceBefore: string): FreshUserBootstrapState {
    const persisted = this.load(current.journeyId);
    if (!persisted || !['PREPARED', 'BOOTSTRAP_CONFIRMATION_REQUIRED'].includes(persisted.stage) || persisted.submissionClicks || persisted.finalConfirmationClicks || persisted.stage !== current.stage) {
      throw new Error('Manual deposit was already attempted; only reconciliation of the same deposit is allowed.');
    }
    if (persisted.userEmail !== current.userEmail || persisted.bootstrapAmount !== current.bootstrapAmount) {
      throw new Error('Manual deposit attempt identity or amount mismatch.');
    }
    const now = new Date().toISOString();
    const next: FreshUserBootstrapState = { ...persisted, balanceBefore,
      stage: 'BOOTSTRAP_SUBMISSION_ATTEMPTED', submissionClicks: 1, finalConfirmationClicks: 1, submissionAttemptedAt: now, updatedAt: now };
    this.save(next);
    return next;
  }

  recordConfirmationOpened(current: FreshUserBootstrapState): FreshUserBootstrapState {
    const stored = this.load(current.journeyId);
    if (!stored || stored.submissionClicks || stored.finalConfirmationClicks || !['PREPARED', 'BOOTSTRAP_CONFIRMATION_REQUIRED'].includes(stored.stage)) {
      throw new Error('Cannot reopen a manual deposit after a final submission attempt.');
    }
    const next: FreshUserBootstrapState = { ...stored, stage: 'BOOTSTRAP_CONFIRMATION_REQUIRED',
      confirmationOpenClicks: (stored.confirmationOpenClicks ?? 0) + 1, updatedAt: new Date().toISOString() };
    this.save(next);
    return next;
  }

  reconcileLegacyConfirmationOnly(current: FreshUserBootstrapState, evidence: {
    observedBalance: string; originalConfirmationDialogObserved: true; existingLedgerCount: number;
  }): FreshUserBootstrapState {
    const stored = this.load(current.journeyId);
    if (!stored || stored.stage !== 'BOOTSTRAP_SUBMISSION_ATTEMPTED' || stored.submissionClicks !== 1 ||
        stored.finalConfirmationClicks !== undefined || stored.legacyConfirmationOnlyReconciledAt ||
        stored.depositTxn || !stored.balanceBefore || evidence.existingLedgerCount !== 0 ||
        !evidence.originalConfirmationDialogObserved || !new Decimal(evidence.observedBalance).equals(stored.balanceBefore)) {
      throw new Error('Only the legacy first-button misclassification may be reconciled; a real final attempt must never be reset.');
    }
    const now = new Date().toISOString();
    const next: FreshUserBootstrapState = { ...stored, stage: 'BOOTSTRAP_CONFIRMATION_REQUIRED',
      confirmationOpenClicks: 1, submissionClicks: 0, finalConfirmationClicks: 0,
      legacyConfirmationOnlyReconciledAt: now, updatedAt: now };
    this.save(next);
    return next;
  }

  recordCompleted(
    current: FreshUserBootstrapState,
    input: { depositTxn?: string; balanceBefore: string; balanceAfter: string },
    now = new Date()
  ): FreshUserBootstrapState {
    if (current.stage === 'BOOTSTRAP_COMPLETED') return current;
    const before = new Decimal(input.balanceBefore);
    const after = new Decimal(input.balanceAfter);
    if (!after.minus(before).equals(current.bootstrapAmount)) {
      throw new Error('Fresh User Bootstrap balance Oracle does not equal the configured amount.');
    }
    const next = {
      ...current,
      ...input,
      stage: 'BOOTSTRAP_COMPLETED' as const,
      updatedAt: now.toISOString()
    };
    this.save(next);
    return next;
  }

  private save(state: FreshUserBootstrapState): void {
    assertState(state);
    const path = this.pathFor(state.journeyId);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
    renameSync(temporary, path);
  }
}
