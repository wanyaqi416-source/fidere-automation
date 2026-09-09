import { Decimal } from '../utils/money';

// Both formats were observed: US$1,000 in Admin, and -1,000 USD / 400 USDT in Client.
export function parseWealthDisplayAmount(text: string): { amount: string; currency: string; matchedText: string } {
  const match = text.match(/^\s*(?:US\$\s*([+-]?[\d,]+(?:\.\d+)?)|([+-]?[\d,]+(?:\.\d+)?)\s*([A-Z][A-Z0-9_]*)\b)/);
  if (!match) throw new Error('Wealth amount/currency format is not supported by observed page data.');
  return { amount: new Decimal((match[1] ?? match[2]).replace(/,/g, '')).abs().toFixed(),
    currency: match[1] ? 'USD' : match[3], matchedText: match[0] };
}
