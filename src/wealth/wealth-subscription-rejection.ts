import type { AccountBalanceSnapshot } from '../../pages/client/AccountBalanceReader';
import type { WealthHistoryRecord, WealthPosition } from '../../pages/client/FundTradingPage';
import type { WealthJourneyEvidence } from './wealth-journey';
import { Decimal } from '../utils/money';

export const SUBSCRIPTION_REJECTION_STAGES = [
  'INVESTMENT_READY', 'SUBSCRIPTION_SUBMITTED', 'FUNDS_RESERVED_OR_DEDUCTED',
  'ADMIN_SUBSCRIPTION_FOUND', 'ADMIN_REJECTION_ATTEMPTED', 'ADMIN_SUBSCRIPTION_REJECTED',
  'CLIENT_SUBSCRIPTION_REJECTED', 'FUNDS_RESTORED', 'NO_ACTIVE_HOLDING_VERIFIED'
] as const;

export function rejectionFundsRestored(before: AccountBalanceSnapshot, after: AccountBalanceSnapshot): boolean {
  return before.accountType === after.accountType && before.currency === after.currency &&
    (['available', 'frozen', 'total'] as const).every(key => new Decimal(before[key]).eq(after[key]));
}

export function compareRejectedHolding(before: readonly WealthPosition[], after: readonly WealthPosition[], productId: string, currency: string) {
  const summary = (rows: readonly WealthPosition[]) => {
    const product = rows.filter(row => row.productId === productId && row.currency === currency);
    const active = product.filter(row => row.status === '持有中');
    return { principal: product.reduce((sum, row) => sum.plus(row.principal), new Decimal(0)).toFixed(),
      activeCount: active.length, activePrincipal: active.reduce((sum, row) => sum.plus(row.principal), new Decimal(0)).toFixed(),
      statusesKnown: product.every(row => ['持有中', '已赎回', '已到期'].includes(row.status)) };
  };
  const original = summary(before), current = summary(after);
  return { before: original, after: current, passed: original.statusesKnown && current.statusesKnown &&
    new Decimal(original.principal).eq(current.principal) && original.activeCount === current.activeCount &&
    new Decimal(original.activePrincipal).eq(current.activePrincipal) };
}

export function assertOriginalRejectedSubscription(record: WealthHistoryRecord, evidence: WealthJourneyEvidence): void {
  if (record.orderId !== evidence.clientOrder?.orderId || record.productName !== evidence.productName ||
    record.currency !== evidence.currency || !new Decimal(record.amount).eq(evidence.amount!) ||
    record.purchaseAccount !== evidence.purchaseAccount) {
    throw new Error('Original rejected subscription identity/product/amount/currency/purchase account mismatch.');
  }
  if (record.status !== '已拒绝') throw new Error('The original Client subscription has not entered the rejected state.');
  if (record.rejectionReason !== undefined && record.rejectionReason !== evidence.rejectionReason) {
    throw new Error('Client rejection reason does not match this Run\'s Admin reason.');
  }
}
