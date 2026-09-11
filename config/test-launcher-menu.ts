import { getFlowDefinition, type FlowDefinition } from './flow-registry.js';

export type LauncherSection =
  | '注册 / KYC'
  | '法币'
  | '交易'
  | '信托'
  | '理财'
  | '开户'
  | '管理端'
  | '批量执行'
  | '工具';

export type LauncherTestEntry = {
  number: number;
  section: LauncherSection;
  name: string;
  npmScript: string;
  requiresClient: boolean;
  requiresAdmin: boolean;
  changesData: boolean;
  affectsMoney: boolean;
  safetySwitches: readonly string[];
  availabilityNote?: string;
  flow?: FlowDefinition;
};

function flowEntry(number: number, section: LauncherSection, flowId: string, options?: {
  name?: string;
  availabilityNote?: string;
}): LauncherTestEntry {
  const flow = getFlowDefinition(flowId);
  if (!flow.npmScript) throw new Error(`Launcher Flow ${flowId} has no executable npm script.`);
  return {
    number,
    section,
    name: options?.name ?? flow.name,
    npmScript: flow.npmScript,
    requiresClient: flow.requiresClient,
    requiresAdmin: flow.requiresAdmin,
    changesData: flow.changesData,
    affectsMoney: flow.affectsMoney,
    safetySwitches: flow.safetySwitches,
    availabilityNote: options?.availabilityNote,
    flow
  };
}

function commandEntry(input: Omit<LauncherTestEntry, 'flow'>): LauncherTestEntry {
  return input;
}

export const TEST_LAUNCHER_ENTRIES: readonly LauncherTestEntry[] = [
  flowEntry(1, '注册 / KYC', 'personal-registration', { name: '个人用户注册' }),
  flowEntry(2, '注册 / KYC', 'corporate-registration', { name: '企业用户注册' }),

  flowEntry(3, '法币', 'deposit', { name: '法币入金' }),
  flowEntry(4, '法币', 'deposit-rejection-journey', { name: '法币入金拒绝' }),
  flowEntry(5, '法币', 'personal-golden-journey-withdrawal', { name: '法币出金' }),

  flowEntry(6, '交易', 'user-to-user-transfer', { name: '用户转账' }),
  flowEntry(7, '交易', 'transfer-jurisdiction-to-broker', { name: '资金互转' }),
  flowEntry(8, '交易', 'exchange', { name: '兑换' }),

  flowEntry(9, '信托', 'trust-beneficiary-golden-journey', { name: '新增受益人及银行账户' }),

  flowEntry(10, '理财', 'wealth-subscribe-approve', { name: '理财产品认购' }),
  flowEntry(11, '理财', 'wealth-redeem-dry-run', {
    name: '理财产品赎回（当前仅 Dry Run）',
    availabilityNote: '当前没有可安全执行的真实赎回持仓，菜单运行现有只读 Dry Run。'
  }),
  flowEntry(12, '理财', 'wealth-subscribe-reject', { name: '理财认购拒绝' }),

  flowEntry(13, '开户', 'tiger-broker-opening', { name: '老虎证券开户' }),
  flowEntry(14, '开户', 'webull-broker-opening', { name: '微牛证券开户' }),
  flowEntry(15, '开户', 'account-opening-bahrain-approve', { name: '巴林账户开户' }),
  flowEntry(16, '开户', 'account-opening-us-approve', { name: '美国账户开户' }),
  flowEntry(17, '开户', 'account-opening-singapore-approve', { name: '新加坡账户开户' }),

  flowEntry(18, '管理端', 'admin-manual-fiat-deposit', { name: '手动入金' }),
  flowEntry(19, '管理端', 'admin-manual-fiat-withdrawal', { name: '手动出金' }),
  commandEntry({
    number: 20,
    section: '管理端',
    name: '运营客户开通巴林/新加坡账户（提交前检查）',
    npmScript: 'test:admin:opening:dry-run',
    requiresClient: false,
    requiresAdmin: true,
    changesData: false,
    affectsMoney: false,
    safetySwitches: [],
    availabilityNote: '一次检查两个运营开户表单，停在最终提交前。'
  }),

  commandEntry({
    number: 90,
    section: '批量执行',
    name: '核心流程 Smoke',
    npmScript: 'test:smoke',
    requiresClient: true,
    requiresAdmin: true,
    changesData: false,
    affectsMoney: false,
    safetySwitches: []
  }),
  commandEntry({
    number: 91,
    section: '批量执行',
    name: '全量 Regression',
    npmScript: 'regression',
    requiresClient: true,
    requiresAdmin: true,
    changesData: false,
    affectsMoney: false,
    safetySwitches: []
  })
] as const;

export const TEST_LAUNCHER_SECTIONS: readonly LauncherSection[] = [
  '注册 / KYC',
  '法币',
  '交易',
  '信托',
  '理财',
  '开户',
  '管理端',
  '批量执行'
];

export function getLauncherEntry(number: number): LauncherTestEntry | undefined {
  return TEST_LAUNCHER_ENTRIES.find(entry => entry.number === number);
}

export function validateLauncherMenu(): void {
  const numbers = TEST_LAUNCHER_ENTRIES.map(entry => entry.number);
  if (new Set(numbers).size !== numbers.length) throw new Error('测试菜单存在重复编号。');
  for (const entry of TEST_LAUNCHER_ENTRIES) {
    if (!entry.npmScript.trim()) throw new Error(`测试菜单 ${entry.number} 缺少 npm script。`);
  }
}
