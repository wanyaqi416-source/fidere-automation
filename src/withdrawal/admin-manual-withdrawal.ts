import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Decimal } from '../utils/money';

export const MANUAL_WITHDRAWAL_FLOW_ID = 'admin-manual-fiat-withdrawal';
export const MANUAL_WITHDRAWAL_STAGES = ['PREPARED', 'CONFIRMATION_READY', 'SUBMISSION_ATTEMPTED', 'COMPLETED'] as const;
export type ManualWithdrawalState = {
  schemaVersion: 1; flowId: typeof MANUAL_WITHDRAWAL_FLOW_ID; runId: string; sourceRunId: string;
  accountType: string; currency: string; amount: string; stage: typeof MANUAL_WITHDRAWAL_STAGES[number];
  finalConfirmationClicks: 0 | 1; createdAt: string; updatedAt: string;
  fee?: string; balanceBefore?: string; balanceAfter?: string; adminReference?: string;
};

export function assertManualWithdrawalAmount(amount: string): void {
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount) || !new Decimal(amount).gt(0)) {
    throw new Error('Manual withdrawal requires a positive decimal amount with at most two fractional digits.');
  }
}

export function assertManualWithdrawalFunds(available: string, amount: string, fee: string): void {
  assertManualWithdrawalAmount(amount);
  const balance = new Decimal(available);
  const feeValue = new Decimal(fee);
  // Reserve room for the displayed fee; this is a safety ceiling, not a debit Oracle.
  if (!balance.isFinite() || !feeValue.isFinite() || feeValue.isNegative() || balance.lte(new Decimal(amount).plus(feeValue))) {
    throw new Error('BLOCKED_TEST_DATA: insufficient available balance or the operation would use all funds; no deposit/top-up is allowed.');
  }
}

export function decodeManualWithdrawalReceipt(value: unknown): { accepted: boolean; reference?: string } {
  if (!value || typeof value !== 'object') return { accepted: false };
  const envelope = value as Record<string, unknown>;
  if (envelope.code !== 0 && envelope.code !== 200) return { accepted: false };
  if (envelope.data === false || envelope.success === false) return { accepted: false };
  const data = envelope.data && typeof envelope.data === 'object' ? envelope.data as Record<string, unknown> : {};
  // Only explicit business-reference fields may leave the response parser. No raw body is retained.
  const reference = [data.transactionId, data.transactionNo, data.referenceNo].find(item =>
    typeof item === 'string' && /^(?:TXN|MW)-[A-Z0-9-]+$/i.test(item));
  return { accepted: true, reference: reference as string | undefined };
}

export class AdminManualWithdrawalStore {
  constructor(private readonly root = resolve('.journey-context/admin-manual-withdrawal')) {}

  private path(runId: string): string {
    if (!/^[A-Z0-9._-]+$/i.test(runId)) throw new Error('Invalid manual withdrawal runId.');
    return resolve(this.root, `${runId}.json`);
  }

  load(runId: string): ManualWithdrawalState | undefined {
    const path = this.path(runId);
    if (!existsSync(path)) return undefined;
    const value = JSON.parse(readFileSync(path, 'utf8')) as ManualWithdrawalState;
    if (value.schemaVersion !== 1 || value.flowId !== MANUAL_WITHDRAWAL_FLOW_ID || value.runId !== runId ||
        !MANUAL_WITHDRAWAL_STAGES.includes(value.stage) || ![0, 1].includes(value.finalConfirmationClicks)) {
      throw new Error('Unsupported manual withdrawal Resume state.');
    }
    assertManualWithdrawalAmount(value.amount);
    return value;
  }

