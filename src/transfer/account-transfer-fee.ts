import { Decimal } from '../utils/money';
import type { FeeRunEvidence, InternalTransferRecord } from './account-transfer-fee-run';
import type { AdminTransferDetail } from '../../pages/admin/TransferDetailPage';

export const INTERNAL_ACCOUNT_REGIONS: Readonly<Record<string, string>> = { '香港账户': 'HK', '新加坡账户': 'SG' };

export type FixedTransferFee = { type: 'fixed'; currency: 'USD'; amount: string };
export const TRANSFER_FEE_LABELS = { none: '免手续费', fixed: '固定手续费', percent: '百分比' } as const;
export type TransferFeeType = keyof typeof TRANSFER_FEE_LABELS;
export const TRANSFER_FEE_CURRENCY_NAMES = { HKD: '港币', SGD: '新币', CNY: '人民币', JPY: '日元',
  AED: '阿联酋迪拉姆', USD: '美元', EUR: '欧元', GBP: '英镑' } as const;
export type TransferFeeCurrency = keyof typeof TRANSFER_FEE_CURRENCY_NAMES;
export type TransferFeeRule = { type: TransferFeeType; currency: TransferFeeCurrency; value: string };

export function usdTransferFeeRule(type: string, value: string): TransferFeeRule {
  return transferFeeRule('USD', type, value);
}

export function transferFeeRule(currency: string, type: string, value: string): TransferFeeRule {
  if (!Object.hasOwn(TRANSFER_FEE_CURRENCY_NAMES, currency)) throw new Error('Unsupported account transfer fee currency.');
  if (!Object.hasOwn(TRANSFER_FEE_LABELS, type)) throw new Error('UNSUPPORTED_FEE_TYPE');
  const normalized = fixedUsdFee(value).amount;
  if (type === 'none' && !new Decimal(normalized).isZero()) throw new Error('No-fee mode must be zero.');
  if (type === 'percent' && new Decimal(normalized).gt(100)) throw new Error('Percentage must be between 0 and 100.');
  return { type: type as TransferFeeType, currency: currency as TransferFeeCurrency, value: normalized };
}

export function calculateExactTransferFee(rule: TransferFeeRule, amount: string): string {
  const valid = transferFeeRule(rule.currency, rule.type, rule.value), requested = new Decimal(fixedUsdFee(amount).amount);
  if (!requested.gt(0)) throw new Error('A positive transfer amount is required.');
  const fee = valid.type === 'none' ? new Decimal(0) : valid.type === 'percent' ? requested.mul(valid.value).div(100) : new Decimal(valid.value);
  // Rounding is not yet product-verified; exact-cent examples must not silently invent that policy.
  if (fee.decimalPlaces() > 2) throw new Error('PERCENT_ROUNDING_RULE_UNCONFIRMED');
  if (fee.gte(requested)) throw new Error('Transfer amount must exceed its fee.');
  return fee.toFixed(2);
}

export function snapshotUsdFeeRule(snapshot: AccountTypeFeeSnapshot): TransferFeeRule {
  return snapshotFeeRule(snapshot, 'USD');
}

export function snapshotFeeRule(snapshot: AccountTypeFeeSnapshot, currency: TransferFeeCurrency): TransferFeeRule {
  const value = snapshot.currencies[currency];
  if (!value) throw new Error('Currency configuration is required.');
  return transferFeeRule(currency, value.feeType ?? 'fixed', value.fee);
}

export function verifyTransferFeeQuote(quote: AccountTransferQuote, rule: TransferFeeRule,
  expected: { sourceAccount: string; targetAccount: string; amount: string }): void {
  const fee = calculateExactTransferFee(rule, expected.amount);
  if (quote.currency !== rule.currency || quote.sourceAccount !== expected.sourceAccount || quote.targetAccount !== expected.targetAccount ||
    !new Decimal(quote.amount).eq(expected.amount) || !new Decimal(quote.fee).eq(fee) ||
    !new Decimal(quote.received).eq(new Decimal(expected.amount).minus(fee))) {
    throw new Error('Transfer fee quote differs from the configured currency/type/value, direction, amount or net.');
  }
}
export type AccountTransferQuote = {
  sourceAccount: string; targetAccount: string; currency: string;
  amount: string; fee: string; received: string;
};
export type AccountTransferSettlement = AccountTransferQuote & {
  orderNo: string; txNo: string; adminStatus: string; verifiedAt: string;
  receivedSource: 'Admin 实际到账金额';
};

export function verifyCompletedAccountTransfer(record: InternalTransferRecord, e: FeeRunEvidence,
  detail: AdminTransferDetail, userMatches: boolean): AccountTransferSettlement {
  if (!userMatches || !e.order || e.order.orderNo !== record.orderNo || !record.txNo || detail.adminTransactionId !== record.txNo ||
    record.transferType !== 'internal' || record.fromRegion !== 'BH' || record.toRegion !== INTERNAL_ACCOUNT_REGIONS[e.targetAccount] ||
    record.status !== 'approved' || detail.status !== '已批准' || detail.recordType !== '信托账户互转' ||
    record.currency !== 'USD' || !new Decimal(record.amount).eq(e.amount) || !new Decimal(record.fee).eq(e.fixedFee)) {
    throw new Error('Original completed internal transfer, identity, TXN, direction, amount or fee does not match.');
  }
  const preview = e.quotes?.find(q => new Decimal(q.amount).eq(e.amount));
  if (!preview || detail.fee === undefined || detail.receivedAmount === undefined) throw new Error('Original preview and labelled Admin fee/net amount are required.');
  const expected = { sourceAccount: '巴林账户', targetAccount: e.targetAccount, amount: e.amount };
  verifyFixedTransferQuote(preview, fixedUsdFee(e.fixedFee), expected);
  const settlement: AccountTransferSettlement = { sourceAccount: detail.sourceAccountType, targetAccount: detail.targetAccountType,
    currency: detail.currency, amount: detail.amount, fee: detail.fee, received: detail.receivedAmount,
    orderNo: record.orderNo, txNo: record.txNo, adminStatus: detail.status, verifiedAt: new Date().toISOString(), receivedSource: 'Admin 实际到账金额' };
  // /api/transfer/records.actualAmount is not the labelled net amount; keep it as raw diagnostic data only.
  verifyFixedTransferQuote(settlement, fixedUsdFee(e.fixedFee), expected);
  return settlement;
}
export type AccountTypeFeeSnapshot = {
  accountType: string; code: string;
  fields: Record<string, string>;
  // Snapshots saved before the fee-type dropdown contain only fixed fees.
  currencies: Record<string, { enabled: boolean; fee: string; feeType?: TransferFeeType }>;
};

