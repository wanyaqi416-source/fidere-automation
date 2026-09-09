import Decimal from 'decimal.js';

const decimalPattern = /-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/;

export function decimalFromText(text: string, fieldName: string): Decimal {
  const match = text.match(decimalPattern);

  if (!match) {
    throw new Error(`Could not read a decimal value from ${fieldName}.`);
  }

  return new Decimal(match[0].replace(/,/g, ''));
}

export function decimalPlacesFromText(text: string): number {
  const match = text.match(decimalPattern);

  if (!match) {
    throw new Error('Could not determine decimal precision from the displayed amount.');
  }

  return match[0].split('.')[1]?.length ?? 0;
}

export { Decimal };
