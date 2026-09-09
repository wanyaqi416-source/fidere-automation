import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { UserToUserTransferPage } from '../../pages/client/UserToUserTransferPage';
import { SecurityKeyDialog } from '../../pages/client/SecurityKeyDialog';
import { getFlowDefinition } from '../../config/flow-registry';
import { parseU2uAmount, verifyU2uSummary, formatU2uBalance } from '../../src/user-transfer/u2u-summary';
import { decodeClientKycStatus } from '../../src/registration/registration-kyc-contract';
import { TransactionDetailDrawer } from '../../pages/client/TransactionDetailDrawer';
import { TransactionsPage } from '../../pages/client/TransactionsPage';
import { MoneyMutationGuard } from '../../src/flow-engine/mutation-guard';
import { createPreparedFlowState } from '../../src/flow-engine/resume-state';
import { assertU2uFreshAllowed } from '../../src/user-transfer/u2u-evidence';
import { matchesU2uLedger } from '../../src/user-transfer/u2u-reconciliation';

test('U2U reads the correct approval state for an existing Business Sender', () => {
  const result = decodeClientKycStatus({ user: { email: 'sender@example.test' }, entityType: '2', kyc_status: '0', kyb_status: '1' },
    { accountType: 'BUSINESS', email: 'sender@example.test' });
  expect(result.approved).toBe(true);
});

test('U2U uses Decimal, supports free and does not parse the 20 in TRC20 as an amount', () => {
  expect(parseU2uAmount('USDT_TRC20 0.11', 'USDT_TRC20').eq('0.11')).toBe(true);
  expect(parseU2uAmount('免费', 'USD', true).isZero()).toBe(true);
  const quote = verifyU2uSummary({ currency: 'USD', requestedAmount: '40.11', displayedAmount: 'USD 40.11', displayedFee: '40.00 USD', displayedCredit: '0.11 USD', feeDeductedFromAmount: true });
  expect(quote).toEqual({ amount: '40.11', fee: '40', expectedCredit: '0.11', transferable: true });
  expect(verifyU2uSummary({ currency: 'USD', requestedAmount: '0.11', displayedAmount: 'USD 0.11', displayedFee: '40.00 USD', displayedCredit: '0.00 USD', feeDeductedFromAmount: true }).transferable).toBe(false);
  expect(formatU2uBalance('123456789012345678.39')).toBe('123,456,789,012,345,678.39');
});

test('U2U uses the observed email input without a label association', async ({ page }) => {
  await page.setContent('<main><h1>转账给其他用户</h1><main><h6>收款用户邮箱</h6><input type="email"><div>手续费（从金额内扣）</div><div>收款用户及账户资格将在提交时由系统校验。</div><button disabled>确认并提交审核</button></main></main>');
  const transfer = new UserToUserTransferPage(page);
  await transfer.fillRecipient('sender@example.test', 'recipient@example.test');
  expect(await transfer.recipientInput.inputValue()).toBe('recipient@example.test');
  const observed = await transfer.inspectForm();
  expect(observed.feeDeductedFromAmount).toBe(true);
  expect(observed.eligibilityCheckedAtSubmission).toBe(true);
  expect(observed.submitEnabled).toBe(false);
  expect(transfer.security).toBeInstanceOf(SecurityKeyDialog);
  expect(transfer.security.verificationClickCount()).toBe(0);
});

test('U2U rejects self-transfer before filling or submitting', async ({ page }) => {
  const transfer = new UserToUserTransferPage(page);
  await expect(transfer.fillRecipient('sender@example.test', ' SENDER@example.test ')).rejects.toThrow('distinct');
});

test('U2U requires Admin approval after the corrected business rule and stays outside default regression', () => {
  const flow = getFlowDefinition('user-to-user-transfer');
  expect(flow.requiresAdmin).toBe(true);
  expect(flow.adminAction).toBe('Approve');
  expect(flow.requiresSecurityKey).toBe(true);
  expect(flow.defaultRegression).toBe(false);
  expect(flow.implemented).toBe(true);
  expect(flow.npmScript).toBe('test:client:u2u');
  expect(flow.safetySwitches).toEqual(['ALLOW_MONEY_TESTS', 'ALLOW_CLIENT_MUTATION_TESTS', 'ALLOW_ADMIN_MUTATION_TESTS']);
});

test('U2U guards single confirmation, security verification and previously attempted runs', () => {
  const guard = new MoneyMutationGuard('user-to-user-transfer', false, true);
  const flags = { ALLOW_MONEY_TESTS: true, ALLOW_CLIENT_MUTATION_TESTS: true };
  guard.validateRuntime({ baseURL: 'https://sandbox.example.test', workers: 1, retries: 0, repeatEach: 1, safetySwitches: flags });
  guard.markAuthenticationReady(true, false);
  expect(() => guard.assertSecurityKeyVerificationAllowed(flags)).toThrow('one Client money');
  guard.assertClientMoneyConfirmationAllowed(flags);
  guard.recordClientMoneyConfirmation();
  expect(() => guard.assertClientMoneyConfirmationAllowed(flags)).toThrow('once');
  guard.assertSecurityKeyVerificationAllowed(flags);
  guard.recordSecurityKeyVerification();
  expect(() => guard.assertSecurityKeyVerificationAllowed(flags)).toThrow('once');
  expect(() => guard.assertClientSubmissionAllowed({ ALLOW_MONEY_TESTS: false })).toThrow('closed');
  const previous = { ...createPreparedFlowState({ runId: 'previous', flowId: 'user-to-user-transfer' }), stage: 'CLIENT_SUBMIT_ATTEMPTED' as const };
  expect(() => assertU2uFreshAllowed([previous], 'new')).toThrow('replacement');
});

