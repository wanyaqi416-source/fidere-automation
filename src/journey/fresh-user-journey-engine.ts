import {
  FRESH_USER_JOURNEY_STEPS,
  type JourneyStepDefinition,
  type JourneyStepId
} from '../../config/journey-registry';
import {
  FreshUserJourneyContextStore,
  type FreshUserJourneyContext,
  type JourneyFlowDisposition
} from './journey-context';

export type JourneyStepAdapterResult = {
  disposition: Exclude<JourneyFlowDisposition, 'PENDING'>;
  reason?: string;
  mutationPerformed: boolean;
  unknownMutationState?: boolean;
  user?: Partial<FreshUserJourneyContext['user']>;
  account?: Partial<FreshUserJourneyContext['account']>;
  references?: Partial<FreshUserJourneyContext['references']>;
};

export type JourneyStepAdapter = (input: {
  context: Readonly<FreshUserJourneyContext>;
  definition: JourneyStepDefinition;
}) => Promise<JourneyStepAdapterResult>;

export type JourneyEngineObserver = {
  journeyStarted?(context: Readonly<FreshUserJourneyContext>): void;
  flowStarted?(definition: JourneyStepDefinition, context: Readonly<FreshUserJourneyContext>): void;
  flowFinished?(
    definition: JourneyStepDefinition,
    result: JourneyStepAdapterResult,
    context: Readonly<FreshUserJourneyContext>
  ): void;
  journeyFinished?(context: Readonly<FreshUserJourneyContext>): void;
};

export class FreshUserJourneyEngine {
  constructor(
    private readonly adapters: Partial<Record<JourneyStepId, JourneyStepAdapter>>,
    private readonly store = new FreshUserJourneyContextStore(),
    private readonly observer: JourneyEngineObserver = {}
  ) {}

  missingAdapters(): JourneyStepId[] {
    return FRESH_USER_JOURNEY_STEPS
      .filter(step => step.adapterReady && !this.adapters[step.id])
      .map(step => step.id);
  }

  async execute(initial: FreshUserJourneyContext): Promise<FreshUserJourneyContext> {
    const missing = this.missingAdapters();
    if (missing.length > 0) {
      throw new Error(`Fresh User Journey execution adapters are missing: ${missing.join(', ')}.`);
    }

    let context = this.persist({ ...initial, stage: 'RUNNING' });
    this.observer.journeyStarted?.(context);

    for (const definition of FRESH_USER_JOURNEY_STEPS) {
      if (context.flows.some(flow => flow.id === definition.id && flow.disposition === 'PASS')) {
        continue;
      }

      const dependencyFailure = definition.dependsOn.find(dependency => {
        const record = context.flows.find(flow => flow.id === dependency);
        return !record || ![
          'PASS',
          'SKIPPED_NOT_APPLICABLE',
          'SKIPPED_PREREQUISITE',
          'SKIPPED_NOT_READY'
        ].includes(record.disposition);
      });
      if (dependencyFailure) {
        context = this.record(context, definition, {
          disposition: 'BLOCKED',
          reason: `Dependency ${dependencyFailure} did not complete.`,
          mutationPerformed: false
        });
        continue;
      }

      const adapter = this.adapters[definition.id];
      if (!definition.adapterReady || !adapter) {
        context = this.record(context, definition, {
          disposition: definition.requirement === 'optional'
            ? definition.unavailableDisposition ?? 'SKIPPED_NOT_READY'
            : 'BLOCKED',
          reason: definition.description,
          mutationPerformed: false
        });
        continue;
      }

      context = this.persist({ ...context, currentFlow: definition.id, resumeFlow: definition.id });
      this.observer.flowStarted?.(definition, context);
      const result = await adapter({ context, definition });
      context = this.record(context, definition, result);
      this.observer.flowFinished?.(definition, result, context);

      if (result.unknownMutationState || result.disposition === 'MANUAL_REVIEW') {
        context = this.persist({
          ...context,
          stage: 'PAUSED',
          currentFlow: undefined,
          resumeFlow: definition.id,
          unknownMutationState: true
        });
        this.observer.journeyFinished?.(context);
        return context;
      }
      if (result.disposition === 'FAIL') {
        context = this.persist({
          ...context,
          stage: 'PAUSED',
          currentFlow: undefined,
          resumeFlow: definition.id
        });
        this.observer.journeyFinished?.(context);
        return context;
      }
    }

    const terminal = context.flows.every(flow =>
      [
        'PASS',
        'SKIPPED_NOT_APPLICABLE',
        'SKIPPED_PREREQUISITE',
        'SKIPPED_NOT_READY',
        'BLOCKED'
      ].includes(flow.disposition)
    );
    context = this.persist({
      ...context,
      stage: terminal ? 'COMPLETED' : 'PAUSED',
      currentFlow: undefined,
      resumeFlow: terminal ? undefined : context.resumeFlow
    });
    this.observer.journeyFinished?.(context);
    return context;
  }

  private record(
    context: FreshUserJourneyContext,
    definition: JourneyStepDefinition,
    result: JourneyStepAdapterResult
  ): FreshUserJourneyContext {
    const now = new Date().toISOString();
    const record = {
      id: definition.id,
      disposition: result.disposition,
      startedAt: context.flows.find(flow => flow.id === definition.id)?.startedAt ?? now,
      completedAt: now,
      reason: result.reason
    };
    const flows = context.flows.filter(flow => flow.id !== definition.id).concat(record);
    return this.persist({
      ...context,
      user: { ...context.user, ...result.user },
      account: { ...context.account, ...result.account },
      references: { ...context.references, ...result.references },
      flows,
      currentFlow: undefined,
      resumeFlow: result.disposition === 'PASS' ? undefined : definition.id,
      totalMutationCount:
        context.totalMutationCount + (result.mutationPerformed ? 1 : 0),
      unknownMutationState: context.unknownMutationState || Boolean(result.unknownMutationState)
    });
  }

  private persist(context: FreshUserJourneyContext): FreshUserJourneyContext {
    const updatedAt = new Date().toISOString();
    const next = { ...context, updatedAt };
    this.store.save(next);
    return next;
  }
}
