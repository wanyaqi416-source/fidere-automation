import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FlowStateStore, stageIndex, type FlowResumeState } from '../flow-engine/resume-state';

export const U2U_FLOW_ID = 'user-to-user-transfer';
export type U2uEvidence = {
  runId: string;
  senderHash: string;
  recipientHash: string;
  sourceAccountType: string;
  targetAccountType: string;
  currency: string;
  amount: string;
  fee: string;
  expectedCredit: string;
  senderBefore: string;
  recipientBefore: string;
  senderAfter?: string;
  recipientAfter?: string;
  senderLedgerIdsBefore: string[];
  recipientLedgerIdsBefore: string[];
  submittedAt?: string;
  orderId?: string;
  senderLedgerId?: string;
  recipientLedgerId?: string;
  status?: string;
  adminApprovalClicks?: number;
  adminConfirmationClicks?: number;
  adminStatus?: string;
  confirmationClicks: number;
  verificationClicks: number;
  requestCount: number;
  network: { path: string; method: string; status: number; requestedAt: string }[];
};

export const participantHash = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

export function assertU2uFreshAllowed(states: FlowResumeState[], runId: string) {
  if (states.some(state => state.runId === runId ||
    (state.stage !== 'COMPLETED' && stageIndex(state.stage) >= stageIndex('CLIENT_SUBMIT_ATTEMPTED')))) {
    throw new Error('An existing U2U attempt must be reconciled; a replacement transfer is forbidden.');
  }
}

function evidencePath(runId: string) {
  const statePath = new FlowStateStore().pathFor(U2U_FLOW_ID, runId);
  return join(dirname(statePath), 'evidence', `${runId}.json`);
}

export function saveU2uEvidence(evidence: U2uEvidence) {
  // Explicit whitelist: no session, credentials, raw API body, or full identity.
  const safe: U2uEvidence = {
    runId: evidence.runId, senderHash: evidence.senderHash, recipientHash: evidence.recipientHash,
    sourceAccountType: evidence.sourceAccountType, targetAccountType: evidence.targetAccountType,
    currency: evidence.currency, amount: evidence.amount, fee: evidence.fee,
    expectedCredit: evidence.expectedCredit, senderBefore: evidence.senderBefore, recipientBefore: evidence.recipientBefore,
    senderAfter: evidence.senderAfter, recipientAfter: evidence.recipientAfter,
    senderLedgerIdsBefore: evidence.senderLedgerIdsBefore, recipientLedgerIdsBefore: evidence.recipientLedgerIdsBefore,
    submittedAt: evidence.submittedAt, orderId: evidence.orderId, senderLedgerId: evidence.senderLedgerId,
    recipientLedgerId: evidence.recipientLedgerId, status: evidence.status,
    adminApprovalClicks: evidence.adminApprovalClicks, adminConfirmationClicks: evidence.adminConfirmationClicks,
    adminStatus: evidence.adminStatus,
    confirmationClicks: evidence.confirmationClicks, verificationClicks: evidence.verificationClicks,
    requestCount: evidence.requestCount,
    network: evidence.network.map(({ path, method, status, requestedAt }) => ({ path, method, status, requestedAt }))
  };
  const path = evidencePath(evidence.runId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(safe, null, 2), 'utf8');
  renameSync(`${path}.tmp`, path);
}

export function loadU2uEvidence(runId: string): U2uEvidence {
  const path = evidencePath(runId);
  if (!existsSync(path)) throw new Error('Original U2U evidence not found; do not create a replacement transfer.');
  const evidence = JSON.parse(readFileSync(path, 'utf8')) as U2uEvidence;
  if (evidence.runId !== runId || !evidence.senderBefore || !evidence.recipientBefore) {
    throw new Error('Original U2U baselines are missing.');
  }
  return evidence;
}
