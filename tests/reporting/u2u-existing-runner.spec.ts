import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { getLauncherEntry } from '../../config/test-launcher-menu';
import { collectLauncherEmail } from '../../scripts/launcher-email-input';
import { existingU2uConfig, assertExistingU2uResume, matchExistingU2uOrders } from '../../src/user-transfer/u2u-existing-contract';
import { createPreparedFlowState } from '../../src/flow-engine/resume-state';
import { assertU2uFreshAllowed, assertU2uFreshAllowedForParticipants, participantHash, type U2uEvidence } from '../../src/user-transfer/u2u-evidence';
import type { InternalTransferRecord } from '../../src/transfer/account-transfer-fee-run';
import { runExistingU2u } from '../../src/user-transfer/u2u-existing-runner';
import { env } from '../../src/config/env';

const values = {
  CLIENT_USERNAME: 'sender@example.test', U2U_RECIPIENT_EMAIL: 'recipient@example.test',
  U2U_RUN_ID: 'U2U-LOCAL-ONLY', U2U_SOURCE_ACCOUNT_TYPE: '香港账户', U2U_CURRENCY: 'USD', U2U_TEST_AMOUNT: '11.13'
};
const config = existingU2uConfig(values);
const evidence: U2uEvidence = {
  runId: config.runId, senderHash: participantHash(config.sender), recipientHash: participantHash(config.recipient),
  sourceAccountType: config.account, targetAccountType: config.targetAccount, currency: 'USD', amount: '11.13',
  fee: '0.37', expectedCredit: '10.76', senderBefore: '100', recipientBefore: '10',
  senderLedgerIdsBefore: [], recipientLedgerIdsBefore: [], orderIdsBefore: ['TRF-old'],
  submittedAt: '2026-09-14T10:00:00Z', confirmationClicks: 1, verificationClicks: 1, requestCount: 1, network: []
};
const order: InternalTransferRecord = { orderNo: 'TRF-new', txNo: 'TXN-new', transferType: 'p2p',
  fromRegion: 'HK', toRegion: 'HK', currency: 'USD', amount: '11.13', fee: '0.37', actualAmount: '11.13',
  status: 'pending', remark: `AUTO_TRANSFER_FEE_${config.runId}`, appliedAt: Date.parse(evidence.submittedAt!) };

