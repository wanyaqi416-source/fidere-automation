import { Decimal } from '../utils/money';
import {
  deriveReproducibleMoneyAmount,
  matchCandidatesByStages,
  matchesConfiguredCustomerIdentity,
  MoneyMutationGuard,
  requireExactlyOneCandidate
} from '../flow-engine';

export const clientTransferIdPattern = /^TRF-[A-Z0-9-]+$/i;
export const adminTransferIdPattern = /^TXN-[A-Z0-9-]+$/i;

export type TransferFingerprint = {
  runId: string;
  userIdentity: string;
  sourceAccountType: string;
  targetAccountType: string;
  currency: string;
  amount: string;
  runStartedAtMs: number;
  clientSubmittedAtMs: number;
  adminStatus: string;
};

export type AdminTransferCandidate = {
  adminTransactionId: string;
  recordType: string;
  userIdentity: string;
  sourceAccountType: string;
  targetAccountType: string;
  currency: string;
  amount: string;
  requestedAmount: string;
  feeAmount: string;
  netAmount: string;
  createdAtMs?: number;
  status: string;
};

export type AdminTransferCandidateCriteria = {
  recordType: string;
  userIdentity: string;
  sourceAccountType: string;
  targetAccountType: string;
  currency: string;
  requestedAmount: string;
  status: string;
};

export type AdminTransferCandidateStageCounts = {
  allRecords: number;
  recordType: number;
  sourceAccount: number;
  targetAccount: number;
  currency: number;
  requestedAmount: number;
  status: number;
  user: number;
};

export type AdminTransferCandidateDiagnostics = {
  counts: AdminTransferCandidateStageCounts;
  candidates: AdminTransferCandidate[];
};

export type TransferSubmissionEvidence = {
  clientTransferId: string;
  submittedAtMs: number;
};

export type TransferAmountSafety = {
  fee: string;
  minimumAmount: string;
  availableBalance: string;
};

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function normalizedCurrency(value: string): string {
  return value.trim().toUpperCase();
}

const confirmedTransferAccountSemantics = new Map<string, string>([
  [normalizedText('香港账户'), 'jurisdiction:hong-kong'],
  [normalizedText('老虎证券'), 'broker:tiger'],
  [normalizedText('老虎证券券商账户'), 'broker:tiger']
]);

export function transferAccountSemantic(value: string): string {
  const normalized = normalizedText(value);
  return confirmedTransferAccountSemantics.get(normalized) ?? `literal:${normalized}`;
}

export function transferAccountsMatch(actual: string, expected: string): boolean {
  return transferAccountSemantic(actual) === transferAccountSemantic(expected);
}

export function matchesAdminCustomerIdentity(
  customerText: string,
  configuredIdentity: string
): boolean {
  return matchesConfiguredCustomerIdentity(customerText, configuredIdentity);
}

export function diagnoseAdminTransferCandidates(
  records: readonly AdminTransferCandidate[],
  criteria: AdminTransferCandidateCriteria
): AdminTransferCandidateDiagnostics {
  const expectedAmount = new Decimal(criteria.requestedAmount);
  if (!expectedAmount.isFinite()) {
    throw new Error('Admin Transfer diagnostic requested amount must be a finite decimal.');
  }

  const result = matchCandidatesByStages(records, [
    {
      id: 'recordType',
      label: '记录类型',
      matches: record => normalizedText(record.recordType) === normalizedText(criteria.recordType)
    },
    {
      id: 'sourceAccount',
      label: '转出账户',
      matches: record => transferAccountsMatch(record.sourceAccountType, criteria.sourceAccountType)
    },
    {
      id: 'targetAccount',
      label: '转入账户',
      matches: record => transferAccountsMatch(record.targetAccountType, criteria.targetAccountType)
    },
    {
      id: 'currency',
      label: '币种',
      matches: record => normalizedCurrency(record.currency) === normalizedCurrency(criteria.currency)
    },
    {
      id: 'requestedAmount',
      label: '申请金额',
      matches: record => {
        const amount = new Decimal(record.requestedAmount);
        return amount.isFinite() && amount.equals(expectedAmount);
      }
    },
    {
      id: 'status',
      label: '状态',
      matches: record => normalizedText(record.status) === normalizedText(criteria.status)
    },
    {
      id: 'user',
      label: '测试用户',
      matches: record => matchesAdminCustomerIdentity(record.userIdentity, criteria.userIdentity)
    }
  ]);

  return {
    counts: {
      allRecords: result.initialCount,
      recordType: result.counts.recordType,
      sourceAccount: result.counts.sourceAccount,
      targetAccount: result.counts.targetAccount,
      currency: result.counts.currency,
      requestedAmount: result.counts.requestedAmount,
      status: result.counts.status,
      user: result.counts.user
    },
    candidates: result.candidates
  };
}

