import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { FlowStateStore, advanceFlowState, createPreparedFlowState, matchCandidatesByStages } from '../flow-engine';
import { Decimal } from '../utils/money';

export const COUNTRY_LABELS = { BH: '巴林账户', SG: '新加坡账户' } as const;
export type OpeningCountry = keyof typeof COUNTRY_LABELS;
export type OperationsOpeningIdentity = { userId: string; email: string; displayName: string; accountType: 'PERSONAL' | 'BUSINESS' };
export type OperationsAccount = { status: string; accountNumber?: string; holder?: string };
export type OperationsCustomer = OperationsOpeningIdentity & { status: string; countries: Record<OpeningCountry, OperationsAccount> };
export type OperationsOpeningForm = { holder: string; accountNumber: string; iban: string; fee: string; note: string };
export const operationsOpeningFlowId = (country: OpeningCountry) => `admin-operations-opening-${country.toLowerCase()}`;

export function operationsOpeningFeeInput(authorizedFee: string | undefined, mode = 'zero'): string {
  if (authorizedFee === undefined || !/^0(?:\.0{1,2})?$/.test(authorizedFee)) {
    throw new Error('An explicit zero-fee authorization is required, including when leaving the fee input blank.');
  }
  if (!['blank', 'zero'].includes(mode)) throw new Error('Opening fee input mode must be blank or zero.');
  return mode === 'blank' ? '' : authorizedFee;
}

export function parseOperationsCustomer(headers: string[], cells: string[]): OperationsCustomer {
  const field = (label: string) => {
    const index = headers.findIndex(header => header.trim() === label);
    if (index < 0 || cells[index] === undefined) throw new Error(`Operations customer column unavailable: ${label}`);
    return cells[index].trim();
  };
  const identity = field('客户信息');
  const lines = identity.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const idIndex = lines.findIndex(line => /^ID:\s*\d+$/.test(line));
  const userId = lines[idIndex]?.match(/\d+$/)?.[0];
  const email = identity.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const type = field('申请类型');
  if (!userId || !email || idIndex < 1 || !['个人', '企业'].includes(type)) throw new Error('Incomplete operations customer identity.');
  const accounts = field('账户信息');
  const country = (key: OpeningCountry): OperationsAccount => {
    const label = COUNTRY_LABELS[key];
    if (!accounts.includes(label)) throw new Error(`Missing ${label} card.`);
    const section = accounts.split(label)[1].split(/新加坡账户|巴林账户/)[0];
    const status = section.match(/未开通|已开户/)?.[0];
    if (!status) throw new Error(`Unknown ${label} state; do not assume unopened.`);
    return { status, accountNumber: section.match(/账号[:：]\s*([^|\n]+)/)?.[1].trim(),
      holder: section.match(/收款人[:：]\s*([^|\n]+)/)?.[1].trim() };
  };
  return { userId, email, displayName: lines[idIndex - 1], accountType: type === '个人' ? 'PERSONAL' : 'BUSINESS',
    status: field('账户状态'), countries: { BH: country('BH'), SG: country('SG') } };
}

export function matchOperationsCustomers(rows: OperationsCustomer[], identity: OperationsOpeningIdentity, country: OpeningCountry, status: string) {
  return matchCandidatesByStages(rows, [
    { id: 'email', label: '邮箱精确匹配', matches: row => row.email.toLowerCase() === identity.email.toLowerCase() },
    { id: 'user-id', label: '原用户ID', matches: row => row.userId === identity.userId },
    { id: 'type', label: '个人或企业类型', matches: row => row.accountType === identity.accountType },
    { id: 'active', label: '账户启用', matches: row => row.status === '启用' },
    { id: 'country-state', label: `${COUNTRY_LABELS[country]}${status}`, matches: row => row.countries[country].status === status }
  ]);
}

export function validateOperationsOpeningForm(form: OperationsOpeningForm): void {
  if (!form.holder.trim() || !form.accountNumber.trim() || !form.note.startsWith('AUTO_SANDBOX_')) {
    throw new Error('Configured Sandbox holder, account number and automation note are required.');
  }
  if (form.fee !== '' && (!/^0(?:\.0{1,2})?$/.test(form.fee) || !new Decimal(form.fee).isZero())) {
    throw new Error('BLOCKED: fee-bearing Admin opening needs verified payment-account/debit rules. Only explicitly authorized zero-fee opening is supported.');
  }
}

export class OperationsOpeningRun {
  private readonly store: FlowStateStore;
  private readonly path: string;
  private readonly customerAttemptPath: string;
  readonly flowId: string;
  constructor(readonly runId: string, readonly country: OpeningCountry, identity: OperationsOpeningIdentity, form: OperationsOpeningForm, root?: string) {
    validateOperationsOpeningForm(form);
    this.flowId = operationsOpeningFlowId(country);
    this.store = new FlowStateStore(root);
    this.path = this.store.pathFor(this.flowId, runId);
    mkdirSync(dirname(this.path), { recursive: true });
    const customerKey = createHash('sha256').update(identity.userId).digest('hex');
    this.customerAttemptPath = `${dirname(this.path)}/${customerKey}.customer-attempt`;
    if (existsSync(this.customerAttemptPath) && readFileSync(this.customerAttemptPath, 'utf8') !== runId) {
      throw new Error('This customer/country already has an opening attempt; resume its original Run.');
    }
    const binding = createHash('sha256').update(JSON.stringify([country, identity.userId, identity.email.toLowerCase(), identity.accountType, form])).digest('hex');
    if (existsSync(`${this.path}.binding`)) {
      if (readFileSync(`${this.path}.binding`, 'utf8') !== binding) throw new Error('Opening Resume customer/country/form mismatch.');
    } else writeFileSync(`${this.path}.binding`, binding, { flag: 'wx' });
    if (!this.store.load(this.flowId, runId)) this.store.save(createPreparedFlowState({ flowId: this.flowId, runId, amount: form.fee || '0' }));
  }
  state() { return this.store.load(this.flowId, this.runId)!; }
  attempted() { return existsSync(`${this.path}.attempt`) || existsSync(this.customerAttemptPath); }
  located(userId: string): void {
    if (this.state().stage === 'PREPARED') this.store.save(advanceFlowState(this.state(), 'ADMIN_LOCATED', { clientReference: userId }));
  }
  attempt(): void {
    if (this.state().stage !== 'ADMIN_LOCATED' || this.attempted()) throw new Error('Opening already attempted or not uniquely located; read-only Resume only.');
    // Exclusive country/customer tombstone also blocks a replacement Run after an uncertain write.
    writeFileSync(this.customerAttemptPath, this.runId, { flag: 'wx' });
    writeFileSync(`${this.path}.attempt`, JSON.stringify({ runId: this.runId, attemptedAt: new Date().toISOString() }), { flag: 'wx' });
    this.store.save(advanceFlowState(this.state(), 'ADMIN_APPROVAL_SUBMISSION_ATTEMPTED'));
  }
  complete(): void {
    if (!this.attempted()) throw new Error('Opening completion requires an original submission attempt.');
    if (this.state().stage !== 'COMPLETED') this.store.save(advanceFlowState(this.state(), 'COMPLETED'));
  }
}
