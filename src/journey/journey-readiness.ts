import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import Decimal from 'decimal.js';

import {
  FRESH_USER_JOURNEY_INITIAL_BALANCE_ENV,
  FRESH_USER_JOURNEY_STEPS,
  type JourneyStepDefinition,
  type JourneyStepId
} from '../../config/journey-registry';
import { findFlowDefinition, type FlowDefinition } from '../../config/flow-registry';
import { env } from '../config/env';
import {
  PersonalJourneyContextStore,
  TestUserFactory
} from '../registration';

export type JourneyReadinessCode =
  | 'READY'
  | 'SKIPPED_PREREQUISITE'
  | 'SKIPPED_NOT_READY'
  | 'SKIPPED_NOT_APPLICABLE'
  | 'BLOCKED_CONFIGURATION'
  | 'BLOCKED_TEST_DATA'
  | 'BLOCKED_FLOW_STATUS'
  | 'BLOCKED_IMPLEMENTATION'
  | 'BLOCKED_JOURNEY_ADAPTER'
  | 'BLOCKED_PREREQUISITE'
  | 'BLOCKED_DEPENDENCY';

export type JourneyReadinessBlocker = {
  code: Exclude<JourneyReadinessCode, 'READY'>;
  reason: string;
};

export type JourneyStepReadiness = {
  id: JourneyStepId;
  name: string;
  flowId: string;
  sourceFlowStatus: string;
  sourceFlowCommand: string | null;
  requirement: JourneyStepDefinition['requirement'];
  status: JourneyReadinessCode;
  blockers: JourneyReadinessBlocker[];
  affectsFollowing: string;
};

export type JourneyBudgetItem = {
  flowId: JourneyStepId;
  label: string;
  currency: string;
  amount: string | null;
  direction: 'DEBIT' | 'CREDIT' | 'NON_USD';
  source: string;
  runtimeConfirmationRequired: boolean;
};

export type JourneyBudgetReadiness = {
  configuredUsdBalance: string | null;
  knownRequiredUsd: string;
  safetyMarginUsd: string;
  estimatedRequiredUsd: string;
  knownShortfallUsd: string | null;
  complete: boolean;
  blockers: string[];
  items: JourneyBudgetItem[];
};

export type FreshUserJourneyReadiness = {
  generatedAt: string;
  ready: boolean;
  environment: {
    clientHost: string;
    adminHost: string;
    sandbox: boolean;
    adminAuthStatePresent: boolean;
    clientPasswordConfigured: boolean;
    clientOtpConfigured: boolean;
    registrationOtpConfigured: boolean;
    securityKeyConfigured: boolean;
  };
  data: {
    availableFreshIdentityCount: number;
    canGenerateFreshIdentity: boolean;
    recoverablePersonalJourneyCount: number;
    abandonedPersonalJourneyCount: number;
  };
  budget: JourneyBudgetReadiness;
  steps: JourneyStepReadiness[];
  globalBlockers: string[];
};

function hostname(value: string | undefined): string {
  if (!value) return 'missing';
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return 'invalid';
  }
}

function isSandboxHost(value: string): boolean {
  return /sandbox|staging|localhost|127\.0\.0\.1|\.test$/i.test(value);
}

function configuredDecimal(name: string): Decimal | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  try {
    const decimal = new Decimal(value);
    if (!decimal.isFinite() || decimal.isNegative()) return undefined;
    return decimal;
  } catch {
    return undefined;
  }
}

function maximumUniqueAmount(baseName: string, precisionName: string): Decimal | undefined {
  const base = configuredDecimal(baseName);
  const precision = Number(process.env[precisionName] ?? '2');
  if (!base || !Number.isInteger(precision) || precision < 0 || precision > 8) return undefined;
  return base.plus(new Decimal(1).minus(new Decimal(10).pow(-precision)));
}

