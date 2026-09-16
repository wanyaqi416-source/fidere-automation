import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launcherManualDepositEnvironment } from '../../scripts/launcher-manual-deposit-run';

test('menu 18 creates one named amount and resumes only before submission', () => {
  const root = mkdtempSync(join(tmpdir(), 'manual-deposit-menu18-'));
  try {
    const now = new Date('2026-09-15T09:00:00.000Z');
    const input = { CLIENT_USERNAME: 'default@example.test', MANUAL_DEPOSIT_USER_EMAIL: 'user@example.test' };
    const first = launcherManualDepositEnvironment(input, root, now);
    expect(first).toMatchObject({
      CLIENT_USERNAME: 'user@example.test',
      MANUAL_DEPOSIT_USER_EMAIL: 'user@example.test',
      MANUAL_DEPOSIT_RUN_ID: 'ADMIN-MD-MENU18-20260915090000',
      MANUAL_DEPOSIT_RESUME_CONFIRMATION: 'false'
    });
    expect(first.MANUAL_DEPOSIT_AUTHORIZED_AMOUNT).toBe('200.00');

    const stateRoot = join(root, '.journey-context', 'fresh-user', 'bootstrap');
    mkdirSync(stateRoot, { recursive: true });
    const statePath = join(stateRoot, `${first.MANUAL_DEPOSIT_RUN_ID}.json`);
    writeFileSync(statePath, JSON.stringify({ stage: 'PREPARED' }));
    expect(launcherManualDepositEnvironment(input, root, now)).toEqual(first);
    writeFileSync(statePath, JSON.stringify({ stage: 'BOOTSTRAP_SUBMISSION_ATTEMPTED', submissionClicks: 1 }));
    expect(() => launcherManualDepositEnvironment(input, root, now)).toThrow('MANUAL_DEPOSIT_RECONCILIATION_REQUIRED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
