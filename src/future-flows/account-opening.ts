import { defineFutureFlowSkeleton } from './types';

export const accountOpeningSkeleton = defineFutureFlowSkeleton({
  flowId: 'account-opening',
  validationScenarios: [
    '开户入口、地区账户类型和当前账户状态',
    '必填资料、协议、文件和提交前确认页',
    '重复申请、资格不满足和缺失资料提示'
  ],
  dryRunStages: [
    'Client与Admin认证预检',
    '读取可申请账户与既有申请基线',
    '填写开户表单并停在Client最终提交前',
    '使用历史申请验证Admin候选逐层匹配与详情字段',
    '打开审核表单并停在最终Approve/Reject前'
  ],
  testDataRequirements: [
    'KYC已通过且目标地区账户尚未开通的专用用户',
    '可重复使用的Sandbox身份、地址、税务与签署文件',
    'Admin开户审核权限和有效storageState',
    '按申请编号恢复账户状态的测试重置能力',
    '地区渠道或券商Sandbox及可控终态'
  ]
});

