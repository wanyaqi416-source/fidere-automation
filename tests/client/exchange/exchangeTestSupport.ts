import { env } from '../../../src/config/env';
import { Decimal, decimalFromText } from '../../../src/utils/money';

export type ExchangeTestConfig = {
  sourceAccountType: string;
  targetAccountType: string;
  fromCurrency: string;
  toCurrency: string;
  testAmount: string;
  dashboardAsset: string;
  dashboardNetwork: string;
};

export type ExchangeQuote = {
  sourceAmount: Decimal;
  receivedAmount: Decimal;
  receivedAmountText: string;
  rate: Decimal;
  feeText: string;
  countdown: string;
};

export type ExchangeReconciliationConfig = ExchangeTestConfig & {
  receivedAmount: string;
  executedFrom: string;
  executedTo: string;
};

const dashboardRows: Record<string, { asset: string; network: string }> = {
  USDT_TRC20: { asset: 'USDT', network: 'Tron' },
  USDT_ERC20: { asset: 'USDT', network: 'ERC20' }
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getExchangeTestConfig(): ExchangeTestConfig {
  const {
    sourceAccountType,
    targetAccountType,
    fromCurrency,
    toCurrency,
    testAmount
  } = env.exchange;
  const missing = [
    ['EXCHANGE_SOURCE_ACCOUNT_TYPE', sourceAccountType],
    ['EXCHANGE_TARGET_ACCOUNT_TYPE', targetAccountType],
    ['EXCHANGE_FROM_CURRENCY', fromCurrency],
    ['EXCHANGE_TO_CURRENCY', toCurrency],
    ['EXCHANGE_TEST_AMOUNT', testAmount]
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    throw new Error(`Missing required Exchange variables: ${missing.map(([name]) => name).join(', ')}`);
  }

  const row = dashboardRows[fromCurrency!];

  if (!row) {
    throw new Error(
      `No Recon-confirmed dashboard row mapping exists for ${fromCurrency}. Add it only after checking the real UI.`
    );
  }

  const amount = new Decimal(testAmount!);

  if (!amount.isFinite() || !amount.isPositive()) {
    throw new Error('EXCHANGE_TEST_AMOUNT must be a positive decimal string.');
  }

  return {
    sourceAccountType: sourceAccountType!,
    targetAccountType: targetAccountType!,
    fromCurrency: fromCurrency!,
    toCurrency: toCurrency!,
    testAmount: testAmount!,
    dashboardAsset: row.asset,
    dashboardNetwork: row.network
  };
}

export function getExchangeReconciliationConfig(): ExchangeReconciliationConfig {
  const config = getExchangeTestConfig();
  const {
    reconciliationReceivedAmount,
    reconciliationExecutedFrom,
    reconciliationExecutedTo
  } = env.exchange;
  const missing = [
    ['EXCHANGE_RECONCILIATION_RECEIVED_AMOUNT', reconciliationReceivedAmount],
    ['EXCHANGE_RECONCILIATION_EXECUTED_FROM', reconciliationExecutedFrom],
    ['EXCHANGE_RECONCILIATION_EXECUTED_TO', reconciliationExecutedTo]
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    throw new Error(
      `Missing required Exchange reconciliation variables: ${missing.map(([name]) => name).join(', ')}`
    );
  }

  const receivedAmount = new Decimal(reconciliationReceivedAmount!);
  const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

  if (!receivedAmount.isFinite() || !receivedAmount.isPositive()) {
    throw new Error('EXCHANGE_RECONCILIATION_RECEIVED_AMOUNT must be a positive decimal string.');
  }

  if (
    !timestampPattern.test(reconciliationExecutedFrom!) ||
    !timestampPattern.test(reconciliationExecutedTo!) ||
    reconciliationExecutedFrom! > reconciliationExecutedTo!
  ) {
    throw new Error(
      'Exchange reconciliation timestamps must use YYYY-MM-DDTHH:mm:ss and define a valid time window.'
    );
  }

  return {
    ...config,
    receivedAmount: receivedAmount.toString(),
    executedFrom: reconciliationExecutedFrom!,
    executedTo: reconciliationExecutedTo!
  };
}

export function parseExchangeBalance(text: string, fieldName: string): Decimal {
  return decimalFromText(text.replace(/^可用余额:\s*/, ''), fieldName);
}

export function parseExchangeQuote(
  confirmationText: string,
  config: ExchangeTestConfig,
  sourceDisplayLabel: string,
  targetDisplayLabel: string
): ExchangeQuote {
  const normalized = confirmationText.replace(/\s+/g, ' ').trim();
  const sourceMatch = normalized.match(
    new RegExp(`${escapeRegExp(sourceDisplayLabel)}\\s*-\\s*([\\d,.]+)`)
  );
  const targetMatch = normalized.match(
    new RegExp(`${escapeRegExp(targetDisplayLabel)}\\s*\\+\\s*([\\d,.]+)`)
  );
  const rateMatch = normalized.match(
    new RegExp(
      `1\\s+${escapeRegExp(config.fromCurrency)}\\s*=\\s*([\\d,.]+)\\s+${escapeRegExp(config.toCurrency)}`
    )
  );
  const feeMatch = normalized.match(/手续费\s*(免费|[\d,.]+\s*[A-Z][A-Z0-9_-]*)/);
  const countdownMatch = normalized.match(/\b\d{2}:\d{2}\b/);

  if (!sourceMatch || !targetMatch || !rateMatch || !feeMatch || !countdownMatch) {
    throw new Error('The confirmation page did not contain the complete Recon-confirmed quote summary.');
  }

  return {
    sourceAmount: new Decimal(sourceMatch[1].replace(/,/g, '')),
    receivedAmount: new Decimal(targetMatch[1].replace(/,/g, '')),
    receivedAmountText: targetMatch[1].replace(/,/g, ''),
    rate: new Decimal(rateMatch[1].replace(/,/g, '')),
    feeText: feeMatch[1],
    countdown: countdownMatch[0]
  };
}
