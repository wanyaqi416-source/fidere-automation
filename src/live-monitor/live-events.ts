export const LIVE_EVENT_TYPES = [
  'RUN_STARTED',
  'JOURNEY_STARTED',
  'JOURNEY_FLOW_STARTED',
  'JOURNEY_FLOW_FINISHED',
  'JOURNEY_PROGRESS_UPDATED',
  'CASE_STARTED',
  'STEP_PLAN_UPDATED',
  'STEP_STARTED',
  'STEP_PROGRESS',
  'STEP_PASSED',
  'STEP_FAILED',
  'BUSINESS_DATA_UPDATED',
  'DOCUMENT_PROGRESS_UPDATED',
  'RESUME_STATE_CHANGED',
  'MUTATION_PERFORMED',
  'CASE_FINISHED',
  'RUN_FINISHED'
] as const;

export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];
export type LiveRunStatus = 'IDLE' | 'RUNNING' | 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED';
export type LiveStepStatus = 'PENDING' | 'RUNNING' | 'PASS' | 'FAIL' | 'BLOCKED' | 'SKIPPED';
export type LiveDocumentStatus = 'PENDING' | 'RUNNING' | 'PASS' | 'FAIL' | 'SKIPPED';
export type LiveJourneyFlowStatus = 'PENDING' | 'RUNNING' | 'PASS' | 'FAIL' | 'BLOCKED' | 'SKIPPED';

export type LiveJourneyFlow = {
  id: string;
  name: string;
  status: LiveJourneyFlowStatus;
  reason?: string;
};

export type LiveStepPlanItem = {
  id: string;
  order: number;
  action: string;
  expected: string;
};

export type LiveDocumentProgress = {
  id: string;
  field: string;
  file: string;
  status: LiveDocumentStatus;
  actual?: string;
};

export type LiveEventPayloadMap = {
  RUN_STARTED: {
    flowId: string;
    flowName: string;
    caseId: string;
    environment: string;
    startedAt: string;
    resumeState: string;
    mutation: boolean;
  };
  JOURNEY_STARTED: {
    journeyId: string;
    journeyName: string;
    flows: Array<Pick<LiveJourneyFlow, 'id' | 'name'>>;
    initialBalance?: string;
  };
  JOURNEY_FLOW_STARTED: {
    id: string;
    startedAt: string;
  };
  JOURNEY_FLOW_FINISHED: {
    id: string;
    status: Exclude<LiveJourneyFlowStatus, 'PENDING' | 'RUNNING'>;
    reason?: string;
    completedAt: string;
  };
  JOURNEY_PROGRESS_UPDATED: {
    currentBalance?: string;
    resumeFlow?: string;
    mutationCount?: number;
  };
  CASE_STARTED: {
    flowId?: string;
    flowName: string;
    caseId: string;
    environment?: string;
    startedAt: string;
    resumeState?: string;
    mutation: boolean;
  };
  STEP_PLAN_UPDATED: { steps: LiveStepPlanItem[] };
  STEP_STARTED: LiveStepPlanItem & { startedAt: string; currentAction?: string };
  STEP_PROGRESS: { id: string; actual?: string; currentAction?: string; elapsedMs?: number };
  STEP_PASSED: { id: string; actual: string; durationMs: number; completedAt: string };
  STEP_FAILED: {
    id: string;
    actual: string;
    expected: string;
    error: string;
    durationMs: number;
    completedAt: string;
    currentUrl?: string;
    blocked?: boolean;
    mutationPerformed: boolean;
    resumeAllowed: boolean;
    freshRunAllowed: boolean;
  };
  BUSINESS_DATA_UPDATED: { data: Record<string, unknown> };
  DOCUMENT_PROGRESS_UPDATED: LiveDocumentProgress;
  RESUME_STATE_CHANGED: { state: string };
  MUTATION_PERFORMED: { action: string; occurredAt: string };
  CASE_FINISHED: { status: LiveRunStatus; completedAt: string; durationMs: number };
  RUN_FINISHED: {
    status: LiveRunStatus;
    completedAt: string;
    durationMs: number;
    exitCode: number;
  };
};

export type LiveEvent<T extends LiveEventType = LiveEventType> = {
  schemaVersion: 1;
  runId: string;
  type: T;
  timestamp: string;
  payload: LiveEventPayloadMap[T];
};

export function createLiveEvent<T extends LiveEventType>(
  runId: string,
  type: T,
  payload: LiveEventPayloadMap[T],
  now = new Date()
): LiveEvent<T> {
  return {
    schemaVersion: 1,
    runId,
    type,
    timestamp: now.toISOString(),
    payload
  };
}

export function isLiveEvent(value: unknown): value is LiveEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<LiveEvent>;
  return (
    event.schemaVersion === 1 &&
    typeof event.runId === 'string' &&
    event.runId.length > 0 &&
    typeof event.timestamp === 'string' &&
    typeof event.type === 'string' &&
    (LIVE_EVENT_TYPES as readonly string[]).includes(event.type) &&
    Boolean(event.payload && typeof event.payload === 'object')
  );
}
