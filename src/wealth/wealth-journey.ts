import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { FlowStateStore, advanceFlowState, createPreparedFlowState, stageIndex, type FlowStage, type FlowResumeState } from '../flow-engine';
import { decodeClientKycStatus } from '../registration/registration-kyc-contract';
import { maskSensitiveText } from '../reporting/sensitive-data-mask';
import type { AccountBalanceSnapshot } from '../../pages/client/AccountBalanceReader';
import type { WealthHistoryRecord } from '../../pages/client/FundTradingPage';
import { Decimal } from '../utils/money';

export type WealthJourneyEvidence = {
  runId: string; kind: 'subscription' | 'redemption'; identityHash: string; userId?: string;
  decision?: 'approve' | 'reject'; adminRejectionClicks?: number; rejectionReason?: string;
  rejectionStage?: string; positionsAfter?: WealthJourneyEvidence['oldPositions'];
  productName?: string; productId?: string; holdingOrderId?: string; purchaseAccount?: string; settlementAccount?: string;
  amount?: string; currency?: string; fee?: string; expectedDebit?: string; expectedCredit?: string;
  before?: AccountBalanceSnapshot; submitted?: AccountBalanceSnapshot; after?: AccountBalanceSnapshot;
  oldOrderIds: string[]; oldPositions?: { productId: string; productName: string; principal: string; currency: string; status: string }[];
  clientOrder?: WealthHistoryRecord; clientStatus?: string; adminStatus?: string; candidateCount?: number;
  confirmationClicks: number; securityVerificationClicks: number; adminApprovalClicks: number;
  createdAt?: string; failure?: string; completed: boolean;
};

export class WealthJourneyStore {
  readonly states: FlowStateStore;
  state: FlowResumeState;
  evidence: WealthJourneyEvidence;
  private readonly path: string;

  constructor(kind: WealthJourneyEvidence['kind'], runId: string, email: string, resume = false,
    options: { decision?: 'approve' | 'reject'; rootDirectory?: string } = {}) {
    const flowId = `wealth-${kind}`;
    const root = options.rootDirectory ?? resolve('.flow-state');
    this.states = new FlowStateStore(root);
    this.path = this.states.pathFor(flowId, runId).replace(/\.json$/, '.evidence');
    const existing = this.states.load(flowId, runId);
    const identityHash = createHash('sha256').update(email.toLowerCase()).digest('hex');
    if (existing) {
      if (!resume || !existsSync(this.path)) throw new Error('Existing wealth Run requires explicit Resume, never a replacement.');
      this.state = existing;
      this.evidence = JSON.parse(readFileSync(this.path, 'utf8'));
      if (this.evidence.identityHash !== identityHash || this.evidence.kind !== kind) throw new Error('Wealth Resume identity mismatch.');
      if ((this.evidence.decision ?? 'approve') !== (options.decision ?? 'approve')) {
        throw new Error('Wealth Resume decision mismatch: approval and rejection cannot operate each other\'s Run.');
      }
    } else {
      if (resume) throw new Error('Wealth Resume state not found.');
      if (this.states.list(flowId).some(s => s.stage !== 'COMPLETED' && stageIndex(s.stage) >= stageIndex('CLIENT_SUBMIT_ATTEMPTED'))) {
        throw new Error('An earlier wealth submission requires reconciliation; no new order allowed.');
      }
      this.state = createPreparedFlowState({ flowId, runId });
      this.evidence = { runId, kind, identityHash, oldOrderIds: [], confirmationClicks: 0,
        securityVerificationClicks: 0, adminApprovalClicks: 0, completed: false, decision: options.decision ?? 'approve' };
      this.save();
    }
  }

  reserveRejectionAttempt(): void {
    if (this.evidence.decision !== 'reject' || this.evidence.adminRejectionClicks || this.evidence.adminApprovalClicks ||
      this.state.stage !== 'ADMIN_LOCATED' || !this.evidence.clientOrder || this.evidence.candidateCount !== 1) {
      throw new Error('Rejection requires this Run\'s original order, one verified candidate and zero prior Admin attempts.');
    }
    // An exclusive tombstone survives a crash before the evidence write; never click after EEXIST.
    writeFileSync(`${this.path}.reject-attempt`, new Date().toISOString(), { flag: 'wx' });
    this.evidence.adminRejectionClicks = 1;
    this.save();
  }

  save(): void {
    this.state = { ...this.state, amount: this.evidence.amount, currency: this.evidence.currency };
    this.states.save(this.state);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.evidence, null, 2));
    renameSync(`${this.path}.tmp`, this.path);
  }

  advance(stage: FlowStage, updates: Parameters<typeof advanceFlowState>[2] = {}): void {
    this.state = advanceFlowState(this.state, stage, updates);
    this.save();
  }
}

export async function verifyWealthIdentity(page: Page, baseURL: string, email: string) {
  const response = await page.request.get(new URL('/server/auth/session', baseURL).toString());
  expect(response.ok(), 'Client identity read').toBe(true);
  const session = await response.json();
  const accountType = String(session.entityType) === '2' ? 'BUSINESS' : 'PERSONAL';
  expect(decodeClientKycStatus(session, { accountType, email }).approved, 'Existing user KYC approved').toBe(true);
  return { accountType, userId: String(session.user?.id ?? session.userId ?? '') };
}

export function uniqueSubscriptionAmount(minimum: string, runId: string): string {
  const cents = (createHash('sha256').update(runId).digest().readUInt16BE(0) % 89) + 10;
  return new Decimal(minimum).add(new Decimal(cents).div(100)).toFixed(2);
}

export function matchingNewWealthOrders(records: WealthHistoryRecord[], evidence: WealthJourneyEvidence) {
  const submitted = Date.parse(evidence.createdAt ?? '');
  return records.filter(row => !evidence.oldOrderIds.includes(row.orderId) && row.productName === evidence.productName &&
    row.currency === evidence.currency && new Decimal(row.amount).eq(evidence.amount!) &&
    (!evidence.purchaseAccount || row.purchaseAccount === evidence.purchaseAccount) &&
    Number.isFinite(submitted) && Math.abs(Date.parse(row.createdAt.replace(/\//g, '-')) - submitted) <= 300_000);
}

export function observeWealthNetwork(page: Page, publish: (entries: string[]) => void) {
  const entries: string[] = [];
  const listener = (response: import('@playwright/test').Response) => {
    const url = new URL(response.url());
    if (!/^\/(?:api|admin-api)\//.test(url.pathname) || !/invest|security/i.test(url.pathname)) return;
    entries.push(`${new Date().toISOString()} ${response.request().method()} ${url.hostname}${maskSensitiveText(url.pathname)} HTTP ${response.status()}`);
    publish([...entries]);
  };
  page.on('response', listener);
  return () => { page.off('response', listener); return entries; };
}
