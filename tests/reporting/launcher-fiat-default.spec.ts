import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launcherFiatEnvironment } from '../../scripts/launcher-fiat-input';
import { defaultFiatUserKey } from '../../src/utils/default-fiat-user';
import { FlowStateStore, createPreparedFlowState } from '../../src/flow-engine/resume-state';
import { DefaultWithdrawalSnapshot, type WithdrawalJourneySnapshot } from '../../src/withdrawal/default-withdrawal-snapshot';
import { chooseApprovedBank, approvedBankNumber } from '../../src/deposit/default-client-bank';
import { DepositRejectionRun } from '../../src/deposit/deposit-rejection-run';
import { getLauncherEntry } from '../../config/test-launcher-menu';
import { WithdrawalPage } from '../../pages/client/WithdrawalPage';

const email = 'default@example.test';
test('4/5 use default Client, named child-only authorization and original menu runners', () => {
  const root = mkdtempSync(join(tmpdir(), 'fiat-launcher-'));
  try {
    const store = new FlowStateStore(root);
    const environment = Object.freeze({ CLIENT_USERNAME: email, PERSONAL_REGISTRATION_ADMIN_APPROVAL_SOURCE_RUN_ID: 'UNRELATED' });
    const deposit = launcherFiatEnvironment(4, environment, store);
    const withdrawal = launcherFiatEnvironment(5, environment, store);
    expect(deposit.DEPOSIT_REJECT_USE_DEFAULT_CLIENT).toBe('true');
    expect(deposit.DEPOSIT_REJECT_RUN_ID).toBe(deposit.DEPOSIT_REJECT_AUTHORIZED_RUN_ID);
    expect(deposit.DEPOSIT_REJECT_SOURCE_RUN_ID).toBe(defaultFiatUserKey(email));
    expect(withdrawal.WITHDRAWAL_USE_DEFAULT_CLIENT).toBe('true');
    expect(withdrawal.WITHDRAWAL_RUN_ID).toBe(withdrawal.WITHDRAWAL_AUTHORIZED_RUN_ID);
    expect(Object.keys(environment)).toHaveLength(2);
    expect(Object.keys({ ...deposit, ...withdrawal }).some(key => key.startsWith('ALLOW_'))).toBe(false);
    expect(store.list('deposit-rejection-journey')).toEqual([]);
    expect(getLauncherEntry(4)?.npmScript).toBe('test:deposit:rejection-journey');
    expect(getLauncherEntry(5)?.npmScript).toBe('test:journey:personal:withdrawal');
    expect(getLauncherEntry(5)?.safetySwitches).toContain('ALLOW_CLIENT_MUTATION_TESTS');
    for (const number of [1, 2, 3, 6, 7, 8, 9, 10, 20, 91]) expect(launcherFiatEnvironment(number, environment, store)).toEqual({});
    expect(() => launcherFiatEnvironment(4, {}, store)).toThrow('CLIENT_USERNAME_REQUIRED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('menu resumes original attempted Run, including crash before deposit stage save', () => {
  const root = mkdtempSync(join(tmpdir(), 'fiat-resume-'));
  try {
    const store = new FlowStateStore(root);
    const original = launcherFiatEnvironment(4, { CLIENT_USERNAME: email }, store);
    const runId = original.DEPOSIT_REJECT_RUN_ID;
    store.save(createPreparedFlowState({ flowId: 'deposit-rejection-journey', runId, amount: '11.01', currency: 'USD' }));
    writeFileSync(`${store.pathFor('deposit-rejection-journey', runId)}.submit`, '{}');
    const next = launcherFiatEnvironment(4, { CLIENT_USERNAME: email }, store);
    expect(next.DEPOSIT_REJECT_RUN_ID).toBe(runId);
    expect(next.DEPOSIT_REJECT_RESUME).toBe('true');
    expect(launcherFiatEnvironment(4, { CLIENT_USERNAME: 'another@example.test' }, store).DEPOSIT_REJECT_RUN_ID).not.toBe(runId);
    const wd = launcherFiatEnvironment(5, { CLIENT_USERNAME: email }, store).WITHDRAWAL_RUN_ID;
    store.save({ ...createPreparedFlowState({ flowId: 'personal-golden-journey-withdrawal', runId: wd }), stage: 'CLIENT_CREATED' });
    expect(launcherFiatEnvironment(5, { CLIENT_USERNAME: email }, store).WITHDRAWAL_RUN_ID).toBe(wd);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('approved bank selection cannot guess among multiple banks or replace pinned bank', () => {
  expect(approvedBankNumber({ accountText: 'QWE SWIFT: 12345678' })).toBe('QWE');
  expect(approvedBankNumber({ accountText: '1234 SWIFT: 5678', accountNumber: '1234' })).toBe('1234');
  const a = { accountId: 'A', bankName: 'Sandbox Bank', accountText: '8800001234', holderText: 'TEST USER' };
  const b = { ...a, accountId: 'B', accountText: '8800005678' };
  expect(chooseApprovedBank([a])).toBe(a);
  expect(chooseApprovedBank([a, b], { accountId: 'B' })).toBe(b);
  expect(chooseApprovedBank([a, b], { accountSuffix: '1234' })).toBe(a);
  expect(() => chooseApprovedBank([])).toThrow('PRECONDITION_NOT_MET');
  expect(() => chooseApprovedBank([a, b])).toThrow('candidateCount=2');
  expect(() => chooseApprovedBank([a], { accountId: 'B' })).toThrow('candidateCount=0');
  expect(chooseApprovedBank([b, a], { selectForFresh: true })).toBe(a);
  expect(chooseApprovedBank([a, b], { selectForFresh: true })).toBe(a);
  expect(() => chooseApprovedBank([a], { accountId: 'B', selectForFresh: true })).toThrow('candidateCount=0');
});

test('withdrawal account switch accepts two accounts exposing the same currency list', async ({ page }) => {
  await page.setContent(`<div><span>付款账户</span><button role="combobox" id="account">巴林账户</button></div>
    <div><span>币种</span><button role="combobox" id="currency">USD</button></div>
    <div role="listbox" id="options" hidden></div>
    <script>
      const box = document.getElementById('options');
      for (const id of ['account', 'currency']) document.getElementById(id).onclick = () => {
        box.replaceChildren(); box.hidden = false;
        for (const value of (id === 'account' ? ['巴林账户', '香港账户'] : ['USD'])) {
          const option = document.createElement('button'); option.setAttribute('role', 'option'); option.textContent = value;
          option.onclick = () => { document.getElementById(id).textContent = value; box.hidden = true; };
          box.append(option);
        }
      };
      document.addEventListener('keydown', event => { if (event.key === 'Escape') box.hidden = true; });
    </script>`);
  await new WithdrawalPage(page).selectAccount('香港账户');
  await expect(page.locator('#account')).toHaveText('香港账户');
  await expect(page.locator('#options')).toBeHidden();
});
test('standalone withdrawal snapshot does not fabricate a completed Golden Journey or save secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'withdrawal-snapshot-'));
  try {
    const runId = `WD-${defaultFiatUserKey(email)}-LOCAL`;
    const store = new DefaultWithdrawalSnapshot(runId, email, false, root);
    const data: WithdrawalJourneySnapshot = { updatedAt: new Date().toISOString(), fiatAddressReference: 'BANK-1', fiatAddressAccountSuffix: '1234',
      withdrawal: { runId, accountType: '香港账户', currency: 'USD', requestedAmount: '11.01', balanceBefore: '100',
        previousTransactionIds: [], confirmationClicks: 0, securityVerificationClicks: 0, approvalClicks: 0 } };
    Object.assign(data, { password: 'must-not-persist', stage: 'COMPLETED' });
    Object.assign(data.withdrawal!, { securityKey: 'must-not-persist' });
    store.save(data);
    const path = `${new FlowStateStore(root).pathFor('personal-golden-journey-withdrawal', runId)}.snapshot`;
    expect(readFileSync(path, 'utf8')).not.toMatch(/password|securityKey|must-not-persist|COMPLETED/);
    expect(store.load().fiatAddressReference).toBe('BANK-1');
    expect(() => new DefaultWithdrawalSnapshot(runId, 'other@example.test', false, root)).toThrow('bound');
    const dryId = `${runId}-DRY`;
    new DefaultWithdrawalSnapshot(dryId, email, true, root).save({ ...data, withdrawal: { ...data.withdrawal!, runId: dryId } });
    expect(existsSync(`${new FlowStateStore(root).pathFor('personal-golden-journey-withdrawal', dryId)}.snapshot`)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('deposit preserves original bank binding and single-submit tombstones', () => {
  const root = mkdtempSync(join(tmpdir(), 'deposit-bank-'));
  try {
    const run = new DepositRejectionRun('DP-LOCAL', defaultFiatUserKey(email), '香港账户', 'USD', '11.01', root);
    run.bindBank('BANK-A');
    expect(run.bankId()).toBe('BANK-A');
    expect(() => run.bindBank('BANK-B')).toThrow('must not change');
    run.attemptSubmit({ balanceBefore: '100', channel: 'SWIFT', previousTransactionIds: [], submittedAt: new Date().toISOString() });
    expect(() => run.attemptSubmit({ balanceBefore: '100', channel: 'SWIFT', previousTransactionIds: [], submittedAt: new Date().toISOString() })).toThrow('twice');
    expect(() => new DepositRejectionRun('DP-REPLACEMENT', defaultFiatUserKey(email), '香港账户', 'USD', '11.01', root)).toThrow('unfinished');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
