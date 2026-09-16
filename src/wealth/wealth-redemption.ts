import type { AccountBalanceSnapshot } from '../../pages/client/AccountBalanceReader';
import type { RedeemableWealthPosition, WealthPosition } from '../../pages/client/FundTradingPage';
import { Decimal } from '../utils/money';

export function chooseUniqueRedeemablePosition(
  positions: readonly RedeemableWealthPosition[]
): RedeemableWealthPosition {
  if (positions.length === 0) {
    throw new Error('PRECONDITION_NOT_MET: 当前测试用户没有可赎回理财产品，请更换测试账号。');
  }
  if (positions.length !== 1) {
    const candidates = positions.map(position =>
      `${position.holdingId}/${position.productName}/${position.currency}/${position.principal}/${position.status}`
    ).join('; ');
    throw new Error(`PRECONDITION_NOT_MET: 可赎回持仓无法唯一确定，candidateCount=${positions.length}；候选：${candidates}`);
  }
  return positions[0];
}

export function redeemedPrincipalDelta(
  before: readonly WealthPosition[],
  after: readonly WealthPosition[],
  productId: string,
  currency: string
): string {
  const total = (rows: readonly WealthPosition[]) => rows
    .filter(row => row.productId === productId && row.currency === currency && ['持有中', '已到期'].includes(row.status))
    .reduce((sum, row) => sum.plus(row.principal), new Decimal(0));
  return total(before).minus(total(after)).toFixed();
}

export function verifyRedemptionSettlement(
  before: AccountBalanceSnapshot,
  after: AccountBalanceSnapshot,
  expectedSettlementAmount: string
) {
  const actualCredit = new Decimal(after.available).minus(before.available);
  return {
    expectedSettlementAmount: new Decimal(expectedSettlementAmount).toFixed(),
    actualCredit: actualCredit.toFixed(),
    passed: actualCredit.eq(expectedSettlementAmount)
  };
}
