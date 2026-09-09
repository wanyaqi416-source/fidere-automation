export const FRESH_USER_JOURNEY_ID = 'fresh-user-journey';
export const FRESH_USER_JOURNEY_NAME = 'Fresh User Golden Journey v1';
export const FRESH_USER_JOURNEY_CONFIRMATION = 'EXECUTE fresh-user-journey';
export const FRESH_USER_JOURNEY_INITIAL_BALANCE_ENV = 'JOURNEY_INITIAL_USD_BALANCE';

export type JourneyStepId =
  | 'J-001'
  | 'J-002'
  | 'J-003'
  | 'J-004'
  | 'J-005'
  | 'J-006'
  | 'J-007'
  | 'J-008'
  | 'J-009';

export type JourneyAdapterKind =
  | 'fresh-registration-context'
  | 'registration-admin-target'
  | 'fresh-balance-bootstrap'
  | 'registered-flow-command'
  | 'none';

export type JourneyStepRequirement = 'required' | 'optional';

export type JourneyStepDefinition = {
  id: JourneyStepId;
  name: string;
  flowId: string;
  requirement: JourneyStepRequirement;
  unavailableDisposition?: 'SKIPPED_PREREQUISITE' | 'SKIPPED_NOT_READY';
  dependsOn: readonly JourneyStepId[];
  changesData: boolean;
  affectsMoney: boolean;
  adapter: JourneyAdapterKind;
  adapterReady: boolean;
  requiredContextInputs: readonly string[];
  contextOutputs: readonly string[];
  blockedImpact: string;
  description: string;
};

