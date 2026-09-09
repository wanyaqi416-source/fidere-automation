import { createLiveEvent, type LiveEventPayloadMap, type LiveEventType } from './live-events';

export class LiveMonitorClient {
  private queue: Promise<void> = Promise.resolve();
  private unavailable = false;

  private constructor(
    private readonly baseUrl: string | undefined,
    private readonly runId: string | undefined
  ) {}

  static fromEnvironment(): LiveMonitorClient {
    const baseUrl = process.env.FIDERE_LIVE_MONITOR_URL?.replace(/\/$/, '');
    const runId = process.env.FIDERE_LIVE_RUN_ID;
    return new LiveMonitorClient(baseUrl, runId);
  }

  get enabled(): boolean {
    return Boolean(this.baseUrl && this.runId && !this.unavailable);
  }

  emit<T extends LiveEventType>(type: T, payload: LiveEventPayloadMap[T]): void {
    if (!this.enabled || !this.baseUrl || !this.runId) return;
    const event = createLiveEvent(this.runId, type, payload);
    this.queue = this.queue.then(() => this.post(event));
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  private async post(event: ReturnType<typeof createLiveEvent>): Promise<void> {
    if (this.unavailable || !this.baseUrl) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 750);
    try {
      const response = await fetch(`${this.baseUrl}/api/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: controller.signal
      });
      if (!response.ok) this.unavailable = true;
    } catch {
      this.unavailable = true;
    } finally {
      clearTimeout(timeout);
    }
  }
}
