import { env } from '../../../src/config/env';

export type WithdrawalTestConfig = {
  accountType: string;
  currency: string;
  currencyLabel: string;
  beneficiaryName: string;
  beneficiaryAccountSuffix: string;
  purpose: string;
  transferMethod: string;
  supportingDocumentPath: string;
  testAmount: string;
  uniqueAmountBase: string;
  amountPrecision: number;
  matchWindowMs: number;
  adminUserIdentity: string;
};

export type WithdrawalApprovalConfig = {
  paymentChannel: string;
  paymentBank: string;
  approvalNotePrefix: string;
};

export type WithdrawalApprovalDryRunFixture = {
  accountType: string;
  currency: string;
  requestedAmount: string;
  beneficiary: string;
  purpose: string;
  submittedAtMs: number;
  userIdentity: string;
  matchWindowMs: number;
};

export type WithdrawalReconciliationConfig = {
  accountType: string;
  currency: string;
  requestedAmount: string;
  beneficiaryName: string;
  beneficiaryAccountSuffix: string;
  clientStatus: string;
  adminStatus: string;
  submittedAtMs: number;
};

function required(name: string, value: string | undefined): string {
  if (!value?.trim()) throw new Error(`${name} is required for Withdrawal tests.`);
  return value.trim();
}

export function getWithdrawalTestConfig(): WithdrawalTestConfig {
  return {
    accountType: required('WITHDRAWAL_ACCOUNT_TYPE', env.withdrawal.accountType),
    currency: required('WITHDRAWAL_CURRENCY', env.withdrawal.currency),
    currencyLabel: required('WITHDRAWAL_CURRENCY_LABEL', env.withdrawal.currencyLabel),
    beneficiaryName: required('WITHDRAWAL_BENEFICIARY_NAME', env.withdrawal.beneficiaryName),
    beneficiaryAccountSuffix: required(
      'WITHDRAWAL_BENEFICIARY_ACCOUNT_SUFFIX',
      env.withdrawal.beneficiaryAccountSuffix
    ),
    purpose: required('WITHDRAWAL_PURPOSE', env.withdrawal.purpose),
    transferMethod: required(
      'WITHDRAWAL_TRANSFER_METHOD',
      env.withdrawal.transferMethod
    ),
    supportingDocumentPath: env.withdrawal.supportingDocumentPath,
    testAmount: required('WITHDRAWAL_TEST_AMOUNT', env.withdrawal.testAmount),
    uniqueAmountBase: required(
      'WITHDRAWAL_UNIQUE_AMOUNT_BASE',
      env.withdrawal.uniqueAmountBase
    ),
    amountPrecision: env.withdrawal.amountPrecision,
    matchWindowMs: env.withdrawal.matchWindowMs,
    adminUserIdentity: required(
      'WITHDRAWAL_ADMIN_USER_IDENTITY or DEPOSIT_ADMIN_USER_IDENTITY',
      env.withdrawal.adminUserIdentity
    )
  };
}

export function getWithdrawalApprovalConfig(): WithdrawalApprovalConfig {
  return {
    paymentChannel: required(
      'WITHDRAWAL_PAYMENT_CHANNEL',
      env.withdrawal.paymentChannel
    ),
    paymentBank: required('WITHDRAWAL_PAYMENT_BANK', env.withdrawal.paymentBank),
    approvalNotePrefix: required(
      'WITHDRAWAL_APPROVAL_NOTE',
      env.withdrawal.approvalNote
    )
  };
}

export function getWithdrawalApprovalDryRunFixture(): WithdrawalApprovalDryRunFixture {
  const submittedAt = required(
    'WITHDRAWAL_APPROVAL_DRY_RUN_SUBMITTED_AT',
    env.withdrawal.approvalDryRunSubmittedAt
  );
  const submittedAtMs = Date.parse(submittedAt);
  if (!Number.isFinite(submittedAtMs)) {
    throw new Error('WITHDRAWAL_APPROVAL_DRY_RUN_SUBMITTED_AT must be an ISO timestamp.');
  }
  return {
    accountType: required(
      'WITHDRAWAL_APPROVAL_DRY_RUN_ACCOUNT_TYPE',
      env.withdrawal.approvalDryRunAccountType
    ),
    currency: required(
      'WITHDRAWAL_APPROVAL_DRY_RUN_CURRENCY',
      env.withdrawal.approvalDryRunCurrency
    ),
    requestedAmount: required(
      'WITHDRAWAL_APPROVAL_DRY_RUN_AMOUNT',
      env.withdrawal.approvalDryRunAmount
    ),
    beneficiary: required(
      'WITHDRAWAL_APPROVAL_DRY_RUN_BENEFICIARY',
      env.withdrawal.approvalDryRunBeneficiary
    ),
    purpose: required(
      'WITHDRAWAL_APPROVAL_DRY_RUN_PURPOSE',
      env.withdrawal.approvalDryRunPurpose
    ),
    submittedAtMs,
    userIdentity: required(
      'WITHDRAWAL_ADMIN_USER_IDENTITY or CLIENT_USERNAME',
      env.withdrawal.adminUserIdentity
    ),
    matchWindowMs: env.withdrawal.matchWindowMs
  };
}

export function getWithdrawalReconciliationConfig(): WithdrawalReconciliationConfig {
  const submittedAt = required(
    'WITHDRAWAL_RECONCILIATION_SUBMITTED_AT',
    env.withdrawal.reconciliationSubmittedAt
  );
  const submittedAtMs = Date.parse(submittedAt);
  if (!Number.isFinite(submittedAtMs)) {
    throw new Error('WITHDRAWAL_RECONCILIATION_SUBMITTED_AT must be an ISO timestamp.');
  }
  return {
    accountType: required(
      'WITHDRAWAL_RECONCILIATION_ACCOUNT_TYPE',
      env.withdrawal.reconciliationAccountType
    ),
    currency: required(
      'WITHDRAWAL_RECONCILIATION_CURRENCY',
      env.withdrawal.reconciliationCurrency
    ),
    requestedAmount: required(
      'WITHDRAWAL_RECONCILIATION_AMOUNT',
      env.withdrawal.reconciliationAmount
    ),
    beneficiaryName: required(
      'WITHDRAWAL_RECONCILIATION_BENEFICIARY_NAME',
      env.withdrawal.reconciliationBeneficiaryName
    ),
    beneficiaryAccountSuffix: required(
      'WITHDRAWAL_RECONCILIATION_BENEFICIARY_SUFFIX',
      env.withdrawal.reconciliationBeneficiarySuffix
    ),
    clientStatus: required(
      'WITHDRAWAL_RECONCILIATION_CLIENT_STATUS',
      env.withdrawal.reconciliationClientStatus
    ),
    adminStatus: required(
      'WITHDRAWAL_RECONCILIATION_ADMIN_STATUS',
      env.withdrawal.reconciliationAdminStatus
    ),
    submittedAtMs
  };
}
