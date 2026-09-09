import { Decimal } from '../utils/money';
import {
  customerIdentityHash,
  deriveReproducibleMoneyAmount,
  matchCandidatesByStages,
  matchesConfiguredCustomerIdentity,
  MoneyMutationGuard,
  requireExactlyOneCandidate
} from '../flow-engine';

export const clientDepositIdPattern = /^TXN-[A-Z0-9-]+$/i;

export type DepositFingerprint = {
  runId: string;
  userIdentity: string;
  accountType: string;
  currency: string;
  requestedAmount: string;
  clientSubmittedAtMs: number;
  adminStatus: string;
  channel?: string;
  reference?: string;
};

export type AdminDepositCandidate = {
  recordKey: string;
  submittedAtText: string;
  submittedAtMs: number;
  accountType: string;
  currency: string;
  requestedAmount: string;
  actualAmount: string;
  payerText: string;
  channel: string;
  reference: string;
  matchedCustomerText: string;
  matchStatus: string;
  status: string;
};

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function depositCustomerIdentityHash(customerText: string): string {
  return customerIdentityHash(customerText);
}

export function matchesDepositCustomerIdentity(
  customerText: string,
  configuredIdentity: string
): boolean {
  return matchesConfiguredCustomerIdentity(customerText, configuredIdentity);
}

export type AdminDepositCandidateDiagnostics = {
  counts: {
    allRecords: number;
    accountType: number;
    currency: number;
    requestedAmount: number;
    status: number;
    channel: number;
    timeWindow: number;
    user: number;
  };
  candidates: AdminDepositCandidate[];
  preUserIdentityHashes: string[];
};

export function diagnoseAdminDepositCandidates(
  records: readonly AdminDepositCandidate[],
  fingerprint: DepositFingerprint,
  matchWindowMs: number
): AdminDepositCandidateDiagnostics {
  const amount = new Decimal(fingerprint.requestedAmount);
  const result = matchCandidatesByStages(records, [
    { id: 'accountType', label: '账户', matches: record => normalizedText(record.accountType) === normalizedText(fingerprint.accountType) },
    { id: 'currency', label: '币种', matches: record => record.currency.toUpperCase() === fingerprint.currency.toUpperCase() },
    { id: 'requestedAmount', label: '申请金额', matches: record => new Decimal(record.requestedAmount).equals(amount) },
    { id: 'status', label: '状态', matches: record => normalizedText(record.status) === normalizedText(fingerprint.adminStatus) },
    { id: 'channel', label: '渠道', matches: record => !fingerprint.channel || normalizedText(record.channel) === normalizedText(fingerprint.channel) },
    {
      id: 'timeWindow',
      label: '时间窗口',
      matches: record => record.submittedAtMs >= fingerprint.clientSubmittedAtMs - matchWindowMs && record.submittedAtMs <= fingerprint.clientSubmittedAtMs + matchWindowMs
    },
    { id: 'user', label: '测试用户', matches: record => matchesDepositCustomerIdentity(record.matchedCustomerText, fingerprint.userIdentity) }
  ]);
  const timeStageIndex = result.stages.findIndex(stage => stage.id === 'timeWindow');
  const beforeUser = records.filter(record =>
    result.stages.slice(0, timeStageIndex + 1).every((stage, index) => {
      const matcher = [
        (item: AdminDepositCandidate) => normalizedText(item.accountType) === normalizedText(fingerprint.accountType),
        (item: AdminDepositCandidate) => item.currency.toUpperCase() === fingerprint.currency.toUpperCase(),
        (item: AdminDepositCandidate) => new Decimal(item.requestedAmount).equals(amount),
        (item: AdminDepositCandidate) => normalizedText(item.status) === normalizedText(fingerprint.adminStatus),
        (item: AdminDepositCandidate) => !fingerprint.channel || normalizedText(item.channel) === normalizedText(fingerprint.channel),
        (item: AdminDepositCandidate) => item.submittedAtMs >= fingerprint.clientSubmittedAtMs - matchWindowMs && item.submittedAtMs <= fingerprint.clientSubmittedAtMs + matchWindowMs
      ][index];
      return matcher(record);
    })
  );

  return {
    counts: {
      allRecords: result.initialCount,
      accountType: result.counts.accountType,
      currency: result.counts.currency,
      requestedAmount: result.counts.requestedAmount,
      status: result.counts.status,
      channel: result.counts.channel,
      timeWindow: result.counts.timeWindow,
      user: result.counts.user
    },
    candidates: result.candidates,
    preUserIdentityHashes: [...new Set(beforeUser.map(record =>
      depositCustomerIdentityHash(record.matchedCustomerText)
    ))]
  };
}

export function deriveUniqueDepositAmount(
  runId: string,
  baseAmount: string,
  precision: number
): Decimal {
  return deriveReproducibleMoneyAmount(runId, baseAmount, precision);
}

export function buildDepositRejectReason(runId: string): string {
  const suffix = runId.replace(/[^A-Z0-9]/gi, '').slice(-20);
  if (!suffix) throw new Error('Deposit rejection runId is required.');
  return `AUTO_DP002_REJECT_${suffix}`;
}

export function buildDepositApprovalRemark(runId: string): string {
  const suffix = runId.replace(/[^A-Z0-9]/gi, '').slice(-20);
  if (!suffix) throw new Error('Deposit approval runId is required.');
  return `AUTO_DP003_APPROVE_${suffix}`;
}

