import { defineFutureFlowSkeleton } from './types';

export const wealthRedeemSkeleton = defineFutureFlowSkeleton({
  flowId: 'wealth-redeem',
  validationScenarios: [
    '可赎回持仓、赎回窗口、结算账户和可用份额',
    '最低/最高赎回份额、金额精度、手续费和预计到账',
    '确认页和安全密钥弹窗，停在最终验证前'
  ],
  dryRunStages: [
    'Client与Admin认证预检',
    '读取持仓、结算余额和既有INV订单基线',
    '构造合法赎回份额并校验确认页',
    '使用历史INV验证Admin精确搜索、详情和Approve/Reject入口',
    '声明持仓减少、结算余额增加和订单终态Primary Oracle'
  ],
  testDataRequirements: [
    '存在可赎回持仓且处于开放赎回窗口的专用用户',
    '可观测结算账户余额和持仓份额',
    '无冲突待处理INV赎回订单',
    'Admin理财赎回权限和有效storageState',
    '持仓、余额和订单可恢复的测试重置能力'
  ]
});

