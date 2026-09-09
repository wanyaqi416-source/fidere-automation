import { env } from '../../../src/config/env';
import { Decimal, decimalFromText } from '../../../src/utils/money';

export type TransferTestConfig = {
  brokerAccountId: string;
  brokerName: string;
  sourceAccountType: string;
  targetAccountType: string;
  currency: string;
  testAmount: string;
  uniqueAmountBase: string;
  amountPrecision: number;
  matchWindowMs: number;
  adminUserIdentity: string;
  purpose: string;
};

export type TransferDryRunConfig = {
  direction: string;
  amount: string;
  clientStatus: string;
  adminStatus: string;
};

export type TransferReconciliationConfig = {
  recordType: string;
  sourceAccount: string;
  targetAccount: string;
  currency: string;
  requestedAmount: string;
  feeAmount: string;
  netAmount: string;
  status: string;
  sourceBalanceBefore: string;
};

export function getTransferTestConfig(): TransferTestConfig {
  const config = env.transfer;
  const required = [
    ['TRANSFER_BROKER_ACCOUNT_ID', config.brokerAccountId],
    ['TRANSFER_BROKER_NAME', config.brokerName],
    ['TRANSFER_SOURCE_ACCOUNT_TYPE', config.sourceAccountType],
    ['TRANSFER_TARGET_ACCOUNT_TYPE', config.targetAccountType],
    ['TRANSFER_CURRENCY', config.currency],
    ['TRANSFER_TEST_AMOUNT', config.testAmount],
    ['TRANSFER_UNIQUE_AMOUNT_BASE', config.uniqueAmountBase],
    ['TRANSFER_PURPOSE', config.purpose]
  ] as const;
  const missing = required.filter(([, value]) => !value);

  if (missing.length > 0) {
    throw new Error(
      `Missing required Transfer variables: ${missing.map(([name]) => name).join(', ')}`
    );
  }

  const testAmount = new Decimal(config.testAmount!);
  const adminUserIdentity = config.adminUserIdentity ?? env.client.username;
  if (!testAmount.isFinite() || !testAmount.isPositive()) {
    throw new Error('TRANSFER_TEST_AMOUNT must be a positive decimal string.');
  }
  if (!adminUserIdentity) {
    throw new Error(
      'TRANSFER_ADMIN_USER_IDENTITY or CLIENT_USERNAME is required for Admin Transfer fingerprint matching.'
    );
  }

  return {
    brokerAccountId: config.brokerAccountId!,
    brokerName: config.brokerName!,
    sourceAccountType: config.sourceAccountType!,
    targetAccountType: config.targetAccountType!,
    currency: config.currency!,
    testAmount: testAmount.toString(),
    uniqueAmountBase: config.uniqueAmountBase!,
    amountPrecision: config.amountPrecision,
    matchWindowMs: config.matchWindowMs,
    adminUserIdentity,
    purpose: config.purpose!
  };
}

export function parseTransferAmount(text: string, fieldName: string): Decimal {
  return decimalFromText(text, fieldName);
}

export function getTransferDryRunConfig(): TransferDryRunConfig {
  const config = env.transfer;
  const required = [
    ['TRANSFER_DRY_RUN_DIRECTION', config.dryRunDirection],
    ['TRANSFER_DRY_RUN_AMOUNT', config.dryRunAmount],
    ['TRANSFER_DRY_RUN_CLIENT_STATUS', config.dryRunClientStatus],
    ['TRANSFER_DRY_RUN_ADMIN_STATUS', config.dryRunAdminStatus]
  ] as const;
  const missing = required.filter(([, value]) => !value);
  if (missing.length > 0) {
    throw new Error(
      `Missing required Transfer Dry Run variables: ${missing.map(([name]) => name).join(', ')}`
    );
  }

  return {
    direction: config.dryRunDirection!,
    amount: new Decimal(config.dryRunAmount!).toString(),
    clientStatus: config.dryRunClientStatus!,
    adminStatus: config.dryRunAdminStatus!
  };
}

export function getTransferReconciliationConfig(): TransferReconciliationConfig {
  const config = env.transfer;
  const required = [
    ['TRANSFER_RECONCILIATION_RECORD_TYPE', config.reconciliationRecordType],
    ['TRANSFER_RECONCILIATION_SOURCE_ACCOUNT', config.reconciliationSourceAccount],
    ['TRANSFER_RECONCILIATION_TARGET_ACCOUNT', config.reconciliationTargetAccount],
    ['TRANSFER_RECONCILIATION_CURRENCY', config.reconciliationCurrency],
    ['TRANSFER_RECONCILIATION_AMOUNT', config.reconciliationAmount],
    ['TRANSFER_RECONCILIATION_FEE', config.reconciliationFee],
    ['TRANSFER_RECONCILIATION_NET_AMOUNT', config.reconciliationNetAmount],
    ['TRANSFER_RECONCILIATION_STATUS', config.reconciliationStatus],
    [
      'TRANSFER_RECONCILIATION_SOURCE_BALANCE_BEFORE',
      config.reconciliationSourceBalanceBefore
    ]
  ] as const;
  const missing = required.filter(([, value]) => !value);
  if (missing.length > 0) {
    throw new Error(
      `Missing required Transfer reconciliation variables: ${missing.map(([name]) => name).join(', ')}`
    );
  }

  return {
    recordType: config.reconciliationRecordType!,
    sourceAccount: config.reconciliationSourceAccount!,
    targetAccount: config.reconciliationTargetAccount!,
    currency: config.reconciliationCurrency!.toUpperCase(),
    requestedAmount: new Decimal(config.reconciliationAmount!).toString(),
    feeAmount: new Decimal(config.reconciliationFee!).toString(),
    netAmount: new Decimal(config.reconciliationNetAmount!).toString(),
    status: config.reconciliationStatus!,
    sourceBalanceBefore: new Decimal(config.reconciliationSourceBalanceBefore!).toString()
  };
}
