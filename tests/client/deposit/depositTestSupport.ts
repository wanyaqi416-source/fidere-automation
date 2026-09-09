import { env } from '../../../src/config/env';
import { Decimal } from '../../../src/utils/money';

export type DepositTestConfig = {
  accountType: string;
  currency: string;
  currencyLabel: string;
  testAmount: string;
  uniqueAmountBase: string;
  amountPrecision: number;
  matchWindowMs: number;
  adminUserIdentity: string;
  channel: string;
  purpose: string;
  sourceOfFunds: string;
  transferMethod: string;
  supportingDocumentPath: string;
};

export type DepositReconciliationConfig = {
  accountType: string;
  currency: string;
  currencyLabel: string;
  amount: string;
  clientStatus: string;
  adminStatus: string;
  submittedAtMs: number;
};

export function getDepositTestConfig(): DepositTestConfig {
  const config = env.deposit;
  const required = [
    ['DEPOSIT_ACCOUNT_TYPE', config.accountType],
    ['DEPOSIT_CURRENCY', config.currency],
    ['DEPOSIT_CURRENCY_LABEL', config.currencyLabel],
    ['DEPOSIT_TEST_AMOUNT', config.testAmount],
    ['DEPOSIT_UNIQUE_AMOUNT_BASE', config.uniqueAmountBase],
    ['DEPOSIT_CHANNEL', config.channel],
    ['DEPOSIT_PURPOSE', config.purpose],
    ['DEPOSIT_SOURCE_OF_FUNDS', config.sourceOfFunds]
  ] as const;
  const missing = required.filter(([, value]) => !value);
  if (missing.length > 0) {
    throw new Error(
      `Missing required Deposit variables: ${missing.map(([name]) => name).join(', ')}`
    );
  }

  const amount = new Decimal(config.testAmount!);
  if (!amount.isFinite() || !amount.isPositive()) {
    throw new Error('DEPOSIT_TEST_AMOUNT must be a positive decimal string.');
  }

  const adminUserIdentity = config.adminUserIdentity ?? env.client.username;
  if (!adminUserIdentity) {
    throw new Error(
      'DEPOSIT_ADMIN_USER_IDENTITY or CLIENT_USERNAME is required for Admin matching.'
    );
  }

  return {
    accountType: config.accountType!,
    currency: config.currency!.toUpperCase(),
    currencyLabel: config.currencyLabel!,
    testAmount: amount.toString(),
    uniqueAmountBase: config.uniqueAmountBase!,
    amountPrecision: config.amountPrecision,
    matchWindowMs: config.matchWindowMs,
    adminUserIdentity,
    channel: config.channel!,
    purpose: config.purpose!,
    sourceOfFunds: config.sourceOfFunds!,
    transferMethod: config.transferMethod,
    supportingDocumentPath: config.supportingDocumentPath
  };
}

export function getDepositReconciliationConfig(): DepositReconciliationConfig {
  const config = env.deposit;
  const required = [
    ['DEPOSIT_RECONCILIATION_ACCOUNT_TYPE', config.reconciliationAccountType],
    ['DEPOSIT_RECONCILIATION_CURRENCY', config.reconciliationCurrency],
    ['DEPOSIT_RECONCILIATION_CURRENCY_LABEL', config.reconciliationCurrencyLabel],
    ['DEPOSIT_RECONCILIATION_AMOUNT', config.reconciliationAmount],
    ['DEPOSIT_RECONCILIATION_CLIENT_STATUS', config.reconciliationClientStatus],
    ['DEPOSIT_RECONCILIATION_ADMIN_STATUS', config.reconciliationAdminStatus],
    ['DEPOSIT_RECONCILIATION_SUBMITTED_AT', config.reconciliationSubmittedAt]
  ] as const;
  const missing = required.filter(([, value]) => !value);
  if (missing.length > 0) {
    throw new Error(
      `Missing Deposit reconciliation variables: ${missing.map(([name]) => name).join(', ')}`
    );
  }

  const timestamp = Date.parse(config.reconciliationSubmittedAt!);
  if (!Number.isFinite(timestamp)) {
    throw new Error('DEPOSIT_RECONCILIATION_SUBMITTED_AT must be an ISO timestamp.');
  }

  return {
    accountType: config.reconciliationAccountType!,
    currency: config.reconciliationCurrency!.toUpperCase(),
    currencyLabel: config.reconciliationCurrencyLabel!,
    amount: new Decimal(config.reconciliationAmount!).toString(),
    clientStatus: config.reconciliationClientStatus!,
    adminStatus: config.reconciliationAdminStatus!,
    submittedAtMs: timestamp
  };
}
