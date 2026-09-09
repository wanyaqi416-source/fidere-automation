import { readFileSync } from 'node:fs';

import { getFlowDefinition } from '../../config/flow-registry';
import { expect, test } from '../../fixtures/reporting.fixture';
import {
  adjudicateOracles,
  assertFreshExecutionAllowed,
  ClientAdminApprovalFlow,
  FLOW_LIFECYCLE,
  FlowStateStore,
  advanceFlowState,
  createPreparedFlowState,
  classifyFlowError,
  matchCandidatesByStages,
  MoneyMutationGuard,
  recoverPreSubmitOnce,
  requireExactlyOneCandidate,
  requiresResume,
  type FlowResumeState
} from '../../src/flow-engine';
import { toAlphabeticSuffix } from '../../src/registration';

test('@platform @validation @L1 Registration sequence maps to stable alphabetic suffixes', async () => {
  expect([
    toAlphabeticSuffix(1),
    toAlphabeticSuffix(2),
    toAlphabeticSuffix(26),
    toAlphabeticSuffix(27),
    toAlphabeticSuffix(676),
    toAlphabeticSuffix(677)
  ]).toEqual(['AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
});

test('@platform @validation @L1 Recoverable Pre-submit allows one deterministic correction', async () => {
  let value = 'SANDBOX 003';
  const mutationState = {
    clientFinalSubmissionOccurred: false,
    securityKeyVerified: false,
    adminMutationOccurred: false,
    businessOrderCreated: false
  };

  expect(classifyFlowError(mutationState)).toBe('RECOVERABLE_PRE_SUBMIT');
  const result = await recoverPreSubmitOnce({
    id: 'registration-last-name',
    mutationState,
    needsCorrection: () => /\d/.test(value),
    correct: () => { value = 'SANDBOX AC'; },
    verify: () => value === 'SANDBOX AC'
  });

  expect(result).toEqual({
    disposition: 'RECOVERABLE_PRE_SUBMIT',
    correctionCount: 1,
    corrected: true
  });
  expect(value).toBe('SANDBOX AC');
});

test('@platform @validation @L1 Recoverable Pre-submit refuses correction after mutation', async () => {
  const mutationState = {
    clientFinalSubmissionOccurred: true,
    securityKeyVerified: false,
    adminMutationOccurred: false,
    businessOrderCreated: false
  };

  expect(classifyFlowError(mutationState)).toBe('HARD_STOP');
  await expect(recoverPreSubmitOnce({
    id: 'registration-last-name',
    mutationState,
    needsCorrection: () => true,
    correct: () => undefined,
    verify: () => true
  })).rejects.toThrow('irreversible mutation boundary');
});

test('@platform @validation @L1 Candidate Matcher逐层计数并要求唯一候选', async ({ business }) => {
  business.flow('transfer-validation', {
    caseId: 'PLATFORM-CANDIDATE',
    name: 'Candidate Matcher公共契约',
    expectedResult: '领域字段按配置逐层筛选，最终候选严格等于1。'
  });

  const records = [
    { user: 'u1', currency: 'USD', amount: '80.02', status: '待审核' },
    { user: 'u1', currency: 'USD', amount: '81.02', status: '待审核' },
    { user: 'u2', currency: 'USD', amount: '80.02', status: '待审核' }
  ];
  const result = matchCandidatesByStages(records, [
    { id: 'currency', label: '币种', matches: item => item.currency === 'USD' },
    { id: 'amount', label: '金额', matches: item => item.amount === '80.02' },
    { id: 'user', label: '用户', matches: item => item.user === 'u1' },
    { id: 'status', label: '状态', matches: item => item.status === '待审核' }
  ]);

  expect(result.initialCount).toBe(3);
  expect(result.counts).toEqual({ currency: 3, amount: 2, user: 1, status: 1 });
  expect(requireExactlyOneCandidate(result.candidates, 'Platform test').amount).toBe('80.02');
  business.setBusinessData({ candidateStageCounts: result.counts, candidateCount: 1 });
});

test('@platform @validation @L1 Money Mutation Guard默认关闭且限制单次动作', async () => {
  const guard = new MoneyMutationGuard('platform-guard');
  guard.markAuthenticationReady(true, true);

  expect(() => guard.validateRuntime({
    baseURL: 'https://client.sandbox.example.test',
    workers: 1,
    retries: 0,
    repeatEach: 1,
    safetySwitches: { ALLOW_MONEY_TESTS: false }
  })).toThrow('ALLOW_MONEY_TESTS');

  guard.validateRuntime({
    baseURL: 'https://client.sandbox.example.test',
    workers: 1,
    retries: 0,
    repeatEach: 1,
    safetySwitches: {
      ALLOW_MONEY_TESTS: true,
      ALLOW_ADMIN_MUTATION_TESTS: true
    }
  });
  guard.assertClientSubmissionAllowed({ ALLOW_MONEY_TESTS: true });
  guard.recordClientSubmission();
  expect(() => guard.recordClientSubmission()).toThrow('already recorded');
  guard.recordSecurityKeyVerification();
  expect(() => guard.recordSecurityKeyVerification()).toThrow('limited to once');
  guard.recordUniqueAdminCandidate(1);
  guard.assertAdminActionAllowed({ ALLOW_ADMIN_MUTATION_TESTS: true });
  guard.recordAdminAction();
  expect(() => guard.recordAdminAction()).toThrow('already recorded');
});

test('@platform @validation @L1 Client扣费必须先确认资金操作再验证安全密钥', async () => {
  const guard = new MoneyMutationGuard('platform-secure-money-guard', false, true);
  const switches = { ALLOW_MONEY_TESTS: true };
  guard.markAuthenticationReady(true, true);

  expect(() => guard.assertClientSubmissionAllowed(switches)).toThrow(
    'requires exactly one Security Key verification'
  );
  guard.assertClientMoneyConfirmationAllowed(switches);
  guard.recordClientMoneyConfirmation();
  guard.assertSecurityKeyVerificationAllowed(switches);
  guard.recordSecurityKeyVerification();
  guard.assertClientSubmissionAllowed(switches);
  guard.recordClientSubmission();

  expect(guard.snapshot()).toMatchObject({
    clientMoneyConfirmations: 1,
    securityKeyVerifications: 1,
    clientSubmissions: 1
  });
});

test('@platform @readonly @L2 Resume State只保存白名单字段且禁止重新创建', async ({}, testInfo) => {
  const now = new Date().toISOString();
  const store = new FlowStateStore(testInfo.outputPath('flow-state'));
  const state: FlowResumeState = {
    schemaVersion: 1,
    runId: 'run-001',
    flowId: 'transfer-reject',
    clientReference: 'TRF-MASKED',
    amount: '80.02',
    currency: 'USD',
    preparedAt: now,
    updatedAt: now,
    clientSubmittedAt: now,
    stage: 'CLIENT_CREATED'
  };
  const path = store.save(state);
  const restored = store.load(state.flowId, state.runId);
  const serialized = readFileSync(path, 'utf8');

  expect(restored).toEqual(state);
  expect(requiresResume(restored!)).toBe(true);
  expect(() => assertFreshExecutionAllowed(restored)).toThrow('resume');
  expect(serialized).not.toMatch(/password|token|cookie|securityKey|authorization/i);
});

test('@platform @readonly @L2 开户Resume在Client提交后等待真实Admin引用', async ({}, testInfo) => {
  const store = new FlowStateStore(testInfo.outputPath('opening-flow-state'));
  const prepared = createPreparedFlowState({
    runId: 'OPEN-US-STATE-001',
    flowId: 'account-opening-us-approve'
  });
  const submitted = advanceFlowState(prepared, 'CLIENT_CREATED', {
    clientSubmittedAt: new Date().toISOString()
  });
  store.save(submitted);

  expect(submitted.clientReference).toBeUndefined();
  expect(requiresResume(submitted)).toBe(true);
  expect(() => advanceFlowState(submitted, 'ADMIN_LOCATED')).toThrow('real business reference');

  const located = advanceFlowState(submitted, 'ADMIN_LOCATED', {
    clientReference: 'REVIEW-TEST',
    adminReference: 'REVIEW-TEST'
  });
  expect(store.save(located)).toContain('OPEN-US-STATE-001.json');
});

test('@platform @readonly @L2 Oracle Engine统一五种业务结果', async () => {
  const primary = {
    id: 'p1',
    name: '核心状态',
    level: 'primary' as const,
    expected: '完成',
    actual: '完成',
    status: 'passed' as const
  };
  const secondaryFailure = {
    id: 's1',
    name: '辅助流水',
    level: 'secondary' as const,
    expected: '存在',
    actual: '缺失',
    status: 'failed' as const
  };

  expect(adjudicateOracles({ oracles: [primary] })).toBe('PASS');
  expect(adjudicateOracles({ oracles: [primary, secondaryFailure] })).toBe('PASS_WITH_WARNING');
  expect(adjudicateOracles({ oracles: [{ ...primary, status: 'failed' }] })).toBe('FAIL');
  expect(adjudicateOracles({
    oracles: [],
    mutationOccurred: true,
    resultUncertain: true
  })).toBe('MANUAL_REVIEW');
  expect(adjudicateOracles({ oracles: [], blocked: true })).toBe('BLOCKED');
});

test('@platform @dry-run @L3 ClientAdminApprovalFlow执行统一生命周期且不接触DOM', async () => {
  const calls: string[] = [];
  const flow = new ClientAdminApprovalFlow(
    getFlowDefinition('transfer-reject'),
    {
      preflight: async () => { calls.push('preflight'); },
      captureBeforeState: async () => { calls.push('captureBeforeState'); return { balance: '100' }; },
      clientSubmit: async () => { calls.push('clientSubmit'); return { accepted: true }; },
      captureClientReference: async () => { calls.push('captureClientReference'); return 'TRF-TEST'; },
      adminLocate: async () => { calls.push('adminLocate'); return [{ id: 'TXN-TEST' }]; },
      adminVerify: async () => { calls.push('adminVerify'); },
      adminAction: async (_candidate, action) => { calls.push(`adminAction:${action}`); },
      clientWaitFinalState: async () => { calls.push('clientWaitFinalState'); return '已拒绝'; },
      captureAfterState: async () => { calls.push('captureAfterState'); return { balance: '100' }; },
      primaryOracle: async () => { calls.push('primaryOracle'); },
      secondaryOracle: async () => { calls.push('secondaryOracle'); },
      report: async () => { calls.push('report'); }
    }
  );

  const result = await flow.execute('platform-dry-run');
  expect(result.events.map(event => event.step)).toEqual(FLOW_LIFECYCLE);
  expect(calls).toEqual(FLOW_LIFECYCLE.map(step =>
    step === 'adminAction' ? 'adminAction:Reject' : step
  ));
  expect(result.runtime.clientReference).toBe('TRF-TEST');
  expect(result.runtime.adminCandidates).toHaveLength(1);
});
