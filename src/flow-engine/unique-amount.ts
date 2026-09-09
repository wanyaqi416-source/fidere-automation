import { createHash } from 'node:crypto';

import { Decimal } from '../utils/money';

export type UniqueAmountOptions = {
  minimumPrecision?: number;
  maximumPrecision?: number;
};

export function deriveReproducibleMoneyAmount(
  runId: string,
  baseAmount: string,
  precision: number,
  options: UniqueAmountOptions = {}
): Decimal {
  const minimumPrecision = options.minimumPrecision ?? 0;
  const maximumPrecision = options.maximumPrecision ?? 8;

  if (!runId.trim()) {
    throw new Error('runId is required to derive a reproducible money amount.');
  }
  if (
    !Number.isInteger(precision) ||
    precision < minimumPrecision ||
    precision > maximumPrecision
  ) {
    throw new Error(
      `Amount precision must be an integer between ${minimumPrecision} and ${maximumPrecision}.`
    );
  }

  const base = new Decimal(baseAmount);
  if (!base.isFinite() || !base.isPositive() || !base.isInteger()) {
    throw new Error('Unique amount base must be a positive integer string.');
  }
  if (precision === 0) return base;

  const scale = new Decimal(10).pow(precision);
  const fractionalRange = scale.minus(1).toNumber();
  const fractionalUnits =
    (createHash('sha256').update(runId).digest().readUInt32BE(0) % fractionalRange) + 1;
  return base.plus(new Decimal(fractionalUnits).div(scale));
}

