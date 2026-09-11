import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  FlowStateStore,
  advanceFlowState,
  createPreparedFlowState,
  type FlowResumeState,
  type FlowStage
} from '../flow-engine';

export const BAHRAIN_ACCOUNT_OPENING_FLOW_ID = 'account-opening-bahrain-approve';

export class BahrainAccountOpeningRun {
  private readonly store = new FlowStateStore();
  private readonly statePath: string;
  private readonly customerAttemptPath: string;

  constructor(readonly runId: string, readonly email: string) {
    if (!/^[A-Z0-9._-]+$/i.test(runId)) {
      throw new Error('OPEN-BH-003 requires a named Sandbox Run ID.');
    }
    this.statePath = this.store.pathFor(BAHRAIN_ACCOUNT_OPENING_FLOW_ID, runId);
    mkdirSync(dirname(this.statePath), { recursive: true });
    const identityHash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
    this.customerAttemptPath = `${dirname(this.statePath)}/${identityHash}.customer-attempt`;
    const bindingPath = `${this.statePath}.binding`;
    const binding = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
    if (existsSync(bindingPath)) {
      if (readFileSync(bindingPath, 'utf8') !== binding) {
        throw new Error('OPEN-BH-003 Resume identity differs from its original Client user.');
      }
    } else {
      writeFileSync(bindingPath, binding, { flag: 'wx' });
    }
    if (existsSync(this.customerAttemptPath) && readFileSync(this.customerAttemptPath, 'utf8') !== runId) {
      throw new Error('This Client user already has a Bahrain opening attempt; resume its original Run.');
    }
    if (!this.store.load(BAHRAIN_ACCOUNT_OPENING_FLOW_ID, runId)) {
      this.store.save(createPreparedFlowState({ runId, flowId: BAHRAIN_ACCOUNT_OPENING_FLOW_ID }));
    }
  }

  state(): FlowResumeState {
    return this.store.load(BAHRAIN_ACCOUNT_OPENING_FLOW_ID, this.runId)!;
  }

  setMoney(amount: string, currency: string): void {
    this.store.save({ ...this.state(), amount, currency, updatedAt: new Date().toISOString() });
  }

  advance(stage: FlowStage, updates: Parameters<typeof advanceFlowState>[2] = {}): void {
    this.store.save(advanceFlowState(this.state(), stage, updates));
  }

  attempt(kind: 'client-confirmation' | 'security-key' | 'security-key-recovery' | 'admin-approval'): void {
    const attemptPath = `${this.statePath}.${kind}.attempt`;
    if (existsSync(attemptPath)) {
      throw new Error(`OPEN-BH-003 ${kind} was already attempted; only read-only reconciliation is allowed.`);
    }
    if (kind === 'client-confirmation' && !existsSync(this.customerAttemptPath)) {
      writeFileSync(this.customerAttemptPath, this.runId, { flag: 'wx' });
    }
    writeFileSync(attemptPath, JSON.stringify({ runId: this.runId, attemptedAt: new Date().toISOString() }), { flag: 'wx' });
  }

  attempted(kind: 'client-confirmation' | 'security-key' | 'security-key-recovery' | 'admin-approval'): boolean {
    return existsSync(`${this.statePath}.${kind}.attempt`);
  }
}
