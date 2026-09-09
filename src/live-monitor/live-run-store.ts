import { EventEmitter } from 'node:events';

import type {
  LiveDocumentProgress,
  LiveEvent,
  LiveJourneyFlow,
  LiveRunStatus,
  LiveStepPlanItem,
  LiveStepStatus
} from './live-events';

export type LiveStepSnapshot = LiveStepPlanItem & {
  status: LiveStepStatus;
  actual: string;
  currentAction: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
};

export type LiveFailureSnapshot = {
  step: string;
  expected: string;
  actual: string;
  technicalError: string;
  currentUrl: string;
  mutationPerformed: boolean;
  resumeAllowed: boolean;
  freshRunAllowed: boolean;
};

export type LiveRunSnapshot = {
  schemaVersion: 1;
  sequence: number;
  runId: string;
  flowId: string;
  flowName: string;
  caseId: string;
  environment: string;
  startedAt: string;
  completedAt?: string;
  status: LiveRunStatus;
  resumeState: string;
  mutationPerformed: boolean;
  currentStepId?: string;
  steps: LiveStepSnapshot[];
  documents: LiveDocumentProgress[];
  businessData: Record<string, unknown>;
  failure?: LiveFailureSnapshot;
  journey?: {
    journeyId: string;
    journeyName: string;
    currentFlowId?: string;
    initialBalance?: string;
    currentBalance?: string;
    resumeFlow?: string;
    mutationCount: number;
    flows: LiveJourneyFlow[];
  };
  links: {
    businessReport: string;
    historyReport: string;
    playwrightReport: string;
  };
};

const emptySnapshot = (): LiveRunSnapshot => ({
  schemaVersion: 1,
  sequence: 0,
  runId: '',
  flowId: '',
  flowName: '等待Flow启动',
  caseId: '',
  environment: 'Unknown',
  startedAt: '',
  status: 'IDLE',
  resumeState: 'PREPARED',
  mutationPerformed: false,
  steps: [],
  documents: [],
  businessData: {},
  links: {
    businessReport: '/reports/business/latest',
    historyReport: '/reports/business/history/',
    playwrightReport: '/reports/playwright/'
  }
});

export class LiveRunStore {
  private state = emptySnapshot();
  private readonly emitter = new EventEmitter();

  snapshot(): LiveRunSnapshot {
    return structuredClone(this.state);
  }

  subscribe(listener: (snapshot: LiveRunSnapshot) => void): () => void {
    this.emitter.on('change', listener);
    return () => this.emitter.off('change', listener);
  }

