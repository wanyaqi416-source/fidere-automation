import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { FlowStateStore, createPreparedFlowState, advanceFlowState, type FlowStage, type FlowResumeState } from '../flow-engine';
import { Decimal } from '../utils/money';
import type { AccountTypeFeeSnapshot, AccountTransferQuote } from './account-transfer-fee';
import type { InternalTransferRecord } from './account-transfer-fee-run';
import type { FeeMatrixPlan } from './transfer-fee-matrix';

export const FEE_MATRIX_FLOW = 'transfer-fee-matrix';
type Attempt = 'apply' | 'confirm' | 'security' | 'approve' | 'restore';
export type FeeMatrixEvidence = {
  plan: FeeMatrixPlan; senderHash: string; recipientHash: string; original?: AccountTypeFeeSnapshot;
  baselineIds?: string[]; submittedAt?: string; quote?: AccountTransferQuote; order?: InternalTransferRecord;
  applied: boolean; restored: boolean; beforeAvailable?: string; adminStatus?: string; adminNet?: string;
  approvalClicks?: number; approvalConfirmations?: number; verified: boolean;
};

export function matchMatrixOrders(records: readonly InternalTransferRecord[], e: FeeMatrixEvidence, runId: string) {
  if (!e.baselineIds || !e.submittedAt) throw new Error('Original submission window and baseline are required.');
  return records.filter(row => !e.baselineIds!.includes(row.orderNo) && row.transferType === e.plan.kind &&
    row.fromRegion === 'BH' && (e.plan.kind !== 'internal' || row.toRegion === 'HK') &&
    row.currency === e.plan.currency && new Decimal(row.amount).eq(e.plan.amount) &&
    row.remark === `AUTO_TRANSFER_FEE_${runId}` && Math.abs(row.appliedAt - Date.parse(e.submittedAt!)) <= 300_000);
}

export class TransferFeeMatrixRun {
  readonly store: FlowStateStore;
  state: FlowResumeState;
  evidence: FeeMatrixEvidence;
  private readonly path: string;
  constructor(readonly runId: string, plan: FeeMatrixPlan, sender: string, recipient: string, root = resolve('.flow-state'), resume = false) {
    this.store = new FlowStateStore(root);
    this.path = this.store.pathFor(FEE_MATRIX_FLOW, runId).replace(/\.json$/, '.evidence');
    const hash = (value: string) => createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
    const previousState = this.store.load(FEE_MATRIX_FLOW, runId);
    if (previousState) {
      if (!resume || previousState.stage === 'COMPLETED') throw new Error('Existing matrix Run: query/Resume its original business; never automatically rerun.');
      this.evidence = TransferFeeMatrixRun.readEvidence(runId, root); this.state = previousState;
      if (this.evidence.senderHash !== hash(sender) || this.evidence.recipientHash !== hash(recipient) ||
        JSON.stringify(this.evidence.plan) !== JSON.stringify(plan)) throw new Error('Resume must preserve the original plan and participants.');
      return;
    }
    if (resume) throw new Error('Resume requires an existing original matrix Run.');
    for (const previous of this.store.list(FEE_MATRIX_FLOW)) {
      if (previous.stage !== 'COMPLETED') throw new Error('Incomplete matrix Run requires original-order reconciliation before another transfer.');
    }
    this.state = createPreparedFlowState({ flowId: FEE_MATRIX_FLOW, runId, amount: plan.amount, currency: plan.currency });
    if (!sender || !recipient || hash(sender) === hash(recipient)) throw new Error('Distinct configured Sender and Recipient are required.');
    this.evidence = { plan, senderHash: hash(sender), recipientHash: hash(recipient), applied: false, restored: false, verified: false };
    this.save();
  }
  attempted(phase: Attempt) { return existsSync(`${this.path}.${phase}-attempt`); }
  attempt(phase: Attempt) {
    const e = this.evidence;
    if (!e.original || (phase === 'apply' && (e.applied || e.restored)) ||
      (phase === 'confirm' && (!e.applied || e.restored || !e.baselineIds || !e.quote || e.order)) ||
      (phase === 'security' && (!this.attempted('confirm') || e.restored || e.order)) ||
      (phase === 'approve' && (e.plan.kind !== 'p2p' || this.state.stage !== 'ADMIN_LOCATED' || !e.order)) ||
      (phase === 'restore' && (!e.applied || e.restored || (this.attempted('security') && !e.order)))) {
      throw new Error('Invalid matrix mutation phase.');
    }
    writeFileSync(`${this.path}.${phase}-attempt`, new Date().toISOString(), { flag: 'wx' });
    if (phase === 'confirm') this.advance('CLIENT_SUBMIT_ATTEMPTED');
    if (phase === 'security') { e.submittedAt = new Date().toISOString(); this.advance('SECURITY_KEY_VERIFICATION_ATTEMPTED'); }
    if (phase === 'approve') this.advance('FIDERE_APPROVAL_ATTEMPTED');
    this.save();
  }
  created(record: InternalTransferRecord) {
    if (!this.attempted('security') || matchMatrixOrders([record], this.evidence, this.runId).length !== 1 ||
      !/^TXN-[A-Z0-9-]+$/i.test(record.txNo)) throw new Error('Original unique Client TRF/TXN is required.');
    if (this.evidence.order && this.evidence.order.orderNo !== record.orderNo) throw new Error('Cannot replace the original order.');
    this.evidence.order = record;
    if (!this.state.clientReference) this.state = advanceFlowState(this.state, 'CLIENT_CREATED', {
      clientReference: record.orderNo, adminReference: record.txNo, clientSubmittedAt: this.evidence.submittedAt });
    this.save();
  }
  advance(stage: FlowStage) { this.state = advanceFlowState(this.state, stage); this.save(); }
  complete() {
    if (!this.evidence.verified || !this.evidence.restored || this.evidence.adminStatus !== '已批准' ||
      (this.evidence.plan.kind === 'p2p' && !this.attempted('approve'))) throw new Error('Completion requires the original verified business and restored configuration.');
    this.advance('COMPLETED');
  }
  save() {
    this.store.save(this.state);
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.evidence, null, 2), 'utf8');
    renameSync(`${this.path}.tmp`, this.path);
  }
  static readEvidence(runId: string, root = resolve('.flow-state')): FeeMatrixEvidence {
    const path = new FlowStateStore(root).pathFor(FEE_MATRIX_FLOW, runId).replace(/\.json$/, '.evidence');
    return JSON.parse(readFileSync(path, 'utf8')) as FeeMatrixEvidence;
  }
}