export function matchAdminDepositCandidates(
  records: readonly AdminDepositCandidate[],
  fingerprint: DepositFingerprint,
  matchWindowMs: number,
  options: { applyTimeWindow: boolean } = { applyTimeWindow: true }
): AdminDepositCandidate[] {
  if (!Number.isSafeInteger(matchWindowMs) || matchWindowMs <= 0) {
    throw new Error('Deposit match window must be a positive integer.');
  }

  const expectedAmount = new Decimal(fingerprint.requestedAmount);
  return records.filter(record => {
    const amount = new Decimal(record.requestedAmount);
    const timeMatches = !options.applyTimeWindow || (
      record.submittedAtMs >= fingerprint.clientSubmittedAtMs - matchWindowMs &&
      record.submittedAtMs <= fingerprint.clientSubmittedAtMs + matchWindowMs
    );
    const channelMatches = !fingerprint.channel ||
      normalizedText(record.channel) === normalizedText(fingerprint.channel);
    const referenceMatches = !fingerprint.reference || fingerprint.reference === '-' ||
      normalizedText(record.reference) === normalizedText(fingerprint.reference);

    return (
      matchesDepositCustomerIdentity(record.matchedCustomerText, fingerprint.userIdentity) &&
      normalizedText(record.accountType) === normalizedText(fingerprint.accountType) &&
      record.currency.toUpperCase() === fingerprint.currency.toUpperCase() &&
      amount.isFinite() && amount.equals(expectedAmount) &&
      normalizedText(record.status) === normalizedText(fingerprint.adminStatus) &&
      channelMatches && referenceMatches && timeMatches
    );
  });
}

export function matchAdminDepositRecordsIgnoringStatus(
  records: readonly AdminDepositCandidate[],
  fingerprint: DepositFingerprint,
  matchWindowMs: number
): AdminDepositCandidate[] {
  if (!Number.isSafeInteger(matchWindowMs) || matchWindowMs <= 0) {
    throw new Error('Deposit match window must be a positive integer.');
  }
  const expectedAmount = new Decimal(fingerprint.requestedAmount);
  return records.filter(record => {
    const channelMatches = !fingerprint.channel ||
      normalizedText(record.channel) === normalizedText(fingerprint.channel);
    const referenceMatches = !fingerprint.reference || fingerprint.reference === '-' ||
      normalizedText(record.reference) === normalizedText(fingerprint.reference);
    const timeMatches = record.submittedAtMs >= fingerprint.clientSubmittedAtMs - matchWindowMs &&
      record.submittedAtMs <= fingerprint.clientSubmittedAtMs + matchWindowMs;
    return matchesDepositCustomerIdentity(record.matchedCustomerText, fingerprint.userIdentity) &&
      normalizedText(record.accountType) === normalizedText(fingerprint.accountType) &&
      record.currency.toUpperCase() === fingerprint.currency.toUpperCase() &&
      new Decimal(record.requestedAmount).equals(expectedAmount) &&
      channelMatches && referenceMatches && timeMatches;
  });
}

export function requireUniqueAdminDepositCandidate(
  candidates: readonly AdminDepositCandidate[]
): AdminDepositCandidate {
  return requireExactlyOneCandidate(candidates, 'Deposit Admin');
}

export function expectedDepositBalanceAfterClaim(
  balanceBefore: Decimal,
  actualDepositAmount: Decimal
): Decimal {
  if (!balanceBefore.isFinite() || !actualDepositAmount.isFinite() || actualDepositAmount.isNegative()) {
    throw new Error('Deposit balance Oracle requires finite non-negative values.');
  }
  return balanceBefore.plus(actualDepositAmount);
}

export class DepositExecutionGuard {
  private readonly guard = new MoneyMutationGuard('Deposit E2E');

  markAuthenticationReady(clientReady: boolean, adminReady: boolean): void {
    if (!clientReady || !adminReady) {
      throw new Error('Deposit E2E requires valid Client and Admin sessions before submission.');
    }
    this.guard.markAuthenticationReady(clientReady, adminReady);
  }

  assertClientSubmissionAllowed(
    allowMoneyTests: boolean,
    allowAdminMutationTests: boolean
  ): void {
    if (!this.guard.snapshot().authenticationReady) {
      throw new Error('Deposit authentication preflight has not completed.');
    }
    if (!allowMoneyTests || !allowAdminMutationTests) {
      throw new Error(
        'Deposit mutation requires ALLOW_MONEY_TESTS=true and ALLOW_ADMIN_MUTATION_TESTS=true.'
      );
    }
    this.guard.assertClientSubmissionAllowed({
      ALLOW_MONEY_TESTS: allowMoneyTests,
      ALLOW_ADMIN_MUTATION_TESTS: allowAdminMutationTests
    });
  }

  recordClientSubmission(clientDepositId: string): void {
    if (!clientDepositIdPattern.test(clientDepositId)) {
      throw new Error('Client Deposit did not provide a valid TXN order identifier.');
    }
    this.guard.recordClientSubmission();
  }

  recordClientSubmissionFromAdminCandidate(): void {
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
      throw new Error('Deposit Admin mutation is blocked until candidateCount equals 1.');
    }
    if (!allowMoneyTests || !allowAdminMutationTests) {
      throw new Error('Deposit Admin mutation safety switches are closed.');
    }
  }
}
