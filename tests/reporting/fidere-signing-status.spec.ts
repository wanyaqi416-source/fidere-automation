import { expect, test, type Page } from '@playwright/test';

import { FidereSigningStatusReader } from '../../src/registration/fidere-signing-status';

function response(status: number, payload: unknown = {}): {
  ok(): boolean;
  status(): number;
  json(): Promise<unknown>;
} {
  return {
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => payload
  };
}

test('records a transient signing-status 401 without blocking an available document', async () => {
  let profileAttempts = 0;
  const page = {
    url: () => 'https://client.sandbox.test/onboarding',
    request: {
      get: async (url: string) => {
        if (url.includes('/server/auth/session')) {
          return response(200, { accessToken: 'test-token' });
        }
        profileAttempts += 1;
        if (profileAttempts === 1) return response(401);
        return response(200, {
          data: {
            kyc_step: 'authorization',
            kyc_step_status: 'pending',
            client_authorization_status: 0,
            signature: ''
          }
        });
      }
    }
  } as unknown as Page;

  const reader = new FidereSigningStatusReader(page);
  const unavailable = await reader.observe();
  const available = await reader.observe();

  expect(profileAttempts).toBe(2);
  expect(unavailable.observations.map(item => item.status)).toEqual([401]);
  expect(unavailable.snapshot).toBeUndefined();
  expect(available.observations.map(item => item.status)).toEqual([200]);
  expect(available.snapshot?.recognized).toBe(false);
});