  apply(event: LiveEvent): LiveRunSnapshot {
    if (this.state.runId && event.runId !== this.state.runId) return this.snapshot();
    this.state.sequence += 1;
    if (!this.state.runId) this.state.runId = event.runId;

    switch (event.type) {
      case 'RUN_STARTED': {
        const payload = event.payload as LiveEvent<'RUN_STARTED'>['payload'];
        this.state = {
          ...emptySnapshot(),
          sequence: this.state.sequence,
          runId: event.runId,
          flowId: payload.flowId,
          flowName: payload.flowName,
          caseId: payload.caseId,
          environment: payload.environment,
          startedAt: payload.startedAt,
          status: 'RUNNING',
          resumeState: payload.resumeState,
          mutationPerformed: payload.mutation
        };
        break;
      }
      case 'JOURNEY_STARTED': {
        const payload = event.payload as LiveEvent<'JOURNEY_STARTED'>['payload'];
        this.state.journey = {
          journeyId: payload.journeyId,
          journeyName: payload.journeyName,
          initialBalance: payload.initialBalance,
          currentBalance: payload.initialBalance,
          mutationCount: 0,
          flows: payload.flows.map(flow => ({ ...flow, status: 'PENDING' }))
        };
        break;
      }
      case 'JOURNEY_FLOW_STARTED': {
        const payload = event.payload as LiveEvent<'JOURNEY_FLOW_STARTED'>['payload'];
        const journey = this.state.journey;
        const flow = journey?.flows.find(candidate => candidate.id === payload.id);
        if (journey && flow) {
          journey.currentFlowId = payload.id;
          journey.resumeFlow = payload.id;
          flow.status = 'RUNNING';
        }
        break;
      }
      case 'JOURNEY_FLOW_FINISHED': {
        const payload = event.payload as LiveEvent<'JOURNEY_FLOW_FINISHED'>['payload'];
        const journey = this.state.journey;
        const flow = journey?.flows.find(candidate => candidate.id === payload.id);
        if (journey && flow) {
          flow.status = payload.status;
          flow.reason = payload.reason;
          journey.currentFlowId = undefined;
          journey.resumeFlow = payload.status === 'PASS' || payload.status === 'SKIPPED'
            ? undefined
            : payload.id;
        }
        break;
      }
      case 'JOURNEY_PROGRESS_UPDATED': {
        const payload = event.payload as LiveEvent<'JOURNEY_PROGRESS_UPDATED'>['payload'];
        const journey = this.state.journey;
        if (journey) {
          if (payload.currentBalance !== undefined) journey.currentBalance = payload.currentBalance;
          if (payload.resumeFlow !== undefined) journey.resumeFlow = payload.resumeFlow;
          if (payload.mutationCount !== undefined) journey.mutationCount = payload.mutationCount;
        }
        break;
      }
      case 'CASE_STARTED': {
        const payload = event.payload as LiveEvent<'CASE_STARTED'>['payload'];
        this.state.flowId = payload.flowId ?? this.state.flowId;
        this.state.flowName = payload.flowName;
        this.state.caseId = payload.caseId;
        this.state.environment = payload.environment ?? this.state.environment;
        this.state.startedAt ||= payload.startedAt;
        this.state.resumeState = payload.resumeState ?? this.state.resumeState;
        this.state.status = 'RUNNING';
        this.state.mutationPerformed ||= payload.mutation;
        break;
      }
      case 'STEP_PLAN_UPDATED': {
        const payload = event.payload as LiveEvent<'STEP_PLAN_UPDATED'>['payload'];
        const existing = new Map(this.state.steps.map(step => [step.id, step]));
        this.state.steps = payload.steps.map(step => existing.get(step.id) ?? {
          ...step,
          status: 'PENDING',
          actual: '等待执行',
          currentAction: ''
        });
        break;
      }
      case 'STEP_STARTED': {
        const payload = event.payload as LiveEvent<'STEP_STARTED'>['payload'];
        const step = this.upsertStep(payload);
        step.status = 'RUNNING';
        step.startedAt = payload.startedAt;
        step.currentAction = payload.currentAction ?? payload.action;
        step.actual = '执行中';
        this.state.currentStepId = payload.id;
        break;
      }
      case 'STEP_PROGRESS': {
        const payload = event.payload as LiveEvent<'STEP_PROGRESS'>['payload'];
        const step = this.state.steps.find(item => item.id === payload.id);
        if (step) {
          if (payload.actual) step.actual = payload.actual;
          if (payload.currentAction) step.currentAction = payload.currentAction;
        }
        break;
      }
      case 'STEP_PASSED': {
        const payload = event.payload as LiveEvent<'STEP_PASSED'>['payload'];
        const step = this.state.steps.find(item => item.id === payload.id);
        if (step) {
          step.status = 'PASS';
          step.actual = payload.actual;
          step.durationMs = payload.durationMs;
          step.completedAt = payload.completedAt;
        }
        this.state.currentStepId = undefined;
        break;
      }
      case 'STEP_FAILED': {
        const payload = event.payload as LiveEvent<'STEP_FAILED'>['payload'];
        const step = this.state.steps.find(item => item.id === payload.id);
        if (step) {
          step.status = payload.blocked ? 'BLOCKED' : 'FAIL';
          step.actual = payload.actual;
          step.error = payload.error;
          step.durationMs = payload.durationMs;
          step.completedAt = payload.completedAt;
        }
        this.state.currentStepId = payload.id;
        this.state.status = payload.blocked ? 'BLOCKED' : 'FAILED';
        this.state.failure = {
          step: step?.action ?? payload.id,
          expected: payload.expected,
          actual: payload.actual,
          technicalError: payload.error,
          currentUrl: payload.currentUrl ?? '未提供',
          mutationPerformed: payload.mutationPerformed,
          resumeAllowed: payload.resumeAllowed,
          freshRunAllowed: payload.freshRunAllowed
        };
        break;
      }
      case 'BUSINESS_DATA_UPDATED': {
        const payload = event.payload as LiveEvent<'BUSINESS_DATA_UPDATED'>['payload'];
        Object.assign(this.state.businessData, payload.data);
        break;
      }
      case 'DOCUMENT_PROGRESS_UPDATED': {
        const payload = event.payload as LiveEvent<'DOCUMENT_PROGRESS_UPDATED'>['payload'];
        const index = this.state.documents.findIndex(document => document.id === payload.id);
        if (index >= 0) this.state.documents[index] = payload;
        else this.state.documents.push(payload);
        break;
      }
      case 'RESUME_STATE_CHANGED': {
        const payload = event.payload as LiveEvent<'RESUME_STATE_CHANGED'>['payload'];
        this.state.resumeState = payload.state;
        break;
      }
      case 'MUTATION_PERFORMED':
        this.state.mutationPerformed = true;
        break;
      case 'CASE_FINISHED': {
        const payload = event.payload as LiveEvent<'CASE_FINISHED'>['payload'];
        const terminalFailure = this.state.status === 'FAILED' || this.state.status === 'BLOCKED';
        if (!terminalFailure) this.state.status = payload.status;
        this.state.completedAt = payload.completedAt;
        this.state.currentStepId = undefined;
        break;
      }
      case 'RUN_FINISHED': {
        const payload = event.payload as LiveEvent<'RUN_FINISHED'>['payload'];
        this.state.status = payload.status;
        this.state.completedAt = payload.completedAt;
        this.state.currentStepId = undefined;
        break;
      }
    }

    const snapshot = this.snapshot();
    this.emitter.emit('change', snapshot);
    return snapshot;
  }

  private upsertStep(plan: LiveStepPlanItem): LiveStepSnapshot {
    let step = this.state.steps.find(item => item.id === plan.id);
    if (!step) {
      step = {
        ...plan,
        status: 'PENDING',
        actual: '等待执行',
        currentAction: ''
      };
      this.state.steps.push(step);
      this.state.steps.sort((left, right) => left.order - right.order);
    }
    return step;
  }
}
