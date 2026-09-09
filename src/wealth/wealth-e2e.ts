import { Decimal } from '../utils/money';
import {
  createPreparedFlowState,
  matchCandidatesByStages,
  matchesConfiguredCustomerIdentity,
  type FlowResumeState
} from '../flow-engine';

export const wealthOrderIdPattern = /^INV-[A-Z0-9-]+$/i;

export const WEALTH_CASES = {
  subscribeValidation: 'WS-001',
  subscribeReject: 'WS-002',
  subscribeApprove: 'WS-003',
  redeemValidation: 'WR-001',
  redeemReject: 'WR-002',
  redeemApprove: 'WR-003'
} as const;

export type WealthOrderKind = 'subscription' | 'redemption';

export type WealthOrderCandidate = {
  orderId: string;
  kind: WealthOrderKind;
  customerText: string;
  productName: string;
  currency: string;
  amount: string;
  status: string;
  createdAtMs?: number;
};

export type WealthOrderFingerprint = {
  orderId: string;
  kind: WealthOrderKind;
  customerIdentity: string;
  productName: string;
  currency: string;
  amount: string;
  status: string;
  submittedAtMs?: number;
  matchWindowMs?: number;
};

export function diagnoseWealthOrderCandidates(
  records: readonly WealthOrderCandidate[],
  fingerprint: WealthOrderFingerprint
) {
  if (!wealthOrderIdPattern.test(fingerprint.orderId)) {
    throw new Error('Wealth candidate matching requires the real INV-* ID read from Client.');
  }
  const expectedAmount = new Decimal(fingerprint.amount);
  const normalized = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return matchCandidatesByStages(records, [
    { id: 'orderId', label: 'INV订单号', matches: record => record.orderId === fingerprint.orderId },
    { id: 'kind', label: '订单类型', matches: record => record.kind === fingerprint.kind },
    {
      id: 'customer',
      label: '测试客户',
      matches: record => matchesConfiguredCustomerIdentity(record.customerText, fingerprint.customerIdentity)
    },
    {
      id: 'product',
      label: '产品',
      matches: record => normalized(record.productName) === normalized(fingerprint.productName)
    },
    { id: 'currency', label: '币种', matches: record => record.currency.toUpperCase() === fingerprint.currency.toUpperCase() },
    { id: 'amount', label: '金额/份额', matches: record => new Decimal(record.amount).equals(expectedAmount) },
    { id: 'status', label: '状态', matches: record => normalized(record.status) === normalized(fingerprint.status) },
    {
      id: 'timeWindow',
      label: '提交时间窗口',
      matches: record => {
        if (!fingerprint.submittedAtMs || !fingerprint.matchWindowMs) return true;
        if (!record.createdAtMs) return false;
        return Math.abs(record.createdAtMs - fingerprint.submittedAtMs) <= fingerprint.matchWindowMs;
      }
    }
  ]);
}

export function prepareWealthResume(
  runId: string,
  kind: WealthOrderKind,
  amount: string,
  currency: string
): FlowResumeState {
  return createPreparedFlowState({ runId, flowId: `wealth-${kind}`, amount, currency });
}

export const WEALTH_SUBSCRIBE_PRIMARY_ORACLES = {
  reject: [
    'Client唯一INV认购订单存在',
    'Admin按INV订单号唯一定位且详情匹配',
    'Admin拒绝后Client原订单进入拒绝终态',
    '付款账户余额符合拒绝退款/不扣款规则且持仓不增加'
  ],
  approve: [
    'Client唯一INV认购订单存在',
    'Admin候选唯一且产品、金额、付款账户匹配',
    'Admin批准状态与Client订单成功终态一致',
    '付款账户余额减少值、手续费和持仓增加一致'
  ]
} as const;

export const WEALTH_REDEEM_PRIMARY_ORACLES = {
  reject: [
    'Client唯一INV赎回订单存在',
    'Admin按INV订单号唯一定位且详情匹配',
    'Admin拒绝后Client原订单进入拒绝终态',
    '持仓份额和结算账户余额符合拒绝规则'
  ],
  approve: [
    'Client唯一INV赎回订单存在',
    'Admin候选唯一且产品、份额、结算账户匹配',
    'Admin批准状态与Client订单成功终态一致',
    '持仓减少、手续费和结算账户到账金额一致'
  ]
} as const;

export const WEALTH_SECONDARY_ORACLES = [
  '通知记录',
  '收益明细展示',
  '非核心产品详情字段'
] as const;
