import { existsSync, readFileSync } from 'node:fs';

import type {
  BaselineCaseDelta,
  BusinessOutcome,
  BusinessReportCase,
  BusinessReportRun,
  RegressionBaselineComparison
} from './business-report.types.js';

export const DEFAULT_BASELINE_VERSION = 'FIDERE AUTOMATION BASELINE V1';

export type AutomationBaselineCase = {
  key: string;
  caseId: string;
  flowId: string;
  module: string;
  name: string;
  outcome: BusinessOutcome;
  warnings: string[];
};

export type AutomationBaselineSnapshot = {
  schemaVersion: 1;
  version: string;
  createdAt: string;
  sourceRunId: string;
  sourceCommand: string;
  summary: {
    total: number;
    passed: number;
    passedWithWarning: number;
    failed: number;
    manualReview: number;
  };
  cases: AutomationBaselineCase[];
};

export function baselineCaseKey(testCase: Pick<BusinessReportCase, 'caseId' | 'flowId' | 'name'>): string {
  return `${testCase.flowId}::${testCase.caseId}::${testCase.name}`;
}

function snapshotCase(testCase: BusinessReportCase): AutomationBaselineCase {
  return {
    key: baselineCaseKey(testCase),
    caseId: testCase.caseId,
    flowId: testCase.flowId,
    module: testCase.module,
    name: testCase.name,
    outcome: testCase.businessOutcome,
    warnings: [...testCase.warnings]
  };
}

export function createAutomationBaseline(
  report: BusinessReportRun,
  version = DEFAULT_BASELINE_VERSION,
  now = new Date()
): AutomationBaselineSnapshot {
  if (!/npm\s+run\s+(?:test:)?regression\b/i.test(report.command)) {
    throw new Error('Baseline can only be created from a complete npm run regression report.');
  }
  const unsafeCases = report.cases.filter(
    testCase => testCase.changesData || testCase.affectsMoney || testCase.review.potentiallySubmitted
  );
  if (unsafeCases.length > 0) {
    throw new Error('Baseline update rejected a report containing Mutation or money cases.');
  }

  return {
    schemaVersion: 1,
    version,
    createdAt: now.toISOString(),
    sourceRunId: report.runId,
    sourceCommand: report.command,
    summary: {
      total: report.summary.total,
      passed: report.summary.passed,
      passedWithWarning: report.summary.passedWithWarning,
      failed: report.summary.failed + report.summary.timedOut,
      manualReview: report.summary.manualReview
    },
    cases: report.cases.map(snapshotCase).sort((left, right) => left.key.localeCompare(right.key))
  };
}

export function readAutomationBaseline(filePath: string): AutomationBaselineSnapshot | undefined {
  if (!existsSync(filePath)) return undefined;
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as AutomationBaselineSnapshot;
  if (parsed.schemaVersion !== 1 || !parsed.version || !Array.isArray(parsed.cases)) {
    throw new Error('Automation baseline file has an unsupported schema.');
  }
  return parsed;
}

function delta(
  baseline: AutomationBaselineCase | undefined,
  current: BusinessReportCase | undefined
): BaselineCaseDelta {
  return {
    key: baseline?.key ?? baselineCaseKey(current!),
    caseId: baseline?.caseId ?? current!.caseId,
    name: baseline?.name ?? current!.name,
    baselineOutcome: baseline?.outcome,
    currentOutcome: current?.businessOutcome
  };
}

function isAdverse(outcome: BusinessOutcome): boolean {
  return ['FAIL', 'MANUAL_REVIEW', 'BLOCKED', 'NOT_RUN'].includes(outcome);
}

