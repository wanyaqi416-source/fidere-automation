export const FLOW_LIFECYCLE = [
  'preflight',
  'captureBeforeState',
  'clientSubmit',
  'captureClientReference',
  'adminLocate',
  'adminVerify',
  'adminAction',
  'clientWaitFinalState',
  'captureAfterState',
  'primaryOracle',
  'secondaryOracle',
  'report'
] as const;

export type FlowLifecycleStep = (typeof FLOW_LIFECYCLE)[number];

export type FlowLifecycleHooks<TContext> = {
  [Step in FlowLifecycleStep]: (context: TContext) => Promise<void>;
};

export type FlowLifecycleEvent = {
  step: FlowLifecycleStep;
  startedAt: string;
  completedAt: string;
  durationMs: number;
};

export class FlowEngine<TContext> {
  constructor(
    private readonly hooks: FlowLifecycleHooks<TContext>,
    private readonly onStepComplete?: (event: FlowLifecycleEvent) => void
  ) {}

  async execute(
    context: TContext,
    steps: readonly FlowLifecycleStep[] = FLOW_LIFECYCLE
  ): Promise<FlowLifecycleEvent[]> {
    const events: FlowLifecycleEvent[] = [];
    for (const step of steps) {
      const started = new Date();
      await this.hooks[step](context);
      const completed = new Date();
      const event = {
        step,
        startedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        durationMs: completed.getTime() - started.getTime()
      };
      events.push(event);
      this.onStepComplete?.(event);
    }
    return events;
  }
}
