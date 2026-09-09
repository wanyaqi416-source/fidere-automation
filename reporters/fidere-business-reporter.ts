import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { resolve } from 'node:path';

import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
  TestStep
} from '@playwright/test/reporter';

import { renderBusinessReport } from '../src/reporting/html-template';
import { findFlowDefinition } from '../config/flow-registry';
import { adjudicateOracles } from '../src/flow-engine/oracle';
import {
  compareRegressionWithBaseline,
  readAutomationBaseline
} from '../src/reporting/automation-baseline';
import {
  historyEntryFromReport,
  renderBusinessHistoryIndex,
  type BusinessHistoryIndex
} from '../src/reporting/history-index';
import type {
  BusinessCaseMetadata,
  BusinessEvidence,
  BusinessOracleRecord,
  BusinessOutcome,
  BusinessReportCase,
  BusinessReportPayload,
  BusinessReportRun,
  BusinessReviewState,
  BusinessStepRecord
} from '../src/reporting/business-report.types';
import {
  displayPath,
  existingFileLink,
  formatDateTime,
  safeCommand,
  safeErrorSummary,
  safeHostname,
  timestampForFile
} from '../src/reporting/business-report.utils';
import { sanitizeBusinessData, sanitizeRecord } from '../src/reporting/sensitive-data-mask';
import { metadataFromFlowDefinition } from '../src/reporting/flow-definition-metadata';

type CapturedTest = {
  test: TestCase;
  result: TestResult;
};

function safeRunDirectoryName(runId: string): string {
  if (!/^[A-Z0-9._-]+$/i.test(runId)) {
    throw new Error('Business report runId contains unsupported path characters.');
  }
  return runId;
}

function migrateLegacyHistory(historyRoot: string): void {
  const legacyJsonFiles = readdirSync(historyRoot, { withFileTypes: true })
    .filter(item => item.isFile() && item.name.endsWith('.json') && item.name !== 'index.json');

  for (const item of legacyJsonFiles) {
    try {
      const legacyJsonPath = resolve(historyRoot, item.name);
      const report = JSON.parse(readFileSync(legacyJsonPath, 'utf8')) as BusinessReportRun;
      const runDirectory = resolve(historyRoot, safeRunDirectoryName(report.runId));
      if (existsSync(runDirectory)) continue;

      mkdirSync(runDirectory);
      copyFileSync(legacyJsonPath, resolve(runDirectory, 'report.json'));
      const legacyHtmlPath = legacyJsonPath.replace(/\.json$/i, '.html');
      if (existsSync(legacyHtmlPath)) {
        copyFileSync(legacyHtmlPath, resolve(runDirectory, 'report.html'));
      }
    } catch (error) {
      console.warn(
        `历史业务报告迁移跳过${item.name}：${safeErrorSummary(error instanceof Error ? error.message : String(error))}`
      );
    }
  }
}

