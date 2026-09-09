import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';

export const FLOW_STAGES = [
  'PREPARED',
  'DOCUMENTS_UPLOADED',
  'DOCUMENT_READY_TO_COMPLETE',
  'DOCUMENT_COMPLETE_ATTEMPTED',
  'DOCUMENT_SIGNED',
  'CLIENT_SUBMIT_ATTEMPTED',
  'CLIENT_FEE_CONFIRMATION_REQUIRED',
  'FEE_CONFIRMATION_ATTEMPTED',
  'SECURITY_KEY_VERIFICATION_ATTEMPTED',
  'FEE_CONFIRMED',
  'CLIENT_CREATED',
  'ADMIN_LOCATED',
  'FIDERE_APPROVAL_ATTEMPTED',
  'ADMIN_APPROVAL_CONFIRMATION_REQUIRED',
  'ADMIN_APPROVAL_SUBMISSION_ATTEMPTED',
  'FIDERE_APPROVED',
  'ADMIN_ACTION_DONE',
  'BAAS_SUBMITTED',
  'BAAS_PENDING',
  'BAAS_FAILED',
  'BAAS_APPROVED',
  'CLIENT_FINALIZED',
  'COMPLETED'
] as const;

export type FlowStage = (typeof FLOW_STAGES)[number];

export type FlowResumeState = {
  schemaVersion: 1;
  runId: string;
  flowId: string;
  clientReference?: string;
  adminReference?: string;
  amount?: string;
  currency?: string;
  preparedAt: string;
  updatedAt: string;
  clientSubmittedAt?: string;
  feeConfirmationOpenedAt?: string;
  feeConfirmedAt?: string;
  stage: FlowStage;
};

function assertSafeId(label: string, value: string): void {
  if (!/^[A-Z0-9._-]+$/i.test(value)) {
    throw new Error(`${label} contains unsupported path or identifier characters.`);
  }
}

function assertFlowStage(value: string): asserts value is FlowStage {
  if (!(FLOW_STAGES as readonly string[]).includes(value)) {
    throw new Error(`Unsupported Flow stage: ${value}.`);
  }
}

export function stageIndex(stage: FlowStage): number {
  return FLOW_STAGES.indexOf(stage);
}

export function requiresResume(state: FlowResumeState): boolean {
  return (
    stageIndex(state.stage) >= stageIndex('CLIENT_FEE_CONFIRMATION_REQUIRED') &&
    state.stage !== 'COMPLETED'
  );
}

export function assertFreshExecutionAllowed(state: FlowResumeState | undefined): void {
  if (state && requiresResume(state)) {
    throw new Error(
      `${state.flowId} already reached ${state.stage}; resume the existing business instead of creating another one.`
    );
  }
}

export function createPreparedFlowState(input: {
  runId: string;
  flowId: string;
  amount?: string;
  currency?: string;
  now?: Date;
}): FlowResumeState {
  const now = (input.now ?? new Date()).toISOString();
  return {
    schemaVersion: 1,
    runId: input.runId,
    flowId: input.flowId,
    amount: input.amount,
    currency: input.currency,
    preparedAt: now,
    updatedAt: now,
    stage: 'PREPARED'
  };
}

export function advanceFlowState(
  current: FlowResumeState,
  nextStage: FlowStage,
  updates: Pick<
    FlowResumeState,
    | 'clientReference'
    | 'adminReference'
    | 'clientSubmittedAt'
    | 'feeConfirmationOpenedAt'
    | 'feeConfirmedAt'
  > = {},
  now = new Date()
): FlowResumeState {
  if (stageIndex(nextStage) <= stageIndex(current.stage)) {
    throw new Error(`Flow state must advance beyond ${current.stage}; received ${nextStage}.`);
  }
  if (
    stageIndex(nextStage) >= stageIndex('ADMIN_LOCATED') &&
    !(updates.clientReference ?? current.clientReference)
  ) {
    throw new Error('ADMIN_LOCATED and later stages require a real business reference.');
  }

  return {
    ...current,
    ...updates,
    updatedAt: now.toISOString(),
    stage: nextStage
  };
}

export class FlowStateStore {
  constructor(private readonly rootDirectory = resolve('.flow-state')) {}

  pathFor(flowId: string, runId: string): string {
    assertSafeId('flowId', flowId);
    assertSafeId('runId', runId);
    return resolve(this.rootDirectory, flowId, `${runId}.json`);
  }

  load(flowId: string, runId: string): FlowResumeState | undefined {
    const filePath = this.pathFor(flowId, runId);
    if (!existsSync(filePath)) return undefined;
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<FlowResumeState>;
    return this.validate(parsed, flowId, runId);
  }

  list(flowId: string): FlowResumeState[] {
    assertSafeId('flowId', flowId);
    const directory = resolve(this.rootDirectory, flowId);
    if (!existsSync(directory)) return [];

    return readdirSync(directory)
      .filter(fileName => fileName.endsWith('.json'))
      .map(fileName => this.load(flowId, fileName.slice(0, -'.json'.length)))
      .filter((state): state is FlowResumeState => state !== undefined);
  }

  save(state: FlowResumeState): string {
    const validated = this.validate(state, state.flowId, state.runId);
    const existing = this.load(state.flowId, state.runId);
    if (existing && stageIndex(validated.stage) < stageIndex(existing.stage)) {
      throw new Error(
        `Flow state cannot move backwards from ${existing.stage} to ${validated.stage}.`
      );
    }

    const filePath = this.pathFor(state.flowId, state.runId);
    mkdirSync(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(validated, null, 2), 'utf8');
    renameSync(temporaryPath, filePath);
    return filePath;
  }

  private validate(
    input: Partial<FlowResumeState>,
    expectedFlowId: string,
    expectedRunId: string
  ): FlowResumeState {
    if (input.schemaVersion !== 1) throw new Error('Unsupported Flow state schemaVersion.');
    if (input.flowId !== expectedFlowId || input.runId !== expectedRunId) {
      throw new Error('Flow state identity does not match the requested flowId/runId.');
    }
    if (!input.preparedAt || !input.updatedAt || !input.stage) {
      throw new Error('Flow state is missing required timestamps or stage.');
    }
    assertSafeId('flowId', input.flowId);
    assertSafeId('runId', input.runId);
    assertFlowStage(input.stage);

    return {
      schemaVersion: 1,
      runId: input.runId,
      flowId: input.flowId,
      clientReference: input.clientReference,
      adminReference: input.adminReference,
      amount: input.amount,
      currency: input.currency,
      preparedAt: input.preparedAt,
      updatedAt: input.updatedAt,
      clientSubmittedAt: input.clientSubmittedAt,
      feeConfirmationOpenedAt: input.feeConfirmationOpenedAt,
      feeConfirmedAt: input.feeConfirmedAt,
      stage: input.stage
    };
  }
}