export function evaluateJourneyBudget(): JourneyBudgetReadiness {
  const configured = configuredDecimal(FRESH_USER_JOURNEY_INITIAL_BALANCE_ENV);
  const transferMaximum = maximumUniqueAmount('TRANSFER_UNIQUE_AMOUNT_BASE', 'TRANSFER_AMOUNT_PRECISION');
  const withdrawalMaximum = maximumUniqueAmount('WITHDRAWAL_UNIQUE_AMOUNT_BASE', 'WITHDRAWAL_AMOUNT_PRECISION');
  const withdrawalFeeBudget = configuredDecimal('JOURNEY_WITHDRAWAL_FEE_BUDGET');
  const knownUsOpeningFee = configuredDecimal('JOURNEY_US_OPENING_FEE_BUDGET');
  const knownBahrainOpeningFee = configuredDecimal('JOURNEY_BAHRAIN_OPENING_FEE_BUDGET');
  const safetyMargin = configuredDecimal('JOURNEY_BUDGET_SAFETY_MARGIN') ?? new Decimal(250);
  const items: JourneyBudgetItem[] = [
    {
      flowId: 'J-004',
      label: 'Exchange测试金额',
      currency: (process.env.EXCHANGE_FROM_CURRENCY ?? 'UNKNOWN').toUpperCase(),
      amount: process.env.EXCHANGE_TEST_AMOUNT?.trim() || null,
      direction: 'NON_USD',
      source: 'EXCHANGE_TEST_AMOUNT；必须由Fresh User真实转出资产覆盖',
      runtimeConfirmationRequired: true
    },
    {
      flowId: 'J-005',
      label: 'Transfer最大唯一测试金额',
      currency: (process.env.TRANSFER_CURRENCY ?? 'USD').toUpperCase(),
      amount: transferMaximum?.toFixed(Number(process.env.TRANSFER_AMOUNT_PRECISION ?? '2')) ?? null,
      direction: 'DEBIT',
      source: 'TRANSFER_UNIQUE_AMOUNT_BASE及业务精度的保守上界',
      runtimeConfirmationRequired: true
    },
    {
      flowId: 'J-006',
      label: 'Deposit测试入账',
      currency: (process.env.DEPOSIT_CURRENCY ?? 'USD').toUpperCase(),
      amount: process.env.DEPOSIT_TEST_AMOUNT?.trim() || null,
      direction: 'CREDIT',
      source: 'DEPOSIT_TEST_AMOUNT；实际DP-003使用唯一金额',
      runtimeConfirmationRequired: true
    },
    {
      flowId: 'J-007',
      label: 'Withdrawal最大唯一测试金额',
      currency: (process.env.WITHDRAWAL_CURRENCY ?? 'USD').toUpperCase(),
      amount: withdrawalMaximum?.toFixed(Number(process.env.WITHDRAWAL_AMOUNT_PRECISION ?? '2')) ?? null,
      direction: 'DEBIT',
      source: 'WITHDRAWAL_UNIQUE_AMOUNT_BASE及业务精度的保守上界；手续费尚未结构化',
      runtimeConfirmationRequired: true
    },
    {
      flowId: 'J-007',
      label: 'Withdrawal手续费预算',
      currency: 'USD',
      amount: withdrawalFeeBudget?.toString() ?? null,
      direction: 'DEBIT',
      source: 'JOURNEY_WITHDRAWAL_FEE_BUDGET；执行时必须从页面重读',
      runtimeConfirmationRequired: true
    },
    {
      flowId: 'J-008',
      label: 'Bahrain Opening已观察开户费',
      currency: 'USD',
      amount: knownBahrainOpeningFee?.toString() ?? null,
      direction: 'DEBIT',
      source: 'OPEN-BH-003 Dry Run历史观察；执行时必须从页面重读',
      runtimeConfirmationRequired: true
    },
    {
      flowId: 'J-009',
      label: 'US Opening已观察开户费',
      currency: 'USD',
      amount: knownUsOpeningFee?.toString() ?? null,
      direction: 'DEBIT',
      source: 'OPEN-US-003真实Run历史观察；执行时必须从页面重读',
      runtimeConfirmationRequired: true
    }
  ];

  const knownRequired = items.reduce((total, item) => {
    if (item.direction !== 'DEBIT' || item.currency !== 'USD' || item.amount === null) return total;
    return total.plus(item.amount);
  }, new Decimal(0));
  const estimatedRequired = knownRequired.plus(safetyMargin);
  const blockers: string[] = [];
  if (!configured) blockers.push(`${FRESH_USER_JOURNEY_INITIAL_BALANCE_ENV}未配置为有效非负Decimal。`);
  const shortfall = configured ? Decimal.max(estimatedRequired.minus(configured), 0) : undefined;
  if (shortfall?.greaterThan(0)) {
    blockers.push(`配置余额低于已知成本加安全余量，缺口${shortfall.toString()} USD。`);
  }

  return {
    configuredUsdBalance: configured?.toString() ?? null,
    knownRequiredUsd: knownRequired.toString(),
    safetyMarginUsd: safetyMargin.toString(),
    estimatedRequiredUsd: estimatedRequired.toString(),
    knownShortfallUsd: shortfall?.toString() ?? null,
    complete: blockers.length === 0,
    blockers,
    items
  };
}

function addBlocker(
  blockers: JourneyReadinessBlocker[],
  code: JourneyReadinessBlocker['code'],
  reason: string
): void {
  if (!blockers.some(blocker => blocker.code === code && blocker.reason === reason)) {
    blockers.push({ code, reason });
  }
}

