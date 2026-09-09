import { createHash } from 'node:crypto';

import { Decimal } from '../utils/money';
import { matchesDepositCustomerIdentity } from '../deposit/deposit-e2e';
import {
  deriveReproducibleMoneyAmount,
  matchCandidatesByStages,
  MoneyMutationGuard,
  requireExactlyOneCandidate
} from '../flow-engine';

export const clientWithdrawalIdPattern = /^TXN-[A-Z0-9-]+$/i;

export type WithdrawalFingerprint = {
  runId: string;
  userIdentity: string;
  accountType: string;
  currency: string;
  requestedAmount: string;
  clientSubmittedAtMs: number;
  adminStatus: string;
};

export type AdminWithdrawalCandidate = {
  recordKey: string;
  submittedAtText: string;
  submittedAtMs: number;
  userText: string;
  accountType: string;
  currency: string;
  requestedAmount: string;
  feeAmount: string;
  beneficiaryText: string;
  purpose: string;
  status: string;
};

export type WithdrawalCandidateDiagnostics = {
  counts: {
    allRecords: number;
    accountType: number;
    currency: number;
    requestedAmount: number;
    status: number;
    timeWindow: number;
    user: number;
  };
  candidates: AdminWithdrawalCandidate[];
};

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function withdrawalRecordKey(rowText: string): string {
  return `sha256:${createHash('sha256').update(normalizedText(rowText)).digest('hex')}`;
}

export function deriveUniqueWithdrawalAmount(
  runId: string,
  baseAmount: string,
  precision: number
): Decimal {
  return deriveReproducibleMoneyAmount(runId, baseAmount, precision, {
    minimumPrecision: 1
  });
}

export function deriveUnusedWithdrawalAmount(
  runId: string,
  baseAmount: string,
  precision: number,
  excludedAmounts: readonly string[]
): Decimal {
  const excluded = excludedAmounts.map(amount => new Decimal(amount));
  const candidateCount = new Decimal(10).pow(precision).minus(1).toNumber();

  for (let index = 0; index < candidateCount; index += 1) {
    const candidate = deriveUniqueWithdrawalAmount(
      index === 0 ? runId : `${runId}-${index}`,
      baseAmount,
      precision
    );
    if (!excluded.some(amount => amount.equals(candidate))) return candidate;
  }

  throw new Error('Withdrawal could not derive an unused amount at the configured precision.');
}

export function diagnoseAdminWithdrawalCandidates(
  records: readonly AdminWithdrawalCandidate[],
  fingerprint: WithdrawalFingerprint,
  matchWindowMs: number,
  options: { applyTimeWindow?: boolean } = {}
): WithdrawalCandidateDiagnostics {
  if (!Number.isSafeInteger(matchWindowMs) || matchWindowMs <= 0) {
    throw new Error('Withdrawal match window must be a positive integer.');
  }
  const expectedAmount = new Decimal(fingerprint.requestedAmount);
  const result = matchCandidatesByStages(records, [
    { id: 'accountType', label: '账户', matches: record => normalizedText(record.accountType) === normalizedText(fingerprint.accountType) },
    { id: 'currency', label: '币种', matches: record => record.currency.toUpperCase() === fingerprint.currency.toUpperCase() },
    { id: 'requestedAmount', label: '申请金额', matches: record => new Decimal(record.requestedAmount).equals(expectedAmount) },
    { id: 'status', label: '状态', matches: record => normalizedText(record.status) === normalizedText(fingerprint.adminStatus) },
    {
      id: 'timeWindow',
      label: '时间窗口',
      matches: record => options.applyTimeWindow === false || (record.submittedAtMs >= fingerprint.clientSubmittedAtMs - matchWindowMs && record.submittedAtMs <= fingerprint.clientSubmittedAtMs + matchWindowMs)
    },
    { id: 'user', label: '测试用户', matches: record => matchesDepositCustomerIdentity(record.userText, fingerprint.userIdentity) }
  ]);

  return {
    counts: {
      allRecords: result.initialCount,
      accountType: result.counts.accountType,
      currency: result.counts.currency,
      requestedAmount: result.counts.requestedAmount,
      status: result.counts.status,
      timeWindow: result.counts.timeWindow,
      user: result.counts.user
    },
    candidates: result.candidates
  };
}

