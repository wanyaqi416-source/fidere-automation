import { expect, test } from '@playwright/test';
import { collectLauncherU2u } from '../../scripts/launcher-u2u-input';
import { existingU2uConfig } from '../../src/user-transfer/u2u-existing-contract';
import { createPreparedFlowState } from '../../src/flow-engine/resume-state';
import { participantHash, type U2uEvidence } from '../../src/user-transfer/u2u-evidence';

const environment = Object.freeze({ CLIENT_USERNAME: 'sender@example.test', U2U_RECIPIENT_EMAIL: 'receiver@example.test' });
const emptyHistory = { states: [], evidence: (): U2uEvidence => { throw new Error('Unexpected evidence read'); } };
const prompt = (answers: string[]) => ({ question: async (_message: string) => {
  const answer = answers.shift();
  if (answer === undefined) throw new Error('Unexpected prompt');
  return answer;
} });
test('menu6 gathers complete runtime config without changing env or enabling mutation', async () => {
  const answers: string[] = [];
  const values = await collectLauncherU2u(prompt(answers), environment, () => undefined, emptyHistory);
  expect(answers).toEqual([]);
  expect(existingU2uConfig({ ...environment, ...values })).toMatchObject({
    sender: environment.CLIENT_USERNAME, recipient: environment.U2U_RECIPIENT_EMAIL,
    account: '香港账户', targetAccount: '香港账户', currency: 'USD', amount: '50'
  });
  expect(values.U2U_RUN_ID).toMatch(/^U2U-\d{14}-[a-f0-9]{8}$/);
  expect(Object.keys(values).some(key => key.startsWith('ALLOW_'))).toBe(false);
  expect(Object.keys(environment)).toHaveLength(2);
});
test('new menu6 runs always use Hong Kong USD and fixed amount 50 without extra prompts', async () => {
  const configured = { ...environment, U2U_RUN_ID: 'U2U-OFFLINE', U2U_SOURCE_ACCOUNT_TYPE: '巴林账户',
    U2U_TARGET_ACCOUNT_TYPE: '新加坡账户', U2U_CURRENCY: 'HKD', U2U_TEST_AMOUNT: '1.20' };
  expect(await collectLauncherU2u(prompt([]), configured, () => undefined, emptyHistory))
    .toMatchObject({ U2U_RUN_ID: 'U2U-OFFLINE', U2U_SOURCE_ACCOUNT_TYPE: '香港账户',
      U2U_TARGET_ACCOUNT_TYPE: '香港账户', U2U_CURRENCY: 'USD', U2U_TEST_AMOUNT: '50' });
});
test('unfinished order is resumed unchanged while unrelated participants use an isolated new Run', async () => {
  const state = { ...createPreparedFlowState({ flowId: 'user-to-user-transfer', runId: 'ORIGINAL', amount: '1.60', currency: 'USD' }),
    stage: 'CLIENT_CREATED' as const, clientReference: 'TRF-original' };
  const evidence: U2uEvidence = { runId: state.runId, senderHash: participantHash(environment.CLIENT_USERNAME),
    recipientHash: participantHash(environment.U2U_RECIPIENT_EMAIL), sourceAccountType: '香港账户', targetAccountType: '香港账户',
    currency: 'USD', amount: '1.60', fee: '0', expectedCredit: '1.60', senderBefore: '100', recipientBefore: '10',
    senderLedgerIdsBefore: [], recipientLedgerIdsBefore: [], confirmationClicks: 1, verificationClicks: 1,
    requestCount: 1, network: [], orderId: state.clientReference };
  const history = { states: [state], evidence: () => evidence };
  expect(await collectLauncherU2u(prompt([]), environment, () => undefined, history))
    .toMatchObject({ U2U_RUN_ID: 'ORIGINAL', U2U_TEST_AMOUNT: '1.60' });
  const unrelated = await collectLauncherU2u(prompt([]),
    { ...environment, U2U_RECIPIENT_EMAIL: 'other@example.test' }, () => undefined, history);
  expect(unrelated.U2U_RUN_ID).not.toBe('ORIGINAL');
  expect(unrelated.U2U_TEST_AMOUNT).toBe('50');
  await expect(collectLauncherU2u(prompt([]), { ...environment, U2U_RUN_ID: 'REPLACEMENT' }, () => undefined, history))
    .rejects.toThrow('replacement');
  await expect(collectLauncherU2u(prompt([]), { ...environment, U2U_RUN_ID: 'ORIGINAL' }, () => undefined,
    { ...history, states: [{ ...state, stage: 'COMPLETED' }] })).rejects.toThrow('completed');
});
test('recipient is passed as an email only and does not require shared Client credentials', async () => {
  const answers: string[] = [];
  const values = await collectLauncherU2u(prompt(answers), environment, () => undefined, emptyHistory);
  expect(answers).toEqual([]);
  expect(values).not.toHaveProperty('U2U_RECIPIENT_USE_CLIENT_CREDENTIALS');
});
