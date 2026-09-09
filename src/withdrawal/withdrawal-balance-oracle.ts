import { Decimal } from '../utils/money';

export function withdrawalDebitFromSettlement(requested: Decimal, fee: Decimal, net: Decimal): {
  debit: Decimal;
  rule: 'FEE_ADDED' | 'FEE_INCLUDED';
} {
  if (!requested.isFinite() || !requested.isPositive() || !fee.isFinite() || fee.isNegative() || !net.isFinite() || net.isNegative()) {
    throw new Error('Withdrawal settlement amounts must be finite and non-negative.');
  }
  // Use the order's requested/fee/net relationship, never infer fees from the observed balance.
  if (net.equals(requested)) return { debit: requested.plus(fee), rule: 'FEE_ADDED' };
  if (net.plus(fee).equals(requested)) return { debit: requested, rule: 'FEE_INCLUDED' };
  throw new Error('Withdrawal requested amount, fee and net do not establish a supported debit rule.');
}