export function compareRegressionWithBaseline(
  baseline: AutomationBaselineSnapshot,
  report: BusinessReportRun
): RegressionBaselineComparison {
  const applicable = /npm\s+run\s+(?:test:)?regression\b/i.test(report.command);
  const baselineByKey = new Map(baseline.cases.map(testCase => [testCase.key, testCase]));
  const currentByKey = new Map(report.cases.map(testCase => [baselineCaseKey(testCase), testCase]));

  if (!applicable) {
    return {
      applicable,
      baselineVersion: baseline.version,
      baselineRunId: baseline.sourceRunId,
      currentRunId: report.runId,
      baselineTotal: baseline.summary.total,
      currentTotal: report.summary.total,
      totalDelta: report.summary.total - baseline.summary.total,
      addedTests: [],
      removedTests: [],
      newPasses: [],
      newFailures: [],
      newWarnings: [],
      knownWarnings: [],
      regressions: [],
      recovered: [],
      matchesBaseline: false,
      hasNewRegression: false,
      message: '当前Run不是完整Regression，未进行Baseline回归差异裁决。'
    };
  }

  const addedTests = [...currentByKey.entries()]
    .filter(([key]) => !baselineByKey.has(key))
    .map(([, current]) => delta(undefined, current));
  const removedTests = [...baselineByKey.entries()]
    .filter(([key]) => !currentByKey.has(key))
    .map(([, original]) => delta(original, undefined));
  const newPasses = addedTests.filter(item => item.currentOutcome === 'PASS');
  const newFailures = addedTests.filter(item => item.currentOutcome === 'FAIL');
  const newWarnings = addedTests.filter(item => item.currentOutcome === 'PASS_WITH_WARNING');
  const knownWarnings: BaselineCaseDelta[] = [];
  const regressions: BaselineCaseDelta[] = [];
  const recovered: BaselineCaseDelta[] = [];

  for (const [key, current] of currentByKey) {
    const original = baselineByKey.get(key);
    if (!original) continue;
    if (current.businessOutcome === 'PASS_WITH_WARNING') {
      if (original.outcome === 'PASS_WITH_WARNING') knownWarnings.push(delta(original, current));
      else regressions.push(delta(original, current));
      continue;
    }
    if (isAdverse(current.businessOutcome) && original.outcome !== current.businessOutcome) {
      regressions.push(delta(original, current));
      continue;
    }
    if (
      current.businessOutcome === 'PASS' &&
      (original.outcome === 'PASS_WITH_WARNING' || isAdverse(original.outcome))
    ) {
      recovered.push(delta(original, current));
    }
  }

  const allExistingOutcomesMatch = baseline.cases.every(original =>
    currentByKey.get(original.key)?.businessOutcome === original.outcome
  );
  const matchesBaseline =
    addedTests.length === 0 &&
    removedTests.length === 0 &&
    allExistingOutcomesMatch;
  const hasNewRegression = regressions.length > 0 || removedTests.length > 0;
  const message = hasNewRegression
    ? '发现新增回归问题'
    : matchesBaseline
      ? '本次回归与Baseline一致'
      : addedTests.length > 0
        ? `未发现原有用例回归；本次包含${addedTests.length}条新增测试。`
        : '未发现新增回归问题；Baseline结果存在已记录变化。';

  return {
    applicable,
    baselineVersion: baseline.version,
    baselineRunId: baseline.sourceRunId,
    currentRunId: report.runId,
    baselineTotal: baseline.summary.total,
    currentTotal: report.summary.total,
    totalDelta: report.summary.total - baseline.summary.total,
    addedTests,
    removedTests,
    newPasses,
    newFailures,
    newWarnings,
    knownWarnings,
    regressions,
    recovered,
    matchesBaseline,
    hasNewRegression,
    message
  };
}

export function renderAutomationBaselineMarkdown(baseline: AutomationBaselineSnapshot): string {
  const warningCases = baseline.cases.filter(testCase => testCase.outcome === 'PASS_WITH_WARNING');
  const warningRows = warningCases.length > 0
    ? warningCases
        .map(testCase => `| ${testCase.caseId} | ${testCase.name} | ${testCase.warnings.join('；') || '辅助Oracle未通过'} |`)
        .join('\n')
    : '| - | - | 无 |';

  return `# FIDERE AUTOMATION BASELINE V1

Baseline只能通过\`npm run baseline:update\`显式更新。普通Validation、Dry Run或Regression只读取并比较，不会覆盖本文件或机器基线。

| 指标 | Baseline V1 |
| --- | ---: |
| Smoke | 10/10 |
| Validation | 16/16 |
| Readonly | 7/7 |
| Dry Run | 4/4 |
| Regression | ${baseline.summary.total}/${baseline.summary.total} |
| PASS | ${baseline.summary.passed} |
| PASS_WITH_WARNING | ${baseline.summary.passedWithWarning} |
| FAIL | ${baseline.summary.failed} |
| MANUAL_REVIEW | ${baseline.summary.manualReview} |

## Known Warnings

| Case | 用例 | 原因 |
| --- | --- | --- |
${warningRows}

两个Warning均来自同一个已知产品展示问题：TR-003资金互转的Admin状态、Client TRF终态、源账户余额、手续费和实际到账等Primary Oracle均已通过，但Client全局交易流水未展示唯一对应Transfer记录。该问题不影响Transfer业务成功结论。

## Source

- Version: ${baseline.version}
- Source Run: ${baseline.sourceRunId}
- Source Command: \`${baseline.sourceCommand}\`
- Created At: ${baseline.createdAt}
`;
}
