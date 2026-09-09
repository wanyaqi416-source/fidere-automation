import type { BusinessFlowDefinition } from './definition';
import { FlowEngine, type FlowLifecycleEvent } from './lifecycle';
import { requireExactlyOneCandidate } from './candidate-matcher';
import type { FlowStage } from './resume-state';

export type ApprovalFlowRuntime<
  TBefore,
  TSubmission,
  TClientReference,
  TAdminCandidate,
  TFinalState,
  TAfter
> = {
  definition: BusinessFlowDefinition;
  runId: string;
  beforeState?: TBefore;
  submission?: TSubmission;
  clientReference?: TClientReference;
  adminCandidates: TAdminCandidate[];
  adminCandidate?: TAdminCandidate;
  finalState?: TFinalState;
  afterState?: TAfter;
};

export type ClientAdminApprovalHooks<
  TBefore,
  TSubmission,
  TClientReference,
  TAdminCandidate,
  TFinalState,
  TAfter
> = {
  preflight(): Promise<void>;
  captureBeforeState(): Promise<TBefore>;
  clientSubmit(): Promise<TSubmission>;
  captureClientReference(submission: TSubmission): Promise<TClientReference>;
  adminLocate(clientReference: TClientReference): Promise<TAdminCandidate[]>;
  adminVerify(candidate: TAdminCandidate): Promise<void>;
  adminAction(candidate: TAdminCandidate, action: BusinessFlowDefinition['adminAction']): Promise<void>;
  clientWaitFinalState(clientReference: TClientReference): Promise<TFinalState>;
  captureAfterState(): Promise<TAfter>;
  primaryOracle(runtime: ApprovalFlowRuntime<TBefore, TSubmission, TClientReference, TAdminCandidate, TFinalState, TAfter>): Promise<void>;
  secondaryOracle(runtime: ApprovalFlowRuntime<TBefore, TSubmission, TClientReference, TAdminCandidate, TFinalState, TAfter>): Promise<void>;
  report(runtime: ApprovalFlowRuntime<TBefore, TSubmission, TClientReference, TAdminCandidate, TFinalState, TAfter>): Promise<void>;
};

export type ApprovalResumeInput<TBefore, TClientReference> = {
  runId: string;
  stage: Exclude<FlowStage, 'PREPARED'>;
  clientReference: TClientReference;
  beforeState?: TBefore;
};

export class ClientAdminApprovalFlow<
  TBefore,
  TSubmission,
  TClientReference,
  TAdminCandidate,
  TFinalState,
  TAfter
> {
  constructor(
    readonly definition: BusinessFlowDefinition,
    private readonly hooks: ClientAdminApprovalHooks<
      TBefore,
      TSubmission,
      TClientReference,
      TAdminCandidate,
      TFinalState,
      TAfter
    >
  ) {
    if (!definition.requiresClient || !definition.requiresAdmin) {
      throw new Error('ClientAdminApprovalFlow requires both Client and Admin in its Definition.');
    }
    if (definition.adminAction === 'None') {
      throw new Error('ClientAdminApprovalFlow requires Approve, Reject, or Claim action.');
    }
  }

  async execute(runId: string): Promise<{ runtime: ApprovalFlowRuntime<TBefore, TSubmission, TClientReference, TAdminCandidate, TFinalState, TAfter>; events: FlowLifecycleEvent[] }> {
    return this.executeInternal({ runId });
  }

  async resume(
    input: ApprovalResumeInput<TBefore, TClientReference>
  ): Promise<{ runtime: ApprovalFlowRuntime<TBefore, TSubmission, TClientReference, TAdminCandidate, TFinalState, TAfter>; events: FlowLifecycleEvent[] }> {
    if (!this.definition.supportsResume) {
      throw new Error(`${this.definition.name} does not support Resume.`);
    }
    return this.executeInternal(input);
  }

  private async executeInternal(
    input: { runId: string } | ApprovalResumeInput<TBefore, TClientReference>
  ): Promise<{ runtime: ApprovalFlowRuntime<TBefore, TSubmission, TClientReference, TAdminCandidate, TFinalState, TAfter>; events: FlowLifecycleEvent[] }> {
    const runtime: ApprovalFlowRuntime<
      TBefore,
      TSubmission,
      TClientReference,
      TAdminCandidate,
      TFinalState,
      TAfter
    > = {
      definition: this.definition,
      runId: input.runId,
      adminCandidates: [],
      ...('stage' in input
        ? { beforeState: input.beforeState, clientReference: input.clientReference }
        : {})
    };

    const engine = new FlowEngine<typeof runtime>({
      preflight: async () => this.hooks.preflight(),
      captureBeforeState: async context => {
        context.beforeState = await this.hooks.captureBeforeState();
      },
      clientSubmit: async context => {
        context.submission = await this.hooks.clientSubmit();
      },
      captureClientReference: async context => {
        if (context.submission === undefined) throw new Error('Client submission evidence is missing.');
        context.clientReference = await this.hooks.captureClientReference(context.submission);
      },
      adminLocate: async context => {
        if (context.clientReference === undefined) throw new Error('Client reference is missing.');
        context.adminCandidates = await this.hooks.adminLocate(context.clientReference);
        context.adminCandidate = requireExactlyOneCandidate(
          context.adminCandidates,
          this.definition.name
        );
      },
      adminVerify: async context => {
        if (context.adminCandidate === undefined) throw new Error('Admin candidate is missing.');
        await this.hooks.adminVerify(context.adminCandidate);
      },
      adminAction: async context => {
        if (context.adminCandidate === undefined) throw new Error('Admin candidate is missing.');
        await this.hooks.adminAction(context.adminCandidate, this.definition.adminAction);
      },
      clientWaitFinalState: async context => {
        if (context.clientReference === undefined) throw new Error('Client reference is missing.');
        context.finalState = await this.hooks.clientWaitFinalState(context.clientReference);
      },
      captureAfterState: async context => {
        context.afterState = await this.hooks.captureAfterState();
      },
      primaryOracle: async context => this.hooks.primaryOracle(context),
      secondaryOracle: async context => this.hooks.secondaryOracle(context),
      report: async context => this.hooks.report(context)
    });

    const steps = 'stage' in input
      ? this.resumeSteps(input.stage)
      : undefined;
    return { runtime, events: await engine.execute(runtime, steps) };
  }

  private resumeSteps(stage: Exclude<FlowStage, 'PREPARED'>) {
    const tail = [
      'clientWaitFinalState',
      'captureAfterState',
      'primaryOracle',
      'secondaryOracle',
      'report'
    ] as const;
    if (stage === 'CLIENT_CREATED' || stage === 'ADMIN_LOCATED') {
      return ['preflight', 'adminLocate', 'adminVerify', 'adminAction', ...tail] as const;
    }
    if (stage === 'ADMIN_ACTION_DONE') return ['preflight', ...tail] as const;
    if (stage === 'CLIENT_FINALIZED') {
      return ['preflight', 'captureAfterState', 'primaryOracle', 'secondaryOracle', 'report'] as const;
    }
    return ['report'] as const;
  }
}