test('U2U approval is the terminal success oracle without settlement requirements', () => {
  for (const id of ['user-to-user-transfer-approve-resume', 'user-to-user-transfer-settlement']) {
    const flow = getFlowDefinition(id);
    expect(flow.primaryOracles.join(' ')).toContain('提交成功');
    expect(flow.primaryOracles.join(' ')).not.toMatch(/余额|流水|到账/);
    expect(flow.secondaryOracles).toEqual([]);
    expect(flow.defaultRegression).toBe(false);
  }
  for (const file of ['user-transfer-approve-resume.spec.ts', 'user-transfer-settlement.readonly.spec.ts']) {
    const source = readFileSync(`tests/e2e/user-transfer/${file}`, 'utf8');
    expect(source).not.toMatch(/reconcileU2u|readU2uBalance|locateU2uLedger|U2U_ADMIN_RESULT_ONLY|CLIENT_FINALIZED/);
    expect(source).toContain("'COMPLETED'");
    expect(source).toContain("finalStatus: '审核提交成功（Admin已批准）'");
    expect(source).toContain('manualCheckRequired: false');
  }
});

test('U2U confirmation cannot be clicked twice even when waiting for security fails', async ({ page }) => {
  await page.setContent('<main><h1>转账给其他用户</h1><button>确认并提交审核</button></main>');
  const transfer = new UserToUserTransferPage(page);
  transfer.security.waitForOpen = async () => { throw new Error('test security unavailable'); };
  await expect(transfer.confirmOnce()).rejects.toThrow('unavailable');
  await expect(transfer.confirmOnce()).rejects.toThrow('already attempted');
  expect(transfer.confirmationClickCount()).toBe(1);
});

test('U2U ledger uses its own real record type, signed amount, account and original time window', async ({ page }) => {
  await page.setContent('<table><thead><tr><th>交易类型</th><th>网络</th><th>账户类型</th><th>交易金额</th><th>状态</th><th>时间</th><th>交易编号</th></tr></thead><tbody><tr><td>用户转账 香港账户 → 收款用户</td><td></td><td>香港账户</td><td>-40.11 USD</td><td>已完成</td><td>2026-09-07<br>17:00:00</td><td>TXN-20260907-test001</td></tr><tr><td>资金互转</td><td></td><td>香港账户</td><td>-40.11 USD</td><td>已完成</td><td>2026-09-07 17:00:00</td><td>TXN-20260907-test002</td></tr></tbody></table>');
  const records = await new TransactionsPage(page).readVisibleUserTransferRecords();
  expect(records).toHaveLength(1);
  const criteria = { currency: 'USD', accountType: '香港账户', signedAmount: '-40.11', submittedAt: new Date('2026-09-07T16:59:59').toISOString(), excludedIds: [] as string[] };
  expect(matchesU2uLedger(records[0], criteria)).toBe(true);
  expect(matchesU2uLedger(records[0], { ...criteria, signedAmount: '40.11' })).toBe(false);
  expect(matchesU2uLedger(records[0], { ...criteria, accountType: '新加坡账户' })).toBe(false);
  expect(matchesU2uLedger(records[0], { ...criteria, excludedIds: [records[0].ledgerTransactionId] })).toBe(false);
});

test('U2U detail separates TRF and TXN and reads real neighboring label values', async ({ page }) => {
  const field = (label: string, value: string) => `<div><p>${label}</p><div><p>${value}</p></div></div>`;
  await page.setContent(`<div role="presentation"><p>用户转账详情</p><div>已完成</div><div>手续费: 40.00 USD</div>${field('订单编号', 'TRF-test001')}${field('交易编号', 'TXN-test002')}${field('申请时间', '2026-09-07 17:00:00')}${field('账户地区', '香港账户')}${field('收款邮箱', 'recipient@example.test')}${field('账户地区', '香港账户')}</div>`);
  const detail = await new TransactionDetailDrawer(page, 'TXN-test002').readUserTransferDetail();
  expect(detail.orderId).toBe('TRF-test001');
  expect(detail.ledgerTransactionId).toBe('TXN-test002');
  expect(detail.fee).toBe('40');
  expect(detail.regions).toEqual(['香港账户', '香港账户']);
  await page.getByText('已完成', { exact: true }).evaluate(element => { element.textContent = '审核中'; });
  expect((await new TransactionDetailDrawer(page, 'TXN-test002').readUserTransferDetail()).status).toBe('审核中');
});