function sourceFlowBlockers(
  step: JourneyStepDefinition,
  flow: FlowDefinition | undefined,
  blockers: JourneyReadinessBlocker[]
): void {
  const statusCode = step.requirement === 'required'
    ? 'BLOCKED_FLOW_STATUS' as const
    : 'SKIPPED_NOT_READY' as const;
  const implementationCode = step.requirement === 'required'
    ? 'BLOCKED_IMPLEMENTATION' as const
    : 'SKIPPED_NOT_READY' as const;
  const adapterCode = step.requirement === 'required'
    ? 'BLOCKED_JOURNEY_ADAPTER' as const
    : 'SKIPPED_NOT_READY' as const;
  if (!flow) {
    addBlocker(blockers, implementationCode, `Flow Registry中不存在${step.flowId}。`);
    return;
  }
  if (!['Ready', 'Mutation Ready'].includes(flow.capabilityStatus)) {
    addBlocker(blockers, statusCode, `来源Flow Capability状态为${flow.capabilityStatus}。`);
  }
  if (!flow.implemented) {
    addBlocker(blockers, implementationCode, '来源Flow尚未实现真实Mutation。');
  }
  if (!flow.npmScript) {
    addBlocker(blockers, implementationCode, '来源Flow没有可执行npm命令。');
  }
  if (!step.adapterReady) {
    addBlocker(
      blockers,
      adapterCode,
      `${step.id}尚未注册可回写Journey Context的执行适配器。`
    );
  }
}

function stepSpecificBlockers(input: {
  step: JourneyStepDefinition;
  blockers: JourneyReadinessBlocker[];
  availableFreshIdentityCount: number;
  canGenerateFreshIdentity: boolean;
  recoverablePersonalJourneyCount: number;
  budget: JourneyBudgetReadiness;
}): void {
  const { step, blockers } = input;
  switch (step.id) {
    case 'J-001':
      if (input.availableFreshIdentityCount < 1 && !input.canGenerateFreshIdentity) {
        addBlocker(blockers, 'BLOCKED_TEST_DATA', 'Sandbox个人注册数据池既无available身份，也未配置安全生成策略。');
      }
      if (!env.client.password) addBlocker(blockers, 'BLOCKED_CONFIGURATION', 'CLIENT_PASSWORD未配置。');
      if (!env.personalRegistration.otp) addBlocker(blockers, 'BLOCKED_CONFIGURATION', 'CLIENT_REGISTER_OTP未配置。');
      break;
    case 'J-002':
      if (!existsSync(resolve('auth/admin.json'))) {
        addBlocker(blockers, 'BLOCKED_CONFIGURATION', 'auth/admin.json不存在。');
      }
      break;
    case 'J-003':
      if (!input.budget.configuredUsdBalance) {
        addBlocker(blockers, 'BLOCKED_CONFIGURATION', `${FRESH_USER_JOURNEY_INITIAL_BALANCE_ENV}未配置。`);
      }
      break;
    case 'J-004': {
      const sourceAccount = env.exchange.sourceAccountType ?? '未配置';
      const sourceCurrency = env.exchange.fromCurrency ?? '未配置';
      if (!/香港账户/i.test(sourceAccount) || sourceCurrency.toUpperCase() !== 'USD') {
        addBlocker(
          blockers,
          'SKIPPED_PREREQUISITE',
          `当前EX-001需要${sourceAccount}/${sourceCurrency}转出，但J-003只计划Bootstrap香港账户USD，Fresh User的兑换源资产没有建立。`
        );
      }
      break;
    }
    case 'J-005':
      addBlocker(
        blockers,
        'SKIPPED_PREREQUISITE',
        'TR-003要求Fresh User已有老虎证券券商账户；J-001至J-004没有创建该账户，当前Journey顺序无法满足前置条件。'
      );
      break;
    case 'J-007':
      addBlocker(
        blockers,
        'SKIPPED_NOT_READY',
        'Withdrawal Capability已验证，但Fresh User新申请适配器尚未接入Journey。'
      );
      break;
    case 'J-008':
      addBlocker(
        blockers,
        'SKIPPED_NOT_READY',
        'OPEN-BH-003为Mutation Ready设计但implemented=false且npmScript为空。'
      );
      break;
    case 'J-009':
      break;
    default:
      break;
  }
}

