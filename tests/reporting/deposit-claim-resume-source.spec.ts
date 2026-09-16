import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { loadDepositClaimResumeSource } from '../../src/deposit/deposit-claim-resume-source';
import { getLauncherEntry } from '../../config/test-launcher-menu';

const report = () => ({ endedAt: '2026/09/14 17:36:09', cases: [{ caseId: 'DP-003',
  startedAt: '2026/09/14 17:35:06', businessData: { confirmationClicks: 1, claimConfirmationClicks: 0,
    confirmed: false, depositAmount: '11.66', depositBalanceBefore: '500.38',
    accountType: '香港账户', depositCurrency: 'USD', depositChannel: 'SWIFT' } }] });

test('menu 3 keeps the original deposit Case instead of a special debug runner', () => {
  expect(getLauncherEntry(3)?.npmScript).toBe('test:deposit:claim');
});

test('Resume requires both explicit original evidence and a Client TXN', () => {
  expect(loadDepositClaimResumeSource({})).toBeUndefined();
  expect(() => loadDepositClaimResumeSource({ DEPOSIT_RESUME_TXN: 'TXN-EXAMPLE' })).toThrow();
  expect(() => loadDepositClaimResumeSource({ DEPOSIT_RESUME_REPORT_PATH: 'unused', DEPOSIT_RESUME_TXN: 'TRF-EXAMPLE' })).toThrow();
});

test('Resume pins the original amount, time window, balance and channel', ({}, info) => {
  const file = info.outputPath('original.json');
  writeFileSync(file, JSON.stringify(report()));
  expect(loadDepositClaimResumeSource({ DEPOSIT_RESUME_REPORT_PATH: file, DEPOSIT_RESUME_TXN: 'TXN-20260914-EXAMPLE' }))
    .toEqual({ transactionId: 'TXN-20260914-EXAMPLE', amount: '11.66', balanceBefore: '500.38',
      accountType: '香港账户', currency: 'USD', channel: 'SWIFT',
      submittedFromMs: Date.parse('2026-09-14T17:35:06+08:00'), submittedToMs: Date.parse('2026-09-14T17:36:09+08:00') });
});

for (const change of ['no submission', 'claim attempted', 'completed', 'duplicate case', 'missing balance']) {
  test(`Resume rejects ${change}`, ({}, info) => {
    const data = report();
    if (change === 'no submission') data.cases[0].businessData.confirmationClicks = 0;
    if (change === 'claim attempted') data.cases[0].businessData.claimConfirmationClicks = 1;
    if (change === 'completed') data.cases[0].businessData.confirmed = true;
    if (change === 'duplicate case') data.cases.push(data.cases[0]);
    if (change === 'missing balance') data.cases[0].businessData.depositBalanceBefore = '';
    const file = info.outputPath('original.json');
    writeFileSync(file, JSON.stringify(data));
    expect(() => loadDepositClaimResumeSource({ DEPOSIT_RESUME_REPORT_PATH: file, DEPOSIT_RESUME_TXN: 'TXN-20260914-EXAMPLE' })).toThrow();
  });
}
