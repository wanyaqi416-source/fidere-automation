import { Decimal } from '../utils/money';
import { calculateExactTransferFee, transferFeeRule, type TransferFeeCurrency, type TransferFeeRule } from './account-transfer-fee';

export type TransferFeeMatrixRow = {
  currency: TransferFeeCurrency; rule: TransferFeeRule; internalAmount: string; userAmount: string;
};

export const TRANSFER_FEE_MATRIX: readonly TransferFeeMatrixRow[] = [
  { currency: 'HKD', rule: transferFeeRule('HKD', 'fixed', '200'), internalAmount: '211.13', userAmount: '212.17' },
  { currency: 'USD', rule: transferFeeRule('USD', 'percent', '5'), internalAmount: '20.20', userAmount: '20.40' },
  { currency: 'SGD', rule: transferFeeRule('SGD', 'none', '0'), internalAmount: '11.17', userAmount: '11.19' }
];

// Explicit funded-account alternative; never fund or exchange merely to satisfy the currency matrix.
export const TRANSFER_FEE_USD_MATRIX: readonly TransferFeeMatrixRow[] = [
  { currency: 'USD', rule: transferFeeRule('USD', 'fixed', '0.37'), internalAmount: '11.20', userAmount: '11.40' },
  { currency: 'USD', rule: transferFeeRule('USD', 'percent', '5'), internalAmount: '20.20', userAmount: '20.40' },
  { currency: 'USD', rule: transferFeeRule('USD', 'none', '0'), internalAmount: '11.60', userAmount: '11.80' }
];

export type FeeMatrixPlan = ReturnType<typeof describeTransferFeeMatrixRow>[number];
export function fundedUsdMatrix() {
  return TRANSFER_FEE_USD_MATRIX.flatMap(planRow);
}

export function describeTransferFeeMatrixRow(row: TransferFeeMatrixRow, available: string) {
  if (row.rule.currency !== row.currency) throw new Error('Matrix currency and fee currency differ.');
  const combinedDebit = new Decimal(row.internalAmount).plus(row.userAmount);
  if (!combinedDebit.lt(available)) throw new Error('BLOCKED_TEST_DATA: existing available balance must cover both transfers and leave funds.');
  return planRow(row);
}

function planRow(row: TransferFeeMatrixRow) {
  return (['internal', 'p2p'] as const).map(kind => {
    const amount = kind === 'internal' ? row.internalAmount : row.userAmount;
    const fee = calculateExactTransferFee(row.rule, amount);
    return { kind, currency: row.currency, amount, fee, expectedCredit: new Decimal(amount).minus(fee).toFixed(2),
      feeType: row.rule.type, feeValue: row.rule.value };
  });
}
