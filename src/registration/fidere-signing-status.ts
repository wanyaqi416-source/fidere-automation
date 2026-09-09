import { expect, type Page } from '@playwright/test';

export type SafeStatusRequestEvidence = {
  source: 'diagnostic';
  host: string;
  path: string;
  method: 'GET';
  status: number;
  time: string;
};

export type FidereSigningStatusSnapshot = {
  kycStep: string;
  kycStepStatus: string;
  clientSigningStatus: string;
  signaturePresent: boolean;
  recognized: boolean;
  request: SafeStatusRequestEvidence;
};

export type FidereSigningRecognitionResult = {
  recognized: boolean;
  snapshot: FidereSigningStatusSnapshot;
  observations: SafeStatusRequestEvidence[];
};

function displayScalar(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return 'unknown';
}

function isRecognizedStatus(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return ['1', 'true', 'complete', 'completed', 'signed', 'success', 'succeeded'].includes(
    normalized
  );
}

export function summarizeFidereSigningStatus(snapshot: FidereSigningStatusSnapshot): string {
  return [
    `kycStep=${snapshot.kycStep}`,
    `kycStepStatus=${snapshot.kycStepStatus}`,
    `signingStatus=${snapshot.clientSigningStatus}`,
    `signaturePresent=${snapshot.signaturePresent}`
  ].join('; ');
}

export class FidereSigningStatusReader {
  constructor(readonly page: Page) {}

  async read(): Promise<FidereSigningStatusSnapshot> {
    const clientUrl = new URL(this.page.url());
    const sessionResponse = await this.page.request.get(
      new URL('/server/auth/session', clientUrl).toString(),
      { failOnStatusCode: false }
    );
    if (!sessionResponse.ok()) {
      throw new Error(`Fidere session status request returned HTTP ${sessionResponse.status()}.`);
    }
    const session = await sessionResponse.json() as { accessToken?: unknown };
    if (typeof session.accessToken !== 'string' || session.accessToken.length === 0) {
      throw new Error('Fidere session did not expose an authenticated access token internally.');
    }

    const statusUrl = new URL('/api/get-profile-info-test', clientUrl);
    const profileResponse = await this.page.request.get(statusUrl.toString(), {
      failOnStatusCode: false,
      headers: { Authorization: `Bearer ${session.accessToken}` }
    });
    const time = new Date().toISOString();
    if (!profileResponse.ok()) {
      throw new Error(`Fidere signing status request returned HTTP ${profileResponse.status()}.`);
    }
    const payload = await profileResponse.json() as {
      data?: {
        kyc_step?: unknown;
        kyc_step_status?: unknown;
        client_authorization_status?: unknown;
        signature?: unknown;
      };
    };
    const data = payload.data;
    if (!data) throw new Error('Fidere signing status response did not contain profile data.');
    const clientSigningStatus = displayScalar(data.client_authorization_status);
    const signaturePresent = typeof data.signature === 'string'
      ? data.signature.trim().length > 0
      : Boolean(data.signature);

    return {
      kycStep: displayScalar(data.kyc_step),
      kycStepStatus: displayScalar(data.kyc_step_status),
      clientSigningStatus,
      signaturePresent,
      recognized: isRecognizedStatus(clientSigningStatus),
      request: {
        source: 'diagnostic',
        host: statusUrl.hostname,
        path: statusUrl.pathname,
        method: 'GET',
        status: profileResponse.status(),
        time
      }
    };
  }

  async waitForRecognition(timeout = 60_000): Promise<FidereSigningRecognitionResult> {
    const observations: SafeStatusRequestEvidence[] = [];
    let snapshot = await this.read();
    observations.push(snapshot.request);

    try {
      await expect.poll(async () => {
        snapshot = await this.read();
        observations.push(snapshot.request);
        return snapshot.recognized;
      }, {
        timeout,
        intervals: [500, 1_000, 2_000, 3_000, 5_000],
        message: 'Documenso completed, but Fidere did not recognize the signing state.'
      }).toBe(true);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { recognized: false, snapshot, observations };
    }

    return { recognized: true, snapshot, observations };
  }
}
