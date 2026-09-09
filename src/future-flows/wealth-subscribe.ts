import { defineFutureFlowSkeleton } from './types';

export const wealthSubscribeSkeleton = defineFutureFlowSkeleton({
  flowId: 'wealth-subscribe',
  validationScenarios: [
    '可见产品、风险资格、付款账户和可用余额',
    '最低/最高认购金额、金额精度、手续费和预计份额',
    '协议勾选、确认页和安全密钥弹窗，停在最终验证前'
  ],
  dryRunStages: [
    'Client与Admin认证预检',
    '读取付款余额、持仓和既有INV订单基线',
    '构造唯一金额并校验认购确认页',
    '使用历史INV验证Admin精确搜索、详情和Approve/Reject入口',
    '声明余额、持仓和订单终态Primary Oracle'
  ],
  testDataRequirements: [
    '已上架且允许Sandbox认购的产品',
    '满足风险等级并有足够付款余额的专用用户',
    '无冲突待处理INV订单',
    'Admin理财认购权限和有效storageState',
    '持仓、余额和订单可恢复的测试重置能力'
  ]
});