function assertTimestamp(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive epoch timestamp.`);
  }
}

export function deriveUniqueTransferAmount(
  runId: string,
  baseAmount: string,
  precision: number
): Decimal {
  return deriveReproducibleMoneyAmount(runId, baseAmount, precision);
}

export function assertTransferAmountSafe(
  amount: Decimal,
  safety: TransferAmountSafety
): void {
  const fee = new Decimal(safety.fee);
  const minimum = new Decimal(safety.minimumAmount);
  const available = new Decimal(safety.availableBalance);

  if (![amount, fee, minimum, available].every(value => value.isFinite())) {
    throw new Error('Transfer amount safety values must all be finite decimals.');
  }

  if (!amount.greaterThan(fee)) {
    throw new Error('Transfer amount must be greater than the displayed fee.');
  }

  if (amount.lessThan(minimum)) {
    throw new Error('Transfer amount is below the confirmed minimum amount.');
  }

  if (amount.greaterThan(available)) {
    throw new Error('Transfer amount exceeds the jurisdiction account available balance.');
  }
}

export function buildTransferFingerprint(
  input: Omit<TransferFingerprint, 'amount' | 'currency'> & {
    amount: Decimal;
    currency: string;
  }
): TransferFingerprint {
  assertTimestamp('runStartedAtMs', input.runStartedAtMs);
  assertTimestamp('clientSubmittedAtMs', input.clientSubmittedAtMs);

  if (input.clientSubmittedAtMs < input.runStartedAtMs) {
    throw new Error('Client Transfer submission time cannot precede the E2E run start time.');
  }

  return {
    ...input,
    amount: input.amount.toString(),
    currency: normalizedCurrency(input.currency)
  };
}

export function matchAdminTransferCandidates(
  candidates: readonly AdminTransferCandidate[],
  fingerprint: TransferFingerprint,
  postSubmissionWindowMs: number
): AdminTransferCandidate[] {
  if (!Number.isSafeInteger(postSubmissionWindowMs) || postSubmissionWindowMs <= 0) {
    throw new Error('Transfer post-submission match window must be a positive integer.');
  }

  const expectedAmount = new Decimal(fingerprint.amount);

  return matchCandidatesByStages(candidates, [
    { id: 'adminId', label: 'Admin编号', matches: candidate => adminTransferIdPattern.test(candidate.adminTransactionId) },
    { id: 'user', label: '测试用户', matches: candidate => matchesAdminCustomerIdentity(candidate.userIdentity, fingerprint.userIdentity) },
    { id: 'sourceAccount', label: '转出账户', matches: candidate => transferAccountsMatch(candidate.sourceAccountType, fingerprint.sourceAccountType) },
    { id: 'targetAccount', label: '转入账户', matches: candidate => transferAccountsMatch(candidate.targetAccountType, fingerprint.targetAccountType) },
    { id: 'currency', label: '币种', matches: candidate => normalizedCurrency(candidate.currency) === normalizedCurrency(fingerprint.currency) },
    {
      id: 'amount',
      label: '申请金额',
      matches: candidate => {
        const amount = new Decimal(candidate.requestedAmount);
        return amount.isFinite() && amount.equals(expectedAmount);
      }
    },
    { id: 'status', label: '状态', matches: candidate => normalizedText(candidate.status) === normalizedText(fingerprint.adminStatus) }
  ]).candidates;
}

export function requireUniqueAdminTransferCandidate(
  candidates: readonly AdminTransferCandidate[]
): AdminTransferCandidate {
  return requireExactlyOneCandidate(candidates, 'Transfer Admin');
}

export function assertTransferSubmissionEvidence(
  evidence: TransferSubmissionEvidence
): void {
  if (!clientTransferIdPattern.test(evidence.clientTransferId)) {
    throw new Error('Client Transfer submission did not provide a valid TRF business identifier.');
  }

  assertTimestamp('submittedAtMs', evidence.submittedAtMs);
}

export function buildTransferRejectReason(runId: string, maxLength = 200): string {
  const safeRunId = runId.trim().replace(/[^A-Z0-9_-]/gi, '_');
  if (!safeRunId) {
    throw new Error('Transfer rejection reason requires a non-empty runId.');
  }

  const reason = `AUTO_TRANSFER_E2E_REJECT_${safeRunId}`;
  if (maxLength < 32 || !Number.isInteger(maxLength)) {
    throw new Error('Transfer rejection reason maxLength must be an integer of at least 32.');
  }

  return reason.slice(0, maxLength);
}

export function buildTransferApprovalRemark(runId: string, maxLength = 200): string {
  const safeRunId = runId.trim().replace(/[^A-Z0-9_-]/gi, '_');
  if (!safeRunId) {
    throw new Error('Transfer approval remark requires a non-empty runId.');
  }

  const remark = `AUTO_TRANSFER_E2E_APPROVE_${safeRunId}`;
  if (maxLength < 32 || !Number.isInteger(maxLength)) {
    throw new Error('Transfer approval remark maxLength must be an integer of at least 32.');
  }

  return remark.slice(0, maxLength);
}

export function assertFeeIncludedTransferPreview(
  amount: Decimal,
  fee: Decimal,
  receivedAmount: Decimal
): void {
  if (![amount, fee, receivedAmount].every(value => value.isFinite())) {
    throw new Error('Transfer preview values must all be finite decimals.');
  }
  if (amount.isNegative() || fee.isNegative() || receivedAmount.isNegative()) {
    throw new Error('Transfer preview values cannot be negative.');
  }
  if (!fee.plus(receivedAmount).equals(amount)) {
    throw new Error(
      'Transfer preview does not follow the confirmed fee-included rule: amount = fee + received amount.'
    );
  }
}

export function expectedJurisdictionBalanceAfterApproval(
  balanceBefore: Decimal,
  transferAmount: Decimal
): Decimal {
  if (!balanceBefore.isFinite() || !transferAmount.isFinite() || !transferAmount.isPositive()) {
    throw new Error('Transfer approval balance Oracle requires finite positive values.');
  }
  if (transferAmount.greaterThan(balanceBefore)) {
    throw new Error('Transfer approval amount exceeds the jurisdiction balance Oracle.');
  }

  // The displayed transfer amount is gross: the fee is deducted inside it.
  return balanceBefore.minus(transferAmount);
}

export class TransferExecutionGuard {
  private readonly guard = new MoneyMutationGuard('Transfer E2E');

  markAuthenticationReady(clientReady: boolean, adminReady: boolean): void {
    if (!clientReady || !adminReady) {
      throw new Error(
        'Transfer E2E authentication preflight failed. Client submission is blocked before any money operation.'
      );
    }

    this.guard.markAuthenticationReady(clientReady, adminReady);
  }

  assertClientSubmissionAllowed(
    allowMoneyTests: boolean,
    allowAdminMutationTests: boolean
  ): void {
    if (!this.guard.snapshot().authenticationReady) {
      throw new Error('Transfer E2E requires valid Client and Admin sessions before Client submission.');
    }

    if (!allowMoneyTests) {
      throw new Error('Transfer E2E is disabled because ALLOW_MONEY_TESTS is false.');
    }

    if (!allowAdminMutationTests) {
      throw new Error(
        'Transfer E2E is disabled because ALLOW_ADMIN_MUTATION_TESTS is false.'
      );
    }

    this.guard.assertClientSubmissionAllowed({
      ALLOW_MONEY_TESTS: allowMoneyTests,
      ALLOW_ADMIN_MUTATION_TESTS: allowAdminMutationTests
    });
  }

  recordClientSubmission(evidence: TransferSubmissionEvidence): void {
    assertTransferSubmissionEvidence(evidence);
    this.guard.recordClientSubmission();
  }

  recordExistingClientSubmission(clientTransferId: string): void {
    if (!clientTransferIdPattern.test(clientTransferId)) {
      throw new Error('Existing Client Transfer does not provide a valid TRF identifier.');
    }
    this.guard.recordClientSubmission();
  }

  recordUniqueAdminCandidate(candidateCount: number): void {
    this.guard.recordUniqueAdminCandidate(candidateCount);
  }

  assertAdminReviewAllowed(): void {
    if (!this.guard.snapshot().uniqueAdminCandidate) {
      throw new Error('Transfer Admin review is blocked until exactly one candidate is validated.');
    }
  }
}
