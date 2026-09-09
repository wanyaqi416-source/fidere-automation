import { Decimal } from '../utils/money';

export function parseU2uAmount(text: string, currency: string, allowFree = false): Decimal {
  if (allowFree && /^(?:免费|free)$/i.test(text.trim())) return new Decimal(0);
  if (!/^[A-Z][A-Z0-9_]*$/.test(currency)) throw new Error('Unsupported currency format.');
  const numeric = text.replace(currency, '').replace(/[\s,]/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(numeric)) throw new Error('U2U amount cannot be read from the actual summary.');
  return new Decimal(numeric);
}

export function verifyU2uSummary(input: {
  currency: string;
  requestedAmount: string;
  displayedAmount: string;
  displayedFee: string;
  displayedCredit: string;
  feeDeductedFromAmount: boolean;
}) {
  if (!input.feeDeductedFromAmount) throw new Error('U2U fee rule changed; reconfirm before money submission.');
  const amount = parseU2uAmount(input.displayedAmount, input.currency);
  const fee = parseU2uAmount(input.displayedFee, input.currency, true);
  const credit = parseU2uAmount(input.displayedCredit, input.currency);
  if (!amount.eq(input.requestedAmount)) throw new Error('U2U summary amount differs from the configured input.');
  const transferable = amount.gt(fee) && credit.eq(amount.minus(fee));
  return { amount: amount.toFixed(), fee: fee.toFixed(), expectedCredit: credit.toFixed(), transferable };
}

export function formatU2uBalance(value: string): string {
  // Group the Decimal string without converting large Sandbox balances to Number.
  const [whole, fractional] = new Decimal(value).toFixed().split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fractional ? `${grouped}.${fractional}` : grouped;
}
