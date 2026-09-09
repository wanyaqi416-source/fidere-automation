import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { advanceFlowState, createPreparedFlowState, FlowStateStore, stageIndex, type FlowStage } from '../flow-engine';
import { Decimal } from '../utils/money';
import { clientDepositIdPattern, matchAdminDepositRecordsIgnoringStatus, type AdminDepositCandidate, type DepositFingerprint } from './deposit-e2e';

export const DEPOSIT_REJECTION_FLOW = 'deposit-rejection-journey';
export type DepositRejectionBaseline = {
  balanceBefore: string;
  previousTransactionIds: string[];
  submittedAt: string;
  channel: string;
};

export function assertDepositRejectionBalance(before: string, after: string): void {
  if (!new Decimal(before).isFinite() || !new Decimal(after).isFinite() ||
      !new Decimal(before).equals(after)) {
    throw new Error('DEPOSIT_REJECTION_BALANCE_MISMATCH: final balance must equal the original baseline.');
  }
}

export function assertDepositRejectionAuthorization(runId: string, authorizedRunId: string | undefined): void {
  if (!/^[A-Z0-9._-]+$/i.test(runId) || runId !== authorizedRunId) {
    throw new Error('Explicit authorization for this named Deposit rejection Run is required.');
  }
}

export class DepositRejectionRun {
  private readonly store: FlowStateStore;
  private readonly path: string;
  private readonly activePath: string;
  constructor(readonly runId: string, sourceRunId: string, private readonly account: string, currency: string, amount: string, root?: string) {
    const value = new Decimal(amount);
    if (!value.isFinite() || !value.isPositive() || value.decimalPlaces() > 2) throw new Error('Invalid Deposit amount.');
    this.store = new FlowStateStore(root);
    this.path = this.store.pathFor(DEPOSIT_REJECTION_FLOW, runId);
    mkdirSync(dirname(this.path), { recursive: true });
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    this.activePath = `${dirname(this.path)}/${hash(sourceRunId)}.active`;
    if (existsSync(this.activePath)) {
      const previousRun = readFileSync(this.activePath, 'utf8');
      if (previousRun !== runId && this.store.load(DEPOSIT_REJECTION_FLOW, previousRun)?.stage !== 'COMPLETED') {
        throw new Error('An unfinished Deposit rejection exists for this user; resume its original Run.');
      }
    }
    const binding = hash(JSON.stringify([sourceRunId, account, currency, value.toString()]));
    if (existsSync(`${this.path}.binding`)) {
      if (readFileSync(`${this.path}.binding`, 'utf8') !== binding) throw new Error('Deposit Resume identity/amount mismatch.');
    } else writeFileSync(`${this.path}.binding`, binding, { flag: 'wx' });
    if (!this.store.load(DEPOSIT_REJECTION_FLOW, runId)) {
      this.store.save(createPreparedFlowState({ flowId: DEPOSIT_REJECTION_FLOW, runId, currency, amount: value.toString() }));
    }
  }
  state() { return this.store.load(DEPOSIT_REJECTION_FLOW, this.runId)!; }
  submitted() { return existsSync(`${this.path}.submit`); }
  rejected() { return existsSync(`${this.path}.reject`); }
  hasAdminCreationEvidence() { return existsSync(`${this.path}.admin-binding`); }
  baseline(): DepositRejectionBaseline {
    if (!this.submitted()) throw new Error('No original Deposit submission baseline exists.');
    return JSON.parse(readFileSync(`${this.path}.submit`, 'utf8')) as DepositRejectionBaseline;
  }
  attemptSubmit(input: DepositRejectionBaseline): void {
    if (this.state().stage !== 'PREPARED' || this.submitted()) throw new Error('Deposit must not be submitted twice.');
    if (!new Decimal(input.balanceBefore).isFinite() || !Number.isFinite(Date.parse(input.submittedAt))) throw new Error('Invalid baseline.');
    if (existsSync(this.activePath)) {
      const active = readFileSync(this.activePath, 'utf8');
      if (active !== this.runId && this.store.load(DEPOSIT_REJECTION_FLOW, active)?.stage !== 'COMPLETED') {
        throw new Error('An unfinished Deposit rejection became active; do not create a replacement order.');
      }
    }
    const baseline: DepositRejectionBaseline = {
      balanceBefore: new Decimal(input.balanceBefore).toString(),
      previousTransactionIds: input.previousTransactionIds.filter(id => clientDepositIdPattern.test(id)),
      submittedAt: input.submittedAt, channel: input.channel
    };
    // Persist the tombstone before the click, including the original balance for all future Resume runs.
    writeFileSync(this.activePath, this.runId);
    writeFileSync(`${this.path}.submit`, JSON.stringify(baseline), { flag: 'wx' });
    this.advance('CLIENT_SUBMIT_ATTEMPTED', { clientSubmittedAt: input.submittedAt });
  }
  created(id: string): void {
    if (!this.submitted() || !clientDepositIdPattern.test(id)) throw new Error('A real original Client TXN is required.');
    if (this.state().clientReference && this.state().clientReference !== id) throw new Error('Deposit original TXN changed.');
    if (this.state().stage === 'CLIENT_SUBMIT_ATTEMPTED') this.advance('CLIENT_CREATED', { clientReference: id });
  }
  createdFromVerifiedAdmin(candidate: AdminDepositCandidate, count: number, fingerprint: DepositFingerprint, windowMs: number): void {
    const baseline = this.baseline();
    if (count !== 1 || fingerprint.runId !== this.runId || !fingerprint.userIdentity.trim() ||
        fingerprint.accountType !== this.account || fingerprint.currency !== this.state().currency ||
        !new Decimal(fingerprint.requestedAmount).equals(this.state().amount!) ||
        fingerprint.clientSubmittedAtMs !== Date.parse(baseline.submittedAt) || fingerprint.channel !== baseline.channel ||
        matchAdminDepositRecordsIgnoringStatus([candidate], fingerprint, windowMs).length !== 1) {
      throw new Error('Original Admin creation evidence must match the persisted submission and unique fingerprint.');
    }
    // Bind immutable business fields, not an absent TXN or a status-dependent row key.
    const binding = createHash('sha256').update(JSON.stringify([candidate.submittedAtMs,
      candidate.accountType, candidate.currency, new Decimal(candidate.requestedAmount).toString(),
      candidate.channel, candidate.reference, candidate.matchedCustomerText, candidate.payerText])).digest('hex');
    if (this.hasAdminCreationEvidence()) {
      if (readFileSync(`${this.path}.admin-binding`, 'utf8') !== binding) throw new Error('Original Admin Deposit fingerprint changed.');
    } else writeFileSync(`${this.path}.admin-binding`, binding, { flag: 'wx' });
    if (this.state().stage === 'CLIENT_SUBMIT_ATTEMPTED') this.advance('CLIENT_CREATED');
  }
  located(reference: string, count: number): void {
    if (count !== 1 || (!this.state().clientReference && !this.hasAdminCreationEvidence())) throw new Error('Admin candidate must be exactly one after business creation evidence.');
    if (this.state().adminReference && this.state().adminReference !== reference) throw new Error('Original Admin reference changed.');
    if (this.state().stage === 'CLIENT_CREATED') this.advance('ADMIN_LOCATED', { adminReference: reference });
  }
  attemptReject(): void {
    if (this.state().stage !== 'ADMIN_LOCATED' || this.rejected()) throw new Error('Reject is forbidden without a unique candidate or after an attempt.');
    writeFileSync(`${this.path}.reject`, new Date().toISOString(), { flag: 'wx' });
  }
  adminRejected(): void {
    if (!this.rejected()) throw new Error('Original rejection attempt is missing.');
    if (this.state().stage === 'ADMIN_LOCATED') this.advance('ADMIN_ACTION_DONE');
  }
  clientRejected(): void {
    if (this.state().stage === 'ADMIN_ACTION_DONE') this.advance('CLIENT_FINALIZED');
    else if (!['CLIENT_FINALIZED', 'COMPLETED'].includes(this.state().stage)) throw new Error('Admin rejected state must be verified first.');
  }
  complete(balanceAfter: string): void {
    assertDepositRejectionBalance(this.baseline().balanceBefore, balanceAfter);
    if (this.state().stage === 'CLIENT_FINALIZED') this.advance('COMPLETED');
    else if (this.state().stage !== 'COMPLETED') throw new Error('Client rejection must be verified before completion.');
  }
  private advance(stage: FlowStage, updates: Parameters<typeof advanceFlowState>[2] = {}) {
    const current = this.state();
    if (!current.clientReference && this.hasAdminCreationEvidence() && stageIndex(stage) >= stageIndex('ADMIN_LOCATED')) {
      // This domain can prove the original order by a pinned Admin fingerprint without fabricating a Client TXN.
      if (stageIndex(stage) <= stageIndex(current.stage)) throw new Error('Deposit state must advance monotonically.');
      this.store.save({ ...current, ...updates, stage, updatedAt: new Date().toISOString() });
    } else this.store.save(advanceFlowState(current, stage, updates));
  }
}
