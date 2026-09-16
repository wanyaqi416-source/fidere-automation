import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { findPendingPersonalRegistration } from '../../scripts/launcher-registration-resume';

function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('菜单1在询问新邮箱前续办已提交但未审核的个人注册', async ({}, testInfo) => {
  const root = testInfo.outputPath('registration-approval');
  writeJson(resolve(root, 'active-personal.json'), {
    sourceRunId: 'REGP-20260916064440',
    accountType: 'personal'
  });
  writeJson(resolve(root, 'personal', 'REGP-20260916064440.json'), {
    sourceRunId: 'REGP-20260916064440',
    accountType: 'personal',
    email: 'pending@example.test',
    displayName: 'TEST SANDBOX AV',
    stage: 'CLIENT_KYC_SUBMITTED',
    kycStage: 'PERSONAL_REGISTRATION_SUBMITTED'
  });

  expect(findPendingPersonalRegistration(root)).toEqual({
    sourceRunId: 'REGP-20260916064440',
    email: 'pending@example.test',
    displayName: 'TEST SANDBOX AV',
    stage: 'CLIENT_KYC_SUBMITTED'
  });
});

test('已完成Client KYC的历史案件不再拦截下一次注册邮箱输入', async ({}, testInfo) => {
  const root = testInfo.outputPath('registration-approval');
  writeJson(resolve(root, 'active-personal.json'), {
    sourceRunId: 'REGP-COMPLETED',
    accountType: 'personal'
  });
  writeJson(resolve(root, 'personal', 'REGP-COMPLETED.json'), {
    sourceRunId: 'REGP-COMPLETED',
    accountType: 'personal',
    email: 'completed@example.test',
    displayName: 'TEST SANDBOX AW',
    stage: 'COMPLETED',
    kycStage: 'CLIENT_KYC_APPROVED',
    kycVerifiedAt: '2026-09-16T07:00:00.000Z'
  });

  expect(findPendingPersonalRegistration(root)).toBeUndefined();
});