export function requireUniqueAdminWithdrawalCandidate(
  candidates: readonly AdminWithdrawalCandidate[]
): AdminWithdrawalCandidate {
  return requireExactlyOneCandidate(candidates, 'Withdrawal Admin');
}

export function matchAdminWithdrawalRecordsIgnoringStatus(
  records: readonly AdminWithdrawalCandidate[],
  fingerprint: WithdrawalFingerprint,
  matchWindowMs: number
): AdminWithdrawalCandidate[] {
  if (!Number.isSafeInteger(matchWindowMs) || matchWindowMs <= 0) {
    throw new Error('Withdrawal match window must be a positive integer.');
  }
  const expectedAmount = new Decimal(fingerprint.requestedAmount);
  return records.filter(record =>
    normalizedText(record.accountType) === normalizedText(fingerprint.accountType) &&
    record.currency.toUpperCase() === fingerprint.currency.toUpperCase() &&
    new Decimal(record.requestedAmount).equals(expectedAmount) &&
    record.submittedAtMs >= fingerprint.clientSubmittedAtMs - matchWindowMs &&
    record.submittedAtMs <= fingerprint.clientSubmittedAtMs + matchWindowMs &&
    matchesDepositCustomerIdentity(record.userText, fingerprint.userIdentity)
  );
}

export function buildWithdrawalRejectReason(runId: string): string {
  const suffix = runId.replace(/[^A-Z0-9]/gi, '').slice(-20);
  if (!suffix) throw new Error('Withdrawal rejection runId is required.');
  return `AUTO_WITHDRAW_REJECT_${suffix}`;
}

export function buildWithdrawalApprovalNote(runId: string, prefix: string): string {
  const normalizedPrefix = prefix.trim().replace(/[^A-Z0-9_]/gi, '_').slice(0, 40);
  const suffix = runId.replace(/[^A-Z0-9]/gi, '').slice(-20);
  if (!normalizedPrefix || !suffix) {
    throw new Error('Withdrawal approval note prefix and runId are required.');
  }
  return `${normalizedPrefix}_${suffix}`;
}

export class WithdrawalExecutionGuard {
  private readonly guard = new MoneyMutationGuard('Withdrawal E2E');

  markAuthenticationReady(clientReady: boolean, adminReady: boolean): void {
    if (!clientReady || !adminReady) {
      throw new Error('Withdrawal E2E requires valid Client and Admin sessions before submission.');
    }
    this.guard.markAuthenticationReady(clientReady, adminReady);
  }

  assertClientSubmissionAllowed(
    allowMoneyTests: boolean,
    allowAdminMutationTests: boolean
  ): void {
    if (!this.guard.snapshot().authenticationReady) {
      throw new Error('Withdrawal authentication preflight has not completed.');
    }
    if (!allowMoneyTests || !allowAdminMutationTests) {
      throw new Error(
        'Withdrawal mutation requires ALLOW_MONEY_TESTS=true and ALLOW_ADMIN_MUTATION_TESTS=true.'
      );
    }
    this.guard.assertClientSubmissionAllowed({
      ALLOW_MONEY_TESTS: allowMoneyTests,
      ALLOW_ADMIN_MUTATION_TESTS: allowAdminMutationTests
    });
  }

  recordClientSubmission(clientWithdrawalId: string): void {
    if (!clientWithdrawalIdPattern.test(clientWithdrawalId)) {
      throw new Error('Client Withdrawal did not provide a valid TXN order identifier.');
    }
    this.guard.recordClientSubmission();
  }

  recordUniqueAdminCandidate(candidateCount: number): void {
    this.guard.recordUniqueAdminCandidate(candidateCount);
  }

  assertAdminMutationAllowed(
    allowMoneyTests: boolean,
    allowAdminMutationTests: boolean
  ): void {
    if (!this.guard.snapshot().uniqueAdminCandidate) {
      throw new Error('Withdrawal Admin mutation is blocked until candidateCount equals 1.');
    }
    if (!allowMoneyTests || !allowAdminMutationTests) {
      throw new Error('Withdrawal Admin mutation safety switches are closed.');
    }
  }
}