export function fixedUsdFee(value: string, type = 'fixed'): FixedTransferFee {
  if (type !== 'fixed') throw new Error('UNSUPPORTED_FEE_TYPE: percentage fees are not implemented.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(value) || !new Decimal(value).isFinite()) {
    throw new Error('Fixed USD fee requires a nonnegative amount with at most two decimals.');
  }
  return { type: 'fixed', currency: 'USD', amount: new Decimal(value).toFixed(2) };
}

export function parseUsdDisplay(value: string): string {
  return parseTransferCurrencyDisplay(value, 'USD');
}

export function parseTransferCurrencyDisplay(value: string, currency: string): string {
  if (!Object.hasOwn(TRANSFER_FEE_CURRENCY_NAMES, currency)) throw new Error('Unsupported transfer currency.');
  const match = value.trim().match(new RegExp(`^${currency}\\s+((?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?)$`));
  if (!match) throw new Error('A complete currency-labelled amount is required; never treat missing or other currencies as zero.');
  return new Decimal(match[1].replace(/,/g, '')).toFixed(2);
}

export function verifyFixedTransferQuote(quote: AccountTransferQuote, fee: FixedTransferFee,
  expected: { sourceAccount: string; targetAccount: string; amount: string }): void {
  fixedUsdFee(fee.amount, fee.type);
  if (fee.currency !== 'USD' || quote.currency !== fee.currency || quote.sourceAccount !== expected.sourceAccount ||
    quote.targetAccount !== expected.targetAccount || expected.sourceAccount === expected.targetAccount) {
    throw new Error('Transfer quote account direction/currency mismatch.');
  }
  const requested = new Decimal(fixedUsdFee(expected.amount).amount);
  if (!requested.gt(fee.amount)) throw new Error('Transfer amount must exceed the fixed fee.');
  if (!new Decimal(quote.amount).eq(requested) || !new Decimal(quote.fee).eq(fee.amount) ||
    !new Decimal(quote.received).eq(requested.minus(fee.amount))) {
    throw new Error('Fixed transfer quote mismatch: amount, configured fee and amount-minus-fee must agree exactly.');
  }
}

export function withUsdTransferFee(snapshot: AccountTypeFeeSnapshot, fee: string): AccountTypeFeeSnapshot {
  return withUsdTransferFeeRule(snapshot, usdTransferFeeRule('fixed', fee));
}

export function withUsdTransferFeeRule(snapshot: AccountTypeFeeSnapshot, rule: TransferFeeRule): AccountTypeFeeSnapshot {
  if (rule.currency !== 'USD') throw new Error('Only USD may change.');
  return withTransferFeeRule(snapshot, rule);
}

export function withTransferFeeRule(snapshot: AccountTypeFeeSnapshot, rule: TransferFeeRule): AccountTypeFeeSnapshot {
  const valid = transferFeeRule(rule.currency, rule.type, rule.value);
  if (snapshot.accountType !== '巴林账户' || snapshot.code !== 'BH' || !snapshot.currencies[valid.currency]?.enabled) {
    throw new Error('Only an enabled Bahrain currency transfer fee may be changed.');
  }
  return { ...snapshot, currencies: { ...snapshot.currencies, [valid.currency]: { enabled: true, fee: valid.value, feeType: valid.type } } };
}

export function sameAccountTypeConfiguration(a: AccountTypeFeeSnapshot, b: AccountTypeFeeSnapshot): boolean {
  const canonical = (value: unknown): string => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, canonical(val)]));
    }
    return JSON.stringify(value);
  };
  const normalize = (snapshot: AccountTypeFeeSnapshot) => ({ ...snapshot, currencies: Object.fromEntries(
    Object.entries(snapshot.currencies).map(([code, value]) => [code, { ...value, feeType: value.feeType ?? 'fixed' }])) });
  return canonical(normalize(a)) === canonical(normalize(b));
}

export function matchFeeRunTransfers(records: readonly InternalTransferRecord[], e: FeeRunEvidence, runId: string) {
  if (!e.submittedAt || !e.originalOrderIds || !INTERNAL_ACCOUNT_REGIONS[e.targetAccount]) {
    throw new Error('Original transfer submission context is required; never create a replacement.');
  }
  const submittedAt = Date.parse(e.submittedAt);
  return records.filter(row => !e.originalOrderIds!.includes(row.orderNo) && row.transferType === 'internal' &&
    row.fromRegion === 'BH' && row.toRegion === INTERNAL_ACCOUNT_REGIONS[e.targetAccount] && row.currency === 'USD' &&
    new Decimal(row.amount).eq(e.amount) && row.remark === `AUTO_TRANSFER_FEE_${runId}` &&
    row.appliedAt >= submittedAt - 300_000 && row.appliedAt <= submittedAt + 300_000);
}
