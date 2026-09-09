import { test, type TestInfo } from '@playwright/test';

import {
  type BusinessCaseMetadata,
  type BusinessDiagnosticInput,
  type BusinessDocumentProgressInput,
  type BusinessOracleInput,
  type BusinessOracleLevel,
  type BusinessOracleRecord,
  type BusinessReportApi,
  type BusinessReportPayload,
  type BusinessReviewState,
  type BusinessStepContext,
  type BusinessStepDefinition,
  type BusinessStepRecord
} from './business-report.types';
import { maskSensitiveText, sanitizeBusinessData, sanitizeRecord } from './sensitive-data-mask';
import { metadataForFlow } from './flow-definition-metadata';
import { LiveMonitorClient, type LiveStepPlanItem } from '../live-monitor';

class BusinessReportContext implements BusinessReportApi {
  private metadata?: BusinessCaseMetadata;
  private readonly businessData: Record<string, unknown> = {};
  private readonly steps: BusinessStepRecord[] = [];
  private readonly oracles: BusinessOracleRecord[] = [];
  private readonly diagnostics: BusinessDiagnosticInput[] = [];
  private readonly warnings: string[] = [];
  private readonly live = LiveMonitorClient.fromEnvironment();
  private livePlan: LiveStepPlanItem[] = [];
  private liveStepCursor = 0;
  private currentLiveUrl = '';
  private mutationPerformed = false;
  private readonly caseStartedAt = Date.now();
  private readonly review: BusinessReviewState = {
    manualReviewRequired: false,
    potentiallySubmitted: false,
    duplicateSubmissionRisk: false,
    safeToRerun: true
  };

  constructor(private readonly testInfo: TestInfo) {}

  flow(flowId: string, overrides: Partial<BusinessCaseMetadata> = {}): void {
    this.case(metadataForFlow(flowId, overrides));
  }

  case(metadata: BusinessCaseMetadata): void {
    this.metadata = sanitizeRecord(metadata);
    this.ensureAnnotation('caseId', metadata.caseId);
    if (metadata.flowId) this.ensureAnnotation('flowId', metadata.flowId);
    this.ensureAnnotation('module', metadata.module);
    this.ensureAnnotation('priority', metadata.priority);
    if (metadata.level) this.ensureAnnotation('level', metadata.level);
    this.ensureAnnotation('type', metadata.type.join(' / '));
    this.ensureAnnotation('changesData', metadata.changesData ? 'true' : 'false');
    this.ensureAnnotation('affectsMoney', metadata.affectsMoney ? 'true' : 'false');
    this.live.emit('CASE_STARTED', {
      flowId: metadata.flowId,
      flowName: maskSensitiveText(metadata.name),
      caseId: maskSensitiveText(metadata.caseId),
      environment: this.liveEnvironment(),
      startedAt: new Date(this.caseStartedAt).toISOString(),
      resumeState: 'PREPARED',
      mutation: false
    });
  }

  plan(steps: readonly BusinessStepDefinition[]): void {
    this.livePlan = steps.map((step, index) => ({
      id: `step-${String(index + 1).padStart(3, '0')}`,
      order: index + 1,
      action: maskSensitiveText(step.action),
      expected: maskSensitiveText(step.expected)
    }));
    this.live.emit('STEP_PLAN_UPDATED', { steps: this.livePlan });
  }

