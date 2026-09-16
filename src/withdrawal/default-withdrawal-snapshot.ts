import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PersonalPostRegistrationJourney } from '../journey/personal-post-registration-journey';
import { FlowStateStore } from '../flow-engine/resume-state';
import { defaultFiatUserKey } from '../utils/default-fiat-user';

export type WithdrawalJourneySnapshot = Pick<PersonalPostRegistrationJourney,
  'withdrawal' | 'fiatAddressReference' | 'fiatAddressAccountSuffix' | 'updatedAt'>;
const fields = ['runId', 'accountType', 'currency', 'requestedAmount', 'balanceBefore', 'previousTransactionIds',
  'submittedBalance', 'feeAmount', 'netAmount', 'expectedDebit', 'balanceAfter', 'confirmationClicks',
  'securityVerificationClicks', 'approvalClicks', 'paymentChannel', 'paymentBank', 'clientStatus', 'adminStatus'] as const;

export class DefaultWithdrawalSnapshot {
  private readonly path: string;
  private readonly owner: string;
  constructor(readonly runId: string, email: string, private readonly dryRun = false, root?: string) {
    this.owner = defaultFiatUserKey(email);
    if (!runId.startsWith(`WD-${this.owner}-`)) throw new Error('Standalone Withdrawal Run must remain bound to the default Client.');
    const store = new FlowStateStore(root);
    this.path = `${store.pathFor('personal-golden-journey-withdrawal', runId)}.snapshot`;
    if (store.list('personal-golden-journey-withdrawal').some(state => state.runId !== runId &&
      state.runId.startsWith(`WD-${this.owner}-`) && state.stage !== 'COMPLETED')) {
      throw new Error('Existing default Client withdrawal must Resume; a replacement is forbidden.');
    }
  }
  load(): WithdrawalJourneySnapshot {
    if (!existsSync(this.path)) return { updatedAt: new Date().toISOString() };
    const data = JSON.parse(readFileSync(this.path, 'utf8'));
    if (data.owner !== this.owner || (data.withdrawal && data.withdrawal.runId !== this.runId)) throw new Error('Withdrawal snapshot identity changed.');
    return data;
  }
  save(value: WithdrawalJourneySnapshot) {
    if (this.dryRun) return;
    if (value.withdrawal?.runId !== this.runId) throw new Error('Withdrawal snapshot Run changed.');
    const withdrawal = Object.fromEntries(fields.map(key => [key, value.withdrawal![key]]));
    const safe = { owner: this.owner, withdrawal, updatedAt: value.updatedAt,
      fiatAddressReference: value.fiatAddressReference, fiatAddressAccountSuffix: value.fiatAddressAccountSuffix };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(safe), 'utf8');
    renameSync(`${this.path}.tmp`, this.path);
  }
}
