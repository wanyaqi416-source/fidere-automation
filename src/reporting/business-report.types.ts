export type BusinessCaseMetadata = {
  flowId?: string;
  caseId: string;
  module: string;
  name: string;
  description?: string;
  priority: string;
  level?: string;
  type: string[];
  scope: string;
  owner?: string;
  requirement?: string;
  preconditions: string[];
  target?: string;
  expectedResult: string;
  changesData: boolean;
  affectsMoney: boolean;
  dependsOnAdmin: boolean;
  dependsOnThirdParty: boolean;
  safetySwitches?: string[];
};

export type BusinessStepDefinition = {
  action: string;
  expected: string;
};

export type BusinessDocumentProgressInput = {
  id: string;
  field: string;
  file: string;
  status: 'PENDING' | 'RUNNING' | 'PASS' | 'FAIL' | 'SKIPPED';
  actual?: string;
};

export type BusinessStepStatus = 'passed' | 'warning' | 'failed';

export type BusinessStepRecord = BusinessStepDefinition & {
  actual: string;
  status: BusinessStepStatus;
  durationMs: number;
  error?: string;
};

export type BusinessReviewState = {
  manualReviewRequired: boolean;
  potentiallySubmitted: boolean;
  duplicateSubmissionRisk: boolean;
  safeToRerun: boolean;
  reviewLocation?: string;
};

export type BusinessOracleLevel = 'primary' | 'secondary';

export type BusinessOracleStatus = 'passed' | 'failed';

export type BusinessOracleInput = {
  id: string;
  name: string;
  expected: string;
  actual: string;
  status: BusinessOracleStatus;
};

export type BusinessOracleRecord = BusinessOracleInput & {
  level: BusinessOracleLevel;
};

export type BusinessDiagnosticStatus = 'available' | 'unavailable' | 'info';

export type BusinessDiagnosticInput = {
  id: string;
  name: string;
  status: BusinessDiagnosticStatus;
  summary: string;
  reason?: string;
  affectsCoreBusiness: false;
};

export type BusinessOutcome =
  | 'PASS'
  | 'PASS_WITH_WARNING'
  | 'FAIL'
  | 'MANUAL_REVIEW'
  | 'BLOCKED'
  | 'NOT_RUN';

export type BusinessReportPayload = {
  schemaVersion: 1;
  metadata: BusinessCaseMetadata;
  businessData: Record<string, unknown>;
  steps: BusinessStepRecord[];
  oracles?: BusinessOracleRecord[];
  diagnostics?: BusinessDiagnosticInput[];
  warnings?: string[];
  review: BusinessReviewState;
};

export type BusinessStepContext = {
  setActual(actual: string): void;
  setCurrentAction(action: string): void;
  setBusinessData(data: Record<string, unknown>): void;
  setDocumentProgress(document: BusinessDocumentProgressInput): void;
  requireManualReview(location?: string): void;
  markPotentiallySubmitted(): void;
  markDuplicateSubmissionRisk(): void;
  disallowSafeRerun(): void;
  warn(message: string): void;
  recordPrimaryOracle(oracle: BusinessOracleInput): void;
  recordSecondaryOracle(oracle: BusinessOracleInput): void;
  recordDiagnostic(diagnostic: BusinessDiagnosticInput): void;
};

export type BusinessReportApi = {
  flow(flowId: string, overrides?: Partial<BusinessCaseMetadata>): void;
  case(metadata: BusinessCaseMetadata): void;
  plan(steps: readonly BusinessStepDefinition[]): void;
  step<T>(
    definition: BusinessStepDefinition,
    body: (context: BusinessStepContext) => Promise<T>
  ): Promise<T>;
  setBusinessData(data: Record<string, unknown>): void;
  setCurrentUrl(url: string): void;
  setResumeState(state: string): void;
  setDocumentProgress(document: BusinessDocumentProgressInput): void;
  markMutationPerformed(action: string): void;
  requireManualReview(location?: string): void;
  markPotentiallySubmitted(): void;
  markDuplicateSubmissionRisk(): void;
  disallowSafeRerun(): void;
  warn(message: string): void;
  recordPrimaryOracle(oracle: BusinessOracleInput): void;
  recordSecondaryOracle(oracle: BusinessOracleInput): void;
  recordDiagnostic(diagnostic: BusinessDiagnosticInput): void;
};

export type BusinessEvidence = {
  label: string;
  displayPath?: string;
  href?: string;
  warning?: string;
};

export type BusinessReportCase = {
  flowId: string;
  caseId: string;
  module: string;
  name: string;
  description: string;
  priority: string;
  level: string;
  type: string[];
  scope: string;
  owner: string;
  requirement: string;
  tags: string[];
  preconditions: string[];
  target: string;
  expectedResult: string;
  changesData: boolean;
  affectsMoney: boolean;
  dependsOnAdmin: boolean;
  dependsOnThirdParty: boolean;
  safetySwitches: string[];
  rawStatus: string;
  displayStatus: string;
  statusKey: string;
  businessOutcome: BusinessOutcome;
  startedAt: string;
  durationMs: number;
  businessData: Record<string, unknown>;
  steps: BusinessStepRecord[];
  oracles: BusinessOracleRecord[];
  diagnostics: BusinessDiagnosticInput[];
  warnings: string[];
  failedStep: string;
  failureSummary: string;
  failureExpected: string;
  failureActual: string;
  technicalError: string;
  review: BusinessReviewState;
  evidence: BusinessEvidence[];
};

export type BusinessReportRun = {
  title: string;
  runId: string;
  flowId: string;
  flowName: string;
  environment: string;
  hostname: string;
  startedAt: string;
  endedAt: string;
  finishedAt: string;
  durationMs: number;
  command: string;
  projects: string[];
  browsers: string[];
  executionMode: string;
  summary: {
    total: number;
    passed: number;
    passedWithWarning: number;
    failed: number;
    skipped: number;
    blocked: number;
    timedOut: number;
    interrupted: number;
    manualReview: number;
    passRate: number;
  };
  baselineComparison?: RegressionBaselineComparison;
  cases: BusinessReportCase[];
};

export type BaselineCaseDelta = {
  key: string;
  caseId: string;
  name: string;
  baselineOutcome?: BusinessOutcome;
  currentOutcome?: BusinessOutcome;
};

export type RegressionBaselineComparison = {
  applicable: boolean;
  baselineVersion: string;
  baselineRunId: string;
  currentRunId: string;
  baselineTotal: number;
  currentTotal: number;
  totalDelta: number;
  addedTests: BaselineCaseDelta[];
  removedTests: BaselineCaseDelta[];
  newPasses: BaselineCaseDelta[];
  newFailures: BaselineCaseDelta[];
  newWarnings: BaselineCaseDelta[];
  knownWarnings: BaselineCaseDelta[];
  regressions: BaselineCaseDelta[];
  recovered: BaselineCaseDelta[];
  matchesBaseline: boolean;
  hasNewRegression: boolean;
  message: string;
};
