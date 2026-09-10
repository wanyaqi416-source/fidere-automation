import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FlowStateStore, createPreparedFlowState, advanceFlowState, type FlowResumeState } from '../flow-engine';
import { fixedUsdFee, verifyFixedTransferQuote, type AccountTypeFeeSnapshot, type AccountTransferQuote, type AccountTransferSettlement } from './account-transfer-fee';

export type FeeRunOptions = { runId: string; email: string; fixedFee: string; amount: string; targetAccount: string };
export type FeeAttempt = 'apply' | 'confirm' | 'security' | 'restore';
export type FeeRunEvidence = {
  identityHash: string; fixedFee: string; amount: string; targetAccount: string;
  original?: AccountTypeFeeSnapshot; originalOrderIds?: string[];
  stage: string; applied: boolean; restored: boolean; submittedAt?: string;
  quotes?: AccountTransferQuote[]; order?: InternalTransferRecord;
  settlement?: AccountTransferSettlement;
};
export type InternalTransferRecord = {
  orderNo: string; txNo: string; transferType: string; fromRegion: string; toRegion: string;
  currency: string; amount: string; fee: string; actualAmount: string; status: string;
  remark: string; appliedAt: number;
};

export class AccountTransferFeeRun {
  readonly states: FlowStateStore;
  state: FlowResumeState;
  evidence: FeeRunEvidence;
  private readonly path: string;

  constructor(options: FeeRunOptions, resume = false, rootDirectory = resolve('.flow-state')) {
    const flowId = 'account-transfer-fee';
    this.states = new FlowStateStore(rootDirectory);
    this.path = this.states.pathFor(flowId, options.runId).replace(/\.json$/, '.evidence');
    const identityHash = createHash('sha256').update(options.email.trim().toLowerCase()).digest('hex');
    const fixedFee = fixedUsdFee(options.fixedFee).amount, amount = fixedUsdFee(options.amount).amount;
    const existing = this.states.load(flowId, options.runId);
    if (existing) {
      if (!resume || existing.stage === 'COMPLETED') throw new Error('Use original incomplete Fee Run Resume; completed Runs cannot repeat.');
      this.state = existing; this.evidence = JSON.parse(readFileSync(this.path, 'utf8')) as FeeRunEvidence;
      if (this.evidence.identityHash !== identityHash || this.evidence.fixedFee !== fixedFee ||
        this.evidence.amount !== amount || this.evidence.targetAccount !== options.targetAccount) {
        throw new Error('Fee Run Resume must preserve identity, amount, fee and account direction.');
      }
    } else {
      if (resume) throw new Error('Requested original Fee Run does not exist.');
      for (const previous of this.states.list(flowId)) {
        const path = this.states.pathFor(flowId, previous.runId).replace(/\.json$/, '.evidence');
        if (previous.stage !== 'COMPLETED' && existsSync(`${path}.apply-attempt`)) {
          throw new Error('An earlier shared fee change requires reconciliation/restore; do not start another Run.');
        }
      }
      this.state = createPreparedFlowState({ flowId, runId: options.runId, amount, currency: 'USD' });
      this.evidence = { identityHash, fixedFee, amount, targetAccount: options.targetAccount, stage: 'PREPARED', applied: false, restored: false };
      this.save();
    }
  }

  attempted(phase: FeeAttempt): boolean { return existsSync(`${this.path}.${phase}-attempt`); }

  attempt(phase: FeeAttempt): void {
    const e = this.evidence;
    if (!e.original || (phase === 'apply' && (e.applied || e.restored)) ||
      (phase === 'confirm' && (!e.applied || e.restored || !e.originalOrderIds || e.order)) ||
      (phase === 'security' && (!this.attempted('confirm') || e.restored || e.order)) ||
      (phase === 'restore' && (!e.applied || e.restored || !this.attempted('apply')))) {
      throw new Error('Invalid fee-test mutation phase; retain the original configuration and business.');
    }
    writeFileSync(`${this.path}.${phase}-attempt`, new Date().toISOString(), { flag: 'wx' });
    e.stage = `${phase.toUpperCase()}_ATTEMPTED`;
    if (phase === 'confirm') this.state = advanceFlowState(this.state, 'CLIENT_SUBMIT_ATTEMPTED');
    if (phase === 'security') {
      e.submittedAt = new Date().toISOString();
      this.state = advanceFlowState(this.state, 'SECURITY_KEY_VERIFICATION_ATTEMPTED');
    }
    this.save();
  }

  created(record: InternalTransferRecord): void {
    if (!this.attempted('security')) throw new Error('Original order evidence requires a security verification attempt.');
    if (this.evidence.order && this.evidence.order.orderNo !== record.orderNo) throw new Error('Cannot replace the original internal transfer.');
    this.evidence.order = record;
    if (!this.state.clientReference) this.state = advanceFlowState(this.state, 'CLIENT_CREATED', {
      clientReference: record.orderNo, clientSubmittedAt: this.evidence.submittedAt
    });
    this.evidence.stage = 'CLIENT_CREATED'; this.save();
  }

  complete(): void {
    const e = this.evidence;
    if (!e.restored || e.order?.status !== 'approved' || !e.settlement ||
      e.settlement.orderNo !== e.order.orderNo || e.settlement.txNo !== e.order.txNo || e.settlement.adminStatus !== '已批准') {
      throw new Error('Completion requires the original completed transfer, verified labelled net amount and restored fee.');
    }
    verifyFixedTransferQuote(e.settlement, fixedUsdFee(e.fixedFee), { sourceAccount: '巴林账户', targetAccount: e.targetAccount, amount: e.amount });
    this.state = advanceFlowState(this.state, 'COMPLETED'); this.evidence.stage = 'COMPLETED'; this.save();
  }

  save(): void {
    this.states.save(this.state);
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.evidence, null, 2), 'utf8');
    renameSync(`${this.path}.tmp`, this.path);
  }
}