  async step<T>(
    definition: BusinessStepDefinition,
    body: (context: BusinessStepContext) => Promise<T>
  ): Promise<T> {
    return test.step(definition.action, async () => {
      const startedAt = Date.now();
      const liveStep = this.resolveLiveStep(definition);
      let actual = '未提供';
      let hasWarning = false;
      this.live.emit('STEP_STARTED', {
        ...liveStep,
        startedAt: new Date(startedAt).toISOString(),
        currentAction: liveStep.action
      });
      const context: BusinessStepContext = {
        setActual: value => {
          actual = maskSensitiveText(value);
          this.live.emit('STEP_PROGRESS', { id: liveStep.id, actual });
        },
        setCurrentAction: action => this.live.emit('STEP_PROGRESS', {
          id: liveStep.id,
          currentAction: maskSensitiveText(action),
          elapsedMs: Date.now() - startedAt
        }),
        setBusinessData: data => this.setBusinessData(data),
        setDocumentProgress: document => this.setDocumentProgress(document),
        requireManualReview: location => this.requireManualReview(location),
        markPotentiallySubmitted: () => this.markPotentiallySubmitted(),
        markDuplicateSubmissionRisk: () => this.markDuplicateSubmissionRisk(),
        disallowSafeRerun: () => this.disallowSafeRerun(),
        warn: message => {
          hasWarning = true;
          this.warn(message);
        },
        recordPrimaryOracle: oracle => this.recordOracle('primary', oracle),
        recordSecondaryOracle: oracle => this.recordOracle('secondary', oracle),
        recordDiagnostic: diagnostic => this.recordDiagnostic(diagnostic)
      };

      try {
        const result = await body(context);
        const durationMs = Date.now() - startedAt;
        this.steps.push({
          action: maskSensitiveText(definition.action),
          expected: maskSensitiveText(definition.expected),
          actual,
          status: hasWarning ? 'warning' : 'passed',
          durationMs
        });
        this.live.emit('STEP_PASSED', {
          id: liveStep.id,
          actual,
          durationMs,
          completedAt: new Date().toISOString()
        });
        this.liveStepCursor = Math.max(this.liveStepCursor, liveStep.order);
        return result;
      } catch (error) {
        const errorMessage = maskSensitiveText(
          error instanceof Error ? error.message : String(error)
        );
        const failureActual = actual === '未提供' ? errorMessage : actual;
        const durationMs = Date.now() - startedAt;
        this.steps.push({
          action: maskSensitiveText(definition.action),
          expected: maskSensitiveText(definition.expected),
          actual: failureActual,
          status: 'failed',
          durationMs,
          error: errorMessage
        });
        const blocked = this.testInfo.annotations.some(annotation => annotation.type === 'blocker');
        this.live.emit('STEP_FAILED', {
          id: liveStep.id,
          actual: failureActual,
          expected: maskSensitiveText(definition.expected),
          error: errorMessage,
          durationMs,
          completedAt: new Date().toISOString(),
          currentUrl: this.currentLiveUrl || undefined,
          blocked,
          mutationPerformed: this.mutationPerformed,
          resumeAllowed: this.mutationPerformed || this.review.potentiallySubmitted,
          freshRunAllowed: !this.mutationPerformed && this.review.safeToRerun
        });

        throw new Error(
          `${definition.action}失败：\n预期：${definition.expected}\n实际：${failureActual}\n业务步骤已停止，原始错误保留在技术详情中。`,
          { cause: error }
        );
      }
    });
  }

  setBusinessData(data: Record<string, unknown>): void {
    const sanitized = sanitizeBusinessData(data);
    Object.assign(this.businessData, sanitized);
    this.live.emit('BUSINESS_DATA_UPDATED', { data: sanitized });
    const resumeState = sanitized.resumeStage ?? sanitized.registrationStage;
    if (typeof resumeState === 'string') this.setResumeState(resumeState);
  }

  setCurrentUrl(url: string): void {
    try {
      const parsed = new URL(url);
      parsed.search = '';
      parsed.hash = '';
      this.currentLiveUrl = parsed.toString();
    } catch {
      this.currentLiveUrl = '';
    }
  }

  setResumeState(state: string): void {
    this.live.emit('RESUME_STATE_CHANGED', { state: maskSensitiveText(state) });
  }

  setDocumentProgress(document: BusinessDocumentProgressInput): void {
    const normalizedFile = document.file.replace(/\\/g, '/');
    const testAssetIndex = normalizedFile.indexOf('test-assets/');
    const file = testAssetIndex >= 0
      ? normalizedFile.slice(testAssetIndex)
      : normalizedFile.split('/').at(-1) ?? '未提供';
    this.live.emit('DOCUMENT_PROGRESS_UPDATED', {
      id: maskSensitiveText(document.id),
      field: maskSensitiveText(document.field),
      file: maskSensitiveText(file),
      status: document.status,
      actual: document.actual ? maskSensitiveText(document.actual) : undefined
    });
  }

  markMutationPerformed(action: string): void {
    if (this.mutationPerformed) return;
    this.mutationPerformed = true;
    this.live.emit('MUTATION_PERFORMED', {
      action: maskSensitiveText(action),
      occurredAt: new Date().toISOString()
    });
  }

