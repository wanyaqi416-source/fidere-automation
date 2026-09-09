import type { Page, Response } from '@playwright/test';

export type SafeSigningNetworkObservation = {
  source: 'browser';
  host: string;
  path: string;
  method: string;
  status: number;
  time: string;
};

function safePath(pathname: string): string {
  return pathname
    .split('/')
    .map(segment =>
      /^[A-F0-9-]{16,}$/i.test(segment) || /^[A-Za-z0-9_-]{16,}$/.test(segment)
        ? ':id'
        : segment
    )
    .join('/');
}

export class SigningNetworkEvidenceRecorder {
  private readonly observations: SafeSigningNetworkObservation[] = [];
  private started = false;

  private readonly capture = (response: Response): void => {
    const url = new URL(response.url());
    const method = response.request().method().toUpperCase();
    const isDocumenso = url.hostname === 'app.documenso.com';
    const isRelevantFiderePath = /(?:create-kyc-doc|get-profile-info-test|authori[sz]|document|sign)/i
      .test(url.pathname);
    if ((!isDocumenso || method === 'GET') && !isRelevantFiderePath) return;

    this.observations.push({
      source: 'browser',
      host: url.hostname,
      path: safePath(url.pathname),
      method,
      status: response.status(),
      time: new Date().toISOString()
    });
  };

  constructor(readonly page: Page) {}

  start(): void {
    if (this.started) throw new Error('Signing network evidence recorder is already active.');
    this.started = true;
    this.page.on('response', this.capture);
  }

  stop(): SafeSigningNetworkObservation[] {
    if (this.started) {
      this.page.off('response', this.capture);
      this.started = false;
    }
    return this.snapshot();
  }

  snapshot(): SafeSigningNetworkObservation[] {
    return this.observations.map(observation => ({ ...observation }));
  }
}
