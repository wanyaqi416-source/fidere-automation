const exchangeBusinessIdPattern = /\bOTC-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/i;
const ledgerTransactionIdPattern = /\bTXN-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/i;
const transferOrderIdPattern = /\bTRF-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/i;
const investmentOrderIdPattern = /\bINV-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/i;
const supportedBusinessIdPattern = /\b(?:OTC|TXN|TRF|INV)-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/i;

export const businessOrderPrefixes = {
  exchange: 'OTC',
  transfer: 'TRF',
  deposit: 'TXN',
  withdrawal: 'TXN',
  investment: 'INV'
} as const;

export function extractExchangeBusinessId(text: string): string | undefined {
  return text.match(exchangeBusinessIdPattern)?.[0];
}

export function extractExchangeBusinessIds(text: string): string[] {
  return [
    ...new Set(text.match(/\bOTC-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/gi) ?? [])
  ];
}

export function extractBusinessId(text: string): string | undefined {
  return text.match(supportedBusinessIdPattern)?.[0];
}

export function extractLedgerTransactionId(text: string): string | undefined {
  return text.match(ledgerTransactionIdPattern)?.[0];
}

export function extractDepositOrderId(text: string): string | undefined {
  return text.match(ledgerTransactionIdPattern)?.[0];
}

export function extractWithdrawalOrderId(text: string): string | undefined {
  return text.match(ledgerTransactionIdPattern)?.[0];
}

export function extractTransferOrderId(text: string): string | undefined {
  return text.match(transferOrderIdPattern)?.[0];
}

export function extractInvestmentOrderId(text: string): string | undefined {
  return text.match(investmentOrderIdPattern)?.[0];
}

export function isExchangeBusinessId(value: string): boolean {
  return exchangeBusinessIdPattern.test(value);
}

export function isLedgerTransactionId(value: string): boolean {
  return ledgerTransactionIdPattern.test(value);
}

export function isTransferOrderId(value: string): boolean {
  return transferOrderIdPattern.test(value);
}

export function isInvestmentOrderId(value: string): boolean {
  return investmentOrderIdPattern.test(value);
}