export function evaluateFreshUserJourneyReadiness(now = new Date()): FreshUserJourneyReadiness {
  const clientHost = hostname(env.client.baseUrl);
  const adminHost = hostname(env.admin.baseUrl);
  const sandbox = isSandboxHost(clientHost) && isSandboxHost(adminHost);
  const factory = new TestUserFactory(env.personalRegistration.dataPoolPath);
  const poolReadiness = factory.readiness();
  const personalStore = new PersonalJourneyContextStore();
  const personalContexts = personalStore.list();
  const recoverablePersonalJourneyCount = personalContexts
    .filter(candidate => personalStore.lifecycleOf(candidate) === 'RESUMABLE').length;
  const abandonedPersonalJourneyCount = personalContexts
    .filter(candidate => personalStore.lifecycleOf(candidate) === 'ABANDONED').length;
  const budget = evaluateJourneyBudget();
  const environment = {
    clientHost,
    adminHost,
    sandbox,
    adminAuthStatePresent: existsSync(resolve('auth/admin.json')),
    clientPasswordConfigured: Boolean(env.client.password),
    clientOtpConfigured: Boolean(env.client.otp),
    registrationOtpConfigured: Boolean(env.personalRegistration.otp),
    securityKeyConfigured: Boolean(env.client.securityKey)
  };
  const globalBlockers: string[] = [];
  if (!sandbox) globalBlockers.push('Client/Admin URL未同时通过Sandbox/Staging/Local/.test主机保护。');
  if (!environment.adminAuthStatePresent) globalBlockers.push('auth/admin.json不存在。');
  if (!environment.clientPasswordConfigured) globalBlockers.push('CLIENT_PASSWORD未配置。');
  if (!environment.clientOtpConfigured) globalBlockers.push('CLIENT_OTP未配置。');
  if (!environment.registrationOtpConfigured) globalBlockers.push('CLIENT_REGISTER_OTP未配置。');
  if (!environment.securityKeyConfigured) globalBlockers.push('CLIENT_SECURITY_KEY未配置。');
  if (!poolReadiness.ready) globalBlockers.push(...poolReadiness.blockers);
  if (!budget.complete) globalBlockers.push(...budget.blockers);

  const steps = FRESH_USER_JOURNEY_STEPS.map(step => {
    const flow = findFlowDefinition(step.flowId);
    const blockers: JourneyReadinessBlocker[] = [];
    sourceFlowBlockers(step, flow, blockers);
    stepSpecificBlockers({
      step,
      blockers,
      availableFreshIdentityCount: poolReadiness.availableCount,
      canGenerateFreshIdentity: poolReadiness.canGenerate,
      recoverablePersonalJourneyCount,
      budget
    });
    const result: JourneyStepReadiness = {
      id: step.id,
      name: step.name,
      flowId: step.flowId,
      sourceFlowStatus: flow?.capabilityStatus ?? 'Missing',
      sourceFlowCommand: flow?.command ?? null,
      requirement: step.requirement,
      status: blockers.length === 0
        ? 'READY'
        : step.requirement === 'optional'
          ? blockers.some(blocker => blocker.code === 'SKIPPED_PREREQUISITE')
            ? 'SKIPPED_PREREQUISITE'
            : 'SKIPPED_NOT_READY'
          : blockers[0].code,
      blockers,
      affectsFollowing: step.blockedImpact
    };
    return result;
  });

  const blockedIds = new Set(
    steps.filter(step => step.status.startsWith('BLOCKED_')).map(step => step.id)
  );
  for (const stepResult of steps) {
    const definition = FRESH_USER_JOURNEY_STEPS.find(step => step.id === stepResult.id)!;
    const blockedDependencies = definition.dependsOn.filter(id => blockedIds.has(id));
    if (blockedDependencies.length > 0) {
      if (definition.requirement === 'required') {
        addBlocker(
          stepResult.blockers,
          'BLOCKED_DEPENDENCY',
          `依赖步骤未就绪：${blockedDependencies.join('、')}。`
        );
        if (stepResult.status === 'READY') stepResult.status = 'BLOCKED_DEPENDENCY';
        blockedIds.add(stepResult.id);
      } else {
        addBlocker(
          stepResult.blockers,
          'SKIPPED_PREREQUISITE',
          `依赖步骤未就绪：${blockedDependencies.join('、')}。`
        );
        stepResult.status = 'SKIPPED_PREREQUISITE';
      }
    }
  }

  return {
    generatedAt: now.toISOString(),
    ready: globalBlockers.length === 0 && steps
      .filter(step => step.requirement === 'required')
      .every(step => step.status === 'READY'),
    environment,
    data: {
      availableFreshIdentityCount: poolReadiness.availableCount,
      canGenerateFreshIdentity: poolReadiness.canGenerate,
      recoverablePersonalJourneyCount,
      abandonedPersonalJourneyCount
    },
    budget,
    steps,
    globalBlockers: [...new Set(globalBlockers)]
  };
}