  prepare(input: Pick<ManualWithdrawalState, 'runId' | 'sourceRunId' | 'accountType' | 'currency' | 'amount'>): ManualWithdrawalState {
    assertManualWithdrawalAmount(input.amount);
    const prior = this.load(input.runId);
    if (prior) {
      if (prior.sourceRunId !== input.sourceRunId || prior.accountType !== input.accountType || prior.currency !== input.currency ||
          !new Decimal(prior.amount).equals(input.amount)) throw new Error('Manual withdrawal Resume identity/amount mismatch.');
      this.assertUnsubmitted(prior);
      return prior;
    }
    const now = new Date().toISOString();
    const state: ManualWithdrawalState = { ...input, schemaVersion: 1, flowId: MANUAL_WITHDRAWAL_FLOW_ID,
      stage: 'PREPARED', finalConfirmationClicks: 0, createdAt: now, updatedAt: now };
    this.save(state);
    return state;
  }

  confirmationReady(runId: string, fee: string, balanceBefore: string): ManualWithdrawalState {
    const state = this.requireState(runId);
    this.assertUnsubmitted(state);
    assertManualWithdrawalFunds(balanceBefore, state.amount, fee);
    return this.save({ ...state, fee, balanceBefore, stage: 'CONFIRMATION_READY' });
  }

  recordAttempt(runId: string): ManualWithdrawalState {
    const state = this.requireState(runId);
    this.assertUnsubmitted(state);
    if (state.stage !== 'CONFIRMATION_READY') throw new Error('Validated confirmation required before a manual withdrawal attempt.');
    // Exclusive tombstone also prevents a second process or a stale object from submitting this Run.
    writeFileSync(`${this.path(runId)}.attempt`, JSON.stringify({ runId, attemptedAt: new Date().toISOString() }), { flag: 'wx' });
    return this.save({ ...state, stage: 'SUBMISSION_ATTEMPTED', finalConfirmationClicks: 1 });
  }

  completed(runId: string, input: { accepted: boolean; uiSuccess: boolean; reference?: string }): ManualWithdrawalState {
    const state = this.requireState(runId);
    if (state.stage !== 'SUBMISSION_ATTEMPTED' || state.finalConfirmationClicks !== 1 || !input.accepted || !input.uiSuccess) {
      throw new Error('Confirmed server and Admin UI success are required; HTTP 200 alone is insufficient.');
    }
    return this.save({ ...state, adminReference: input.reference, stage: 'COMPLETED' });
  }

  recordBalanceObservation(runId: string, balanceAfter: string): ManualWithdrawalState {
    const state = this.requireState(runId);
    if (state.stage !== 'COMPLETED' || !new Decimal(balanceAfter).isFinite()) throw new Error('Completed manual withdrawal required.');
    return this.save({ ...state, balanceAfter });
  }

  private assertUnsubmitted(state: ManualWithdrawalState): void {
    if (state.finalConfirmationClicks || !['PREPARED', 'CONFIRMATION_READY'].includes(state.stage) || existsSync(`${this.path(state.runId)}.attempt`)) {
      throw new Error('Manual withdrawal already attempted: read-only reconciliation only, never create a replacement.');
    }
  }

  private requireState(runId: string): ManualWithdrawalState {
    const state = this.load(runId);
    if (!state) throw new Error('No existing manual withdrawal context.');
    return state;
  }

  private save(input: ManualWithdrawalState): ManualWithdrawalState {
    const state: ManualWithdrawalState = {
      schemaVersion: 1, flowId: MANUAL_WITHDRAWAL_FLOW_ID, runId: input.runId, sourceRunId: input.sourceRunId,
      accountType: input.accountType, currency: input.currency, amount: input.amount, stage: input.stage,
      finalConfirmationClicks: input.finalConfirmationClicks, createdAt: input.createdAt, updatedAt: new Date().toISOString(),
      fee: input.fee, balanceBefore: input.balanceBefore, balanceAfter: input.balanceAfter, adminReference: input.adminReference
    };
    const path = this.path(state.runId);
    mkdirSync(this.root, { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
    renameSync(temporary, path);
    return state;
  }
}