function writeHistoryIndex(historyRoot: string, generatedAt: Date): BusinessHistoryIndex {
  const runs = readdirSync(historyRoot, { withFileTypes: true })
    .filter(item => item.isDirectory())
    .flatMap(item => {
      const reportPath = resolve(historyRoot, item.name, 'report.json');
      if (!existsSync(reportPath)) return [];
      try {
        const report = JSON.parse(readFileSync(reportPath, 'utf8')) as BusinessReportRun;
        return [historyEntryFromReport(report, `./${encodeURIComponent(item.name)}/report.html`)];
      } catch (error) {
        console.warn(
          `历史业务报告索引跳过${item.name}：${safeErrorSummary(error instanceof Error ? error.message : String(error))}`
        );
        return [];
      }
    })
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  const index: BusinessHistoryIndex = {
    generatedAt: formatDateTime(generatedAt),
    total: runs.length,
    runs
  };
  writeFileSync(resolve(historyRoot, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
  writeFileSync(resolve(historyRoot, 'index.html'), renderBusinessHistoryIndex(index), 'utf8');
  return index;
}

const emptyReview = (): BusinessReviewState => ({
  manualReviewRequired: false,
  potentiallySubmitted: false,
  duplicateSubmissionRisk: false,
  safeToRerun: true
});

function annotationValue(result: TestResult, type: string): string | undefined {
  return result.annotations.find(annotation => annotation.type === type)?.description;
}

function boolAnnotation(result: TestResult, type: string, fallback = false): boolean {
  const value = annotationValue(result, type);
  return value === undefined ? fallback : value === 'true';
}

function inferModule(test: TestCase): string {
  const file = test.location.file.replace(/\\/g, '/');

  if (file.includes('/exchange/')) return '客户端兑换';
  if (file.includes('/client/')) return '客户端';
  if (file.includes('/admin/')) return '管理端';
  if (file.includes('/workflows/')) return 'Client + Admin E2E';
  return '未分类';
}

function cleanTitle(title: string): string {
  return title.replace(/(^|\s)@[\w-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function inferLevel(test: TestCase): string {
  const tags = new Set(test.tags);
  for (const level of ['L5', 'L4', 'L3', 'L2', 'L1', 'L0']) {
    if (tags.has(`@${level}`)) return level;
  }
  if (tags.has('@external')) return 'L5';
  if (tags.has('@mutation') || tags.has('@money')) return 'L4';
  if (tags.has('@dry-run')) return 'L3';
  if (tags.has('@validation')) return 'L1';
  if (tags.has('@reconciliation') || tags.has('@readonly')) return 'L2';
  if (tags.has('@smoke')) return 'L0';
  return '未提供';
}

function fallbackMetadata(test: TestCase, result: TestResult): BusinessCaseMetadata {
  const types = annotationValue(result, 'type') ?? annotationValue(result, 'testType');
  const caseId =
    annotationValue(result, 'caseId') ??
    `AUTO-${createHash('sha1').update(test.id).digest('hex').slice(0, 8).toUpperCase()}`;
  const definition = findFlowDefinition(annotationValue(result, 'flowId') ?? caseId);

  if (definition) {
    return metadataFromFlowDefinition(definition, {
      name: cleanTitle(test.title),
      level: annotationValue(result, 'level') ?? definition.level
    });
  }

  return {
    caseId,
    module: annotationValue(result, 'module') ?? inferModule(test),
    name: cleanTitle(test.title),
    description: '未提供',
    priority: annotationValue(result, 'priority') ?? '未提供',
    level: annotationValue(result, 'level') ?? inferLevel(test),
    type: types
      ? types.split('/').map(value => value.trim()).filter(Boolean)
      : test.tags.map(tag => tag.replace(/^@/, '')).filter(Boolean),
    scope: test.location.file.includes('admin') ? 'Admin' : test.location.file.includes('workflows') ? 'Client + Admin' : 'Client',
    owner: annotationValue(result, 'owner') ?? '未提供',
    requirement: annotationValue(result, 'requirement') ?? '未提供',
    preconditions: annotationValue(result, 'precondition')
      ? [annotationValue(result, 'precondition')!]
      : [],
    target: '未提供',
    expectedResult: annotationValue(result, 'expectedResult') ?? '未提供',
    changesData: boolAnnotation(result, 'changesData', test.tags.includes('@mutation')),
    affectsMoney: boolAnnotation(result, 'affectsMoney', test.tags.includes('@money')),
    dependsOnAdmin: boolAnnotation(result, 'dependsOnAdmin'),
    dependsOnThirdParty: boolAnnotation(result, 'dependsOnThirdParty'),
    safetySwitches: test.tags.includes('@money') ? ['ALLOW_MONEY_TESTS=true'] : []
  };
}

function parseBusinessPayload(result: TestResult): BusinessReportPayload | undefined {
  const attachment = result.attachments.find(item => item.name === 'fidere-business-report.json');

  if (!attachment?.body) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(attachment.body.toString('utf8')) as BusinessReportPayload;
    return parsed.schemaVersion === 1 ? sanitizeRecord(parsed) : undefined;
  } catch {
    return undefined;
  }
}

function collectFallbackSteps(steps: TestStep[]): BusinessStepRecord[] {
  const records: BusinessStepRecord[] = [];

  for (const step of steps) {
    if (step.category === 'test.step') {
      records.push({
        action: step.title,
        expected: '未提供',
        actual: step.error ? safeErrorSummary(step.error.message) : '未提供',
        status: step.error ? 'failed' : 'passed',
        durationMs: step.duration,
        error: step.error ? safeErrorSummary(step.error.message) : undefined
      });
    }

    records.push(...collectFallbackSteps(step.steps));
  }

  return records;
}

function evidenceFor(result: TestResult): BusinessEvidence[] {
  const definitions = [
    { label: '失败截图', pattern: /screenshot|\.png$/i, warning: '截图可能包含页面业务信息，请按权限查看。' },
    { label: '视频', pattern: /video|\.webm$/i },
    { label: 'Trace', pattern: /trace|\.zip$/i },
    { label: 'Error Context', pattern: /error-context/i }
  ];
  const evidence = definitions.map(definition => {
    const attachment = result.attachments.find(item =>
      definition.pattern.test(`${item.name} ${item.path ?? ''}`)
    );

    return {
      label: definition.label,
      displayPath: attachment?.path ? displayPath(attachment.path) : undefined,
      href: existingFileLink(attachment?.path),
      warning: definition.warning
    };
  });
  const fixedEvidence = [
    { label: 'Playwright HTML技术报告', path: 'playwright-report/index.html' },
    { label: 'JUnit XML', path: 'reports/junit-results.xml' }
  ];

  for (const item of fixedEvidence) {
    evidence.push({
      label: item.label,
      displayPath: displayPath(item.path),
      href: existingFileLink(item.path),
      warning: undefined
    });
  }

  return evidence;
}

function displayStatus(
  rawStatus: TestResult['status'],
  blocked: boolean,
  manualReview: boolean,
  oracles: BusinessOracleRecord[],
  warnings: string[]
): { label: string; key: string; outcome: BusinessOutcome } {
  const outcome = adjudicateOracles({
    oracles,
    warnings,
    blocked,
    mutationOccurred: manualReview,
    resultUncertain: manualReview,
    technicalFailure: rawStatus === 'failed' || rawStatus === 'timedOut'
  });
  const adjudicated: Partial<Record<BusinessOutcome, { label: string; key: string; outcome: BusinessOutcome }>> = {
    BLOCKED: { label: '阻塞', key: 'blocked', outcome: 'BLOCKED' },
    MANUAL_REVIEW: { label: '需人工核查', key: 'manualReview', outcome: 'MANUAL_REVIEW' },
    FAIL: { label: '失败', key: 'failed', outcome: 'FAIL' },
    PASS_WITH_WARNING: {
      label: '通过（有警告）',
      key: 'passedWithWarning',
      outcome: 'PASS_WITH_WARNING'
    },
    PASS: { label: '通过', key: 'passed', outcome: 'PASS' }
  };
  if (adjudicated[outcome]) return adjudicated[outcome]!;

  const statuses: Record<TestResult['status'], { label: string; key: string; outcome: BusinessOutcome }> = {
    passed: { label: '通过', key: 'passed', outcome: 'PASS' },
    failed: { label: '失败', key: 'failed', outcome: 'FAIL' },
    skipped: { label: '跳过', key: 'skipped', outcome: 'NOT_RUN' },
    timedOut: { label: '超时', key: 'timedOut', outcome: 'FAIL' },
    interrupted: { label: '中断', key: 'interrupted', outcome: 'NOT_RUN' }
  };

  return statuses[rawStatus];
}

class FidereBusinessReporter implements Reporter {
  private config?: FullConfig;
  private startedAt = new Date();
  private readonly captured = new Map<string, CapturedTest>();

  onBegin(config: FullConfig, _suite: Suite): void {
    this.config = config;
    this.startedAt = new Date();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.captured.set(test.id, { test, result });
  }

  onEnd(_result: FullResult): void {
    try {
      this.generate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Fidere中文业务报告生成失败：${safeErrorSummary(message)}`);
    }
  }

  private generate(): void {
    const endedAt = new Date();
    const runId = `${timestampForFile(endedAt)}-${randomUUID().slice(0, 8)}`;
    const cases = [...this.captured.values()].map(({ test, result }) =>
      this.buildCase(test, result)
    );
    const summary = {
      total: cases.length,
      passed: cases.filter(item => item.statusKey === 'passed').length,
      passedWithWarning: cases.filter(item => item.statusKey === 'passedWithWarning').length,
      failed: cases.filter(item => item.statusKey === 'failed').length,
      skipped: cases.filter(item => item.statusKey === 'skipped').length,
      blocked: cases.filter(item => item.statusKey === 'blocked').length,
      timedOut: cases.filter(item => item.statusKey === 'timedOut').length,
      interrupted: cases.filter(item => item.statusKey === 'interrupted').length,
      manualReview: cases.filter(item => item.review.manualReviewRequired).length,
      passRate: cases.length === 0
        ? 0
        : (cases.filter(item => ['passed', 'passedWithWarning'].includes(item.statusKey)).length / cases.length) * 100
    };
    const hostname = safeHostname(process.env.CLIENT_BASE_URL);
    const mainCase = cases.find(testCase => !testCase.caseId.startsWith('AUTO-')) ??
      cases[cases.length - 1];
    const projects = [...new Set(cases.map(item => item.scope))];
    const browsers = [
      ...new Set(
        (this.config?.projects ?? [])
          .map(project => String(project.use.browserName ?? ''))
          .filter(Boolean)
      )
    ];
    const report: BusinessReportRun = sanitizeRecord({
      title: 'Fidere 自动化测试报告',
      runId,
      flowId: mainCase?.caseId ?? 'UNKNOWN',
      flowName: mainCase?.name ?? '未识别Flow',
      environment: hostname.includes('sandbox')
        ? 'Sandbox'
        : hostname.includes('staging')
          ? 'Staging'
          : hostname === 'localhost' || hostname === '127.0.0.1'
            ? 'Local'
            : 'Test',
      hostname,
      startedAt: formatDateTime(this.startedAt),
      endedAt: formatDateTime(endedAt),
      finishedAt: formatDateTime(endedAt),
      durationMs: endedAt.getTime() - this.startedAt.getTime(),
      command: safeCommand(),
      projects,
      browsers,
      executionMode: process.env.CI ? 'CI' : '本地',
      summary,
      cases
    });
    const baseline = readAutomationBaseline(resolve('config/automation-baseline.json'));
    if (baseline) {
      report.baselineComparison = sanitizeRecord(compareRegressionWithBaseline(baseline, report));
    }
    const outputRoot = resolve('reports/business');
    const historyRoot = resolve(outputRoot, 'history');
    const html = renderBusinessReport(report);
    const json = JSON.stringify(report, null, 2);

    mkdirSync(historyRoot, { recursive: true });
    migrateLegacyHistory(historyRoot);
    const runDirectory = resolve(historyRoot, safeRunDirectoryName(runId));
    if (existsSync(runDirectory)) {
      throw new Error(`Business report history run already exists: ${runId}`);
    }
    mkdirSync(runDirectory);
    writeFileSync(resolve(runDirectory, 'report.html'), html, 'utf8');
    writeFileSync(resolve(runDirectory, 'report.json'), json, 'utf8');
    writeFileSync(resolve(outputRoot, 'latest.html'), html, 'utf8');
    writeFileSync(resolve(outputRoot, 'latest.json'), json, 'utf8');
    const historyIndex = writeHistoryIndex(historyRoot, endedAt);
    console.log(`Fidere中文业务报告：${resolve(outputRoot, 'latest.html')}`);
    console.log(`Fidere历史业务报告：${resolve(historyRoot, 'index.html')}（${historyIndex.total}次Run）`);
  }

  private buildCase(test: TestCase, result: TestResult): BusinessReportCase {
    const payload = parseBusinessPayload(result);
    const metadata = payload?.metadata ?? fallbackMetadata(test, result);
    const steps = payload?.steps ?? collectFallbackSteps(result.steps);
    const review = payload?.review ?? emptyReview();
    const blocked = result.annotations.some(annotation => annotation.type === 'blocker');
    if (result.annotations.some(annotation => annotation.type === 'manual-check')) {
      review.manualReviewRequired = true;
    }
    const oracles = payload?.oracles ?? [];
    const diagnostics = payload?.diagnostics ?? [];
    const warnings = payload?.warnings ?? [];
    const status = displayStatus(
      result.status,
      blocked,
      review.manualReviewRequired,
      oracles,
      warnings
    );
    const failedStep = steps.find(step => step.status === 'failed');
    const technicalError = safeErrorSummary(result.error?.message);

    return sanitizeRecord({
      caseId: metadata.caseId,
      flowId: metadata.flowId ?? findFlowDefinition(metadata.caseId)?.id ?? '未提供',
      module: metadata.module,
      name: metadata.name || cleanTitle(test.title),
      description: metadata.description ?? '未提供',
      priority: metadata.priority,
      level: metadata.level ?? annotationValue(result, 'level') ?? inferLevel(test),
      type: metadata.type.length > 0 ? metadata.type : ['未提供'],
      scope: metadata.scope,
      owner: metadata.owner ?? annotationValue(result, 'owner') ?? '未提供',
      requirement: metadata.requirement ?? annotationValue(result, 'requirement') ?? '未提供',
      tags: test.tags,
      preconditions: metadata.preconditions,
      target: metadata.target ?? '未提供',
      expectedResult: metadata.expectedResult,
      changesData: metadata.changesData,
      affectsMoney: metadata.affectsMoney,
      dependsOnAdmin: metadata.dependsOnAdmin,
      dependsOnThirdParty: metadata.dependsOnThirdParty,
      safetySwitches: metadata.safetySwitches ?? [],
      rawStatus: result.status,
      displayStatus: status.label,
      statusKey: status.key,
      businessOutcome: status.outcome,
      startedAt: formatDateTime(result.startTime),
      durationMs: result.duration,
      businessData: sanitizeBusinessData(payload?.businessData ?? {}),
      steps,
      oracles,
      diagnostics,
      warnings,
      failedStep: failedStep?.action ?? '无',
      failureSummary: failedStep?.actual ?? (result.error ? technicalError : '无'),
      failureExpected: failedStep?.expected ?? '未提供',
      failureActual: failedStep?.actual ?? (result.error ? technicalError : '未提供'),
      technicalError,
      review,
      evidence: evidenceFor(result)
    });
  }
}

export default FidereBusinessReporter;
