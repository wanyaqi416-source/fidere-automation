import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type PendingPersonalRegistration = {
  sourceRunId: string;
  email: string;
  displayName: string;
  stage: string;
};

export function findPendingPersonalRegistration(
  root = resolve('.journey-context/registration-approval')
): PendingPersonalRegistration | undefined {
  const activePath = resolve(root, 'active-personal.json');
  if (!existsSync(activePath)) return undefined;

  const active = JSON.parse(readFileSync(activePath, 'utf8')) as {
    sourceRunId?: string;
    accountType?: string;
  };
  const sourceRunId = active.sourceRunId?.trim();
  if (
    active.accountType !== 'personal' ||
    !sourceRunId ||
    !/^[A-Z0-9._-]+$/i.test(sourceRunId)
  ) {
    throw new Error('REGISTRATION_PENDING_STATE_INVALID: 无法安全读取待审核个人注册案件。');
  }

  const statePath = resolve(root, 'personal', `${sourceRunId}.json`);
  if (!existsSync(statePath)) {
    throw new Error('REGISTRATION_PENDING_STATE_MISSING: 待审核个人注册案件状态文件不存在。');
  }
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
    sourceRunId?: string;
    accountType?: string;
    email?: string;
    displayName?: string;
    stage?: string;
    kycStage?: string;
    kycVerifiedAt?: string;
  };
  if (
    state.sourceRunId !== sourceRunId ||
    state.accountType !== 'personal' ||
    !state.email ||
    !state.displayName ||
    !state.stage
  ) {
    throw new Error('REGISTRATION_PENDING_STATE_INVALID: 待审核个人注册案件身份不完整。');
  }
  if (
    state.kycVerifiedAt ||
    state.kycStage === 'CLIENT_KYC_APPROVED' ||
    state.stage === 'COMPLETED'
  ) {
    return undefined;
  }

  return {
    sourceRunId,
    email: state.email,
    displayName: state.displayName,
    stage: state.stage
  };
}