test('菜单6运行时邮箱指向新现有用户Runner而非历史Disabled Case', async () => {
  const entry = getLauncherEntry(6)!;
  const answers = ['new-recipient@example.test'];
  const overrides = await collectLauncherEmail({ question: async () => answers.shift()! }, entry, values, () => undefined);
  expect(existingU2uConfig({ ...values, ...overrides }).sender).toBe(values.CLIENT_USERNAME);
  expect(existingU2uConfig({ ...values, ...overrides }).recipient).toBe('new-recipient@example.test');
  expect(entry.npmScript).toBe('test:u2u:existing');
  expect(entry.requiresAdmin).toBe(true);
  expect(entry.safetySwitches).toEqual(['ALLOW_MONEY_TESTS', 'ALLOW_CLIENT_MUTATION_TESTS', 'ALLOW_ADMIN_MUTATION_TESTS']);
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  expect(scripts[entry.npmScript]).toContain('tests/e2e/user-transfer/user-transfer-existing.spec.ts');
  expect(scripts[entry.npmScript]).toContain('--workers=1 --retries=0 --repeat-each=1');
  const runner = readFileSync('src/user-transfer/u2u-existing-runner.ts', 'utf8');
  expect(runner).not.toMatch(/getFlowDefinition|former direct-completion|happy-path\.spec/);
  for (const dependency of ['loginU2uParticipant', 'AccountInternalTransferPage', 'UserToUserTransferPage',
    'openOriginalU2uReview', 'confirmApproveOnce', 'assertU2uFreshAllowed', "flag: 'wx'"]) expect(runner).toContain(dependency);
  expect(runner).not.toContain('reconcileU2u');
  expect(runner.match(/loginU2uParticipant\(/g)).toHaveLength(1);
  expect(readFileSync('tests/client/user-transfer/user-transfer.happy-path.spec.ts', 'utf8')).toContain('former direct-completion fresh command is disabled');
});

test('运行参数不允许缺失或非法金额与收款用户，不自动替换收款人', () => {
  for (const patch of [{ U2U_RUN_ID: '' }, { U2U_TEST_AMOUNT: '0' }, { U2U_TEST_AMOUNT: '-1' },
    { U2U_TEST_AMOUNT: 'Infinity' }, { U2U_SOURCE_ACCOUNT_TYPE: 'unknown' }, { U2U_RECIPIENT_EMAIL: '' },
    { U2U_RECIPIENT_EMAIL: values.CLIENT_USERNAME }]) {
    expect(() => existingU2uConfig({ ...values, ...patch })).toThrow();
  }
});

test('新Runner实际进入Mutation Guard，开关关闭时零浏览器操作而非命中旧Disabled检查', async ({}, testInfo) => {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const sender = env.client.username, baseUrl = env.client.baseUrl, allowed = env.exchange.allowMoneyTests;
  let selectedFlow = '';
  try {
    Object.assign(process.env, values);
    env.client.username = values.CLIENT_USERNAME;
    env.client.baseUrl = 'https://sandbox.example.test';
    env.exchange.allowMoneyTests = false;
    const inaccessible = new Proxy({}, { get() { throw new Error('Browser must not be touched'); } });
    await expect(runExistingU2u({ browser: inaccessible as never, adminPage: inaccessible as never,
      business: { flow: (id: string) => { selectedFlow = id; } } as never, testInfo }))
      .rejects.toThrow('mutation safety switches are closed');
    expect(selectedFlow).toBe('user-to-user-transfer-existing');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    env.client.username = sender; env.client.baseUrl = baseUrl; env.exchange.allowMoneyTests = allowed;
  }
});

test('订单匹配使用完整业务指纹，拒绝历史订单及非本次Run，重复记录保留以阻止审核', () => {
  expect(matchExistingU2uOrders([order], evidence)).toEqual([order]);
  for (const patch of [{ orderNo: 'TRF-old' }, { transferType: 'internal' }, { fromRegion: 'BH' },
    { toRegion: 'SG' }, { currency: 'HKD' }, { amount: '11.14' }, { remark: 'another-run' },
    { appliedAt: order.appliedAt + 300_001 }]) {
    expect(matchExistingU2uOrders([{ ...order, ...patch }], evidence)).toEqual([]);
  }
  expect(matchExistingU2uOrders([order, { ...order, orderNo: 'TRF-duplicate', txNo: 'TXN-duplicate' }], evidence)).toHaveLength(2);
  expect(() => matchExistingU2uOrders([order], { ...evidence, orderIdsBefore: undefined })).toThrow('baseline');
});

test('Resume保留双方、金额、账户和原订单；完成或已尝试Run不能新建', () => {
  const state = { ...createPreparedFlowState({ flowId: 'user-to-user-transfer', runId: config.runId, amount: config.amount, currency: config.currency }),
    stage: 'CLIENT_CREATED' as const, clientReference: order.orderNo, adminReference: order.txNo };
  const original = { ...evidence, orderId: order.orderNo, senderLedgerId: order.txNo };
  expect(() => assertExistingU2uResume(state, original, config)).not.toThrow();
  for (const patch of [{ recipient: 'someone@example.test' }, { amount: '12' }, { targetAccount: '巴林账户' }]) {
    expect(() => assertExistingU2uResume(state, original, { ...config, ...patch })).toThrow('preserve');
  }
  expect(() => assertExistingU2uResume({ ...state, stage: 'COMPLETED' }, original, config)).toThrow('completed');
  expect(() => assertExistingU2uResume({ ...state, stage: 'PREPARED' }, original, config)).toThrow('attempted');
  expect(() => assertU2uFreshAllowed([state], 'another-run')).toThrow('replacement');
  expect(() => assertU2uFreshAllowedForParticipants([state], 'another-run', config.sender, config.recipient,
    () => original)).toThrow('these participants');
  expect(() => assertU2uFreshAllowedForParticipants([state], 'another-run', 'different@example.test', config.recipient,
    () => original)).not.toThrow();
});