export const FRESH_USER_JOURNEY_STEPS: readonly JourneyStepDefinition[] = [
  {
    id: 'J-001',
    name: 'Fresh Personal Registration',
    flowId: 'personal-registration',
    requirement: 'required',
    dependsOn: [],
    changesData: true,
    affectsMoney: false,
    adapter: 'fresh-registration-context',
    adapterReady: true,
    requiredContextInputs: [],
    contextOutputs: ['user.displayName', 'user.email', 'user.phone', 'user.userId'],
    blockedImpact: '整个Journey无法建立Golden User，所有后续步骤均不可执行。',
    description: '调用REG-P-002并从新增Personal Journey Context读取本次唯一用户。'
  },
  {
    id: 'J-002',
    name: 'Admin Registration KYC Approve',
    flowId: 'personal-registration-admin-approval',
    requirement: 'required',
    dependsOn: ['J-001'],
    changesData: true,
    affectsMoney: false,
    adapter: 'registration-admin-target',
    adapterReady: true,
    requiredContextInputs: ['user.email', 'registration.runId'],
    contextOutputs: ['user.kycStatus'],
    blockedImpact: '香港账户及后续资金/开户业务均不能开始。',
    description: '按accountType和原registration runId调用REG-P-003或REG-C-003，固定reviewId；只有真实Admin与干净登录Client KYC通过才完成。注册尾部已有此证据时不重复审核。'
  },
  {
    id: 'J-003',
    name: '香港账户USD资金Bootstrap',
    flowId: 'deposit',
    requirement: 'required',
    dependsOn: ['J-002'],
    changesData: true,
    affectsMoney: true,
    adapter: 'fresh-balance-bootstrap',
    adapterReady: true,
    requiredContextInputs: ['user.email'],
    contextOutputs: ['account.hongKongUsdBalance', 'references.bootstrapDepositTxn'],
    blockedImpact: '所有需要USD余额的资金业务与付费开户均被阻塞。',
    description: '使用独立FreshUserBalanceBootstrap Resume状态，复用DP-003页面和Admin认领能力，精确入账配置金额且禁止重复Bootstrap。'
  },
  {
    id: 'J-004',
    name: 'Exchange Happy Path',
    flowId: 'exchange',
    requirement: 'optional',
    unavailableDisposition: 'SKIPPED_PREREQUISITE',
    dependsOn: ['J-003'],
    changesData: true,
    affectsMoney: true,
    adapter: 'registered-flow-command',
    adapterReady: false,
    requiredContextInputs: ['user.email', 'account.exchangeSourceBalance'],
    contextOutputs: ['references.exchangeOrderId', 'references.exchangeLedgerTransactionId'],
    blockedImpact: '只阻塞兑换覆盖；不应单独阻止与兑换无依赖的后续Flow。',
    description: 'EX-001命令可运行，但尚未把本次用户输入、OTC/TXN输出和余额写回定义为Journey适配器。'
  },
  {
    id: 'J-005',
    name: 'Transfer Approve Happy Path',
    flowId: 'transfer-jurisdiction-to-broker',
    requirement: 'optional',
    unavailableDisposition: 'SKIPPED_PREREQUISITE',
    dependsOn: ['J-003'],
    changesData: true,
    affectsMoney: true,
    adapter: 'registered-flow-command',
    adapterReady: false,
    requiredContextInputs: ['user.email', 'account.hongKongUsdBalance', 'account.brokerAccount'],
    contextOutputs: ['references.transferTrf', 'references.transferAdminTxn'],
    blockedImpact: '只阻塞资金互转覆盖；Deposit/Withdrawal可在账户余额满足时独立继续。',
    description: 'TR-003命令可运行，但尚未把本次用户输入、TRF/Admin TXN输出和余额写回定义为Journey适配器。'
  },
  {
    id: 'J-006',
    name: 'Deposit Claim Happy Path',
    flowId: 'deposit',
    requirement: 'optional',
    unavailableDisposition: 'SKIPPED_NOT_READY',
    dependsOn: ['J-003'],
    changesData: true,
    affectsMoney: true,
    adapter: 'registered-flow-command',
    adapterReady: true,
    requiredContextInputs: ['user.email', 'account.hongKongUsdBalance'],
    contextOutputs: ['references.depositTxn', 'account.hongKongUsdBalance'],
    blockedImpact: '只阻塞独立入金覆盖；不影响已有余额下的后续Flow。',
    description: '按Journey用户调用DP-003 Fresh Happy Path，并通过通用Flow Execution Result回写新TXN与认领后余额。'
  },
  {
    id: 'J-007',
    name: 'Withdrawal Approve Happy Path',
    flowId: 'withdraw',
    requirement: 'optional',
    unavailableDisposition: 'SKIPPED_NOT_READY',
    dependsOn: ['J-003'],
    changesData: true,
    affectsMoney: true,
    adapter: 'none',
    adapterReady: false,
    requiredContextInputs: ['user.email', 'account.hongKongUsdBalance'],
    contextOutputs: ['references.withdrawalTxn', 'account.hongKongUsdBalance'],
    blockedImpact: '只阻塞出金覆盖；不影响开户Flow。',
    description: 'WD-003当前只有绑定既有TXN的Resume，没有Fresh User新申请命令。'
  },
  {
    id: 'J-008',
    name: 'Bahrain Account Opening Approve',
    flowId: 'account-opening-bahrain-approve',
    requirement: 'optional',
    unavailableDisposition: 'SKIPPED_NOT_READY',
    dependsOn: ['J-002', 'J-003'],
    changesData: true,
    affectsMoney: true,
    adapter: 'none',
    adapterReady: false,
    requiredContextInputs: ['user.email', 'account.hongKongUsdBalance'],
    contextOutputs: ['references.bahrainOpeningReference', 'account.hongKongUsdBalance'],
    blockedImpact: '仅阻塞巴林开户；用户已开户时应改为SKIPPED_ALREADY_OPEN。',
    description: 'OPEN-BH-003只有Validation/Dry Run和Mutation Ready设计，尚无真实执行命令。'
  },
  {
    id: 'J-009',
    name: 'US Account Opening Approve',
    flowId: 'account-opening-us-approve',
    requirement: 'optional',
    unavailableDisposition: 'SKIPPED_NOT_READY',
    dependsOn: ['J-002', 'J-003'],
    changesData: true,
    affectsMoney: true,
    adapter: 'none',
    adapterReady: false,
    requiredContextInputs: ['user.email', 'user.phone', 'account.hongKongUsdBalance'],
    contextOutputs: ['references.usOpeningReference', 'account.hongKongUsdBalance'],
    blockedImpact: '阻塞Journey最终美国开户阶段；此前独立资金Flow结果仍可保留。',
    description: 'OPEN-US能力已验证；Golden Journey仍需Fresh User输入输出适配器，历史BAAS_FAILED Resume不得参与本次Fresh Run。'
  }
] as const;