  requireManualReview(location?: string): void {
    this.review.manualReviewRequired = true;
    if (location) {
      this.review.reviewLocation = maskSensitiveText(location);
    }
  }

  markPotentiallySubmitted(): void {
    this.review.potentiallySubmitted = true;
    this.markMutationPerformed('Client提交已进入不可逆边界');
  }

  markDuplicateSubmissionRisk(): void {
    this.review.duplicateSubmissionRisk = true;
  }

  disallowSafeRerun(): void {
    this.review.safeToRerun = false;
  }

  warn(message: string): void {
    this.warnings.push(maskSensitiveText(message));
  }

  recordPrimaryOracle(oracle: BusinessOracleInput): void {
    this.recordOracle('primary', oracle);
  }

  recordSecondaryOracle(oracle: BusinessOracleInput): void {
    this.recordOracle('secondary', oracle);
  }

  recordDiagnostic(diagnostic: BusinessDiagnosticInput): void {
    const sanitized = sanitizeRecord(diagnostic);
    const existingIndex = this.diagnostics.findIndex(item => item.id === sanitized.id);
    if (existingIndex >= 0) {
      this.diagnostics[existingIndex] = sanitized;
      return;
    }
    this.diagnostics.push(sanitized);
  }

  async finalize(): Promise<void> {
    if (!this.metadata) {
      return;
    }

    const payload: BusinessReportPayload = {
      schemaVersion: 1,
      metadata: this.metadata,
      businessData: sanitizeBusinessData(this.businessData),
      steps: sanitizeRecord(this.steps),
      oracles: sanitizeRecord(this.oracles),
      diagnostics: sanitizeRecord(this.diagnostics),
      warnings: sanitizeRecord(this.warnings),
      review: sanitizeRecord(this.review)
    };

    try {
      await this.testInfo.attach('fidere-business-report.json', {
        body: Buffer.from(JSON.stringify(payload, null, 2)),
        contentType: 'application/json'
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Fidere业务报告附件生成失败：${maskSensitiveText(message)}`);
    }

    const blocked = this.testInfo.annotations.some(annotation => annotation.type === 'blocker');
    const status = blocked
      ? 'BLOCKED'
      : this.testInfo.status === 'passed'
        ? 'PASSED'
        : this.testInfo.status === 'skipped'
          ? 'SKIPPED'
          : 'FAILED';
    this.live.emit('CASE_FINISHED', {
      status,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - this.caseStartedAt
    });
    await this.live.flush();
  }

  private ensureAnnotation(type: string, description: string): void {
    if (!this.testInfo.annotations.some(annotation => annotation.type === type)) {
      this.testInfo.annotations.push({ type, description: maskSensitiveText(description) });
    }
  }

  private recordOracle(level: BusinessOracleLevel, oracle: BusinessOracleInput): void {
    const sanitized = sanitizeRecord({ ...oracle, level });
    const existingIndex = this.oracles.findIndex(item => item.id === sanitized.id);

    if (existingIndex >= 0) {
      this.oracles[existingIndex] = sanitized;
      return;
    }

    this.oracles.push(sanitized);
  }

  private resolveLiveStep(definition: BusinessStepDefinition): LiveStepPlanItem {
    const expectedAction = maskSensitiveText(definition.action);
    const planned = this.livePlan.find(
      item => item.order > this.liveStepCursor && item.action === expectedAction
    );
    if (planned) return planned;
    const order = Math.max(this.liveStepCursor + 1, this.livePlan.length + 1);
    const dynamic = {
      id: `step-${String(order).padStart(3, '0')}`,
      order,
      action: expectedAction,
      expected: maskSensitiveText(definition.expected)
    };
    this.livePlan.push(dynamic);
    this.live.emit('STEP_PLAN_UPDATED', { steps: this.livePlan });
    return dynamic;
  }

  private liveEnvironment(): string {
    const host = process.env.CLIENT_BASE_URL ?? process.env.ADMIN_BASE_URL ?? '';
    if (/sandbox|\.test/i.test(host)) return 'Sandbox';
    if (/staging/i.test(host)) return 'Staging';
    if (/localhost|127\.0\.0\.1/i.test(host)) return 'Local';
    return 'Test';
  }
}

export function createBusinessReportContext(testInfo: TestInfo): BusinessReportContext {
  return new BusinessReportContext(testInfo);
}
