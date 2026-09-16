import { expect, test } from '@playwright/test';
import { TransactionsPage } from '../../pages/client/TransactionsPage';

const txn = 'TXN-20260914-test1234';
const headers = ['交易类型', '网络', '账户类型', '交易金额', '状态', '时间', '交易编号'];
const criteria = {
  accountType: '香港账户', currency: 'USD', requestedAmount: '11.66',
  submittedFromMs: Date.parse('2026-09-14T17:30:00+08:00'),
  submittedToMs: Date.parse('2026-09-14T17:40:00+08:00'), status: /待处理/
};

for (const time of ['<p>2026-09-14</p><div>17:35:31</div>', '2026-09-14 17:35:31']) {
  test(`deposit date and time remain parseable (${time.startsWith('<') ? 'split elements' : 'single text'})`, async ({ page }) => {
    await page.setContent(`<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>
      <tr>${['<p>法币转入</p><div>TEST BANK</div>', '', '<p>香港账户</p>', '+11.66 USD', '待处理', time, txn].map(v => `<td>${v}</td>`).join('')}</tr>
      </tbody></table>`);
    const transactions = new TransactionsPage(page);
    const records = await transactions.readVisibleDepositRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ledgerTransactionId: txn, requestedAmount: '11.66',
      occurredAt: '2026-09-14 17:35:31', occurredAtMs: Date.parse('2026-09-14T17:35:31+08:00') });
    expect((await transactions.diagnoseDepositRecords(criteria)).candidates).toHaveLength(1);
    expect((await transactions.diagnoseDepositRecords({ ...criteria, excludedLedgerTransactionIds: new Set([txn]) })).candidates).toHaveLength(0);
    expect((await transactions.diagnoseDepositRecords({ ...criteria, requestedAmount: '11.67' })).candidates).toHaveLength(0);
    expect((await transactions.diagnoseDepositRecords({ ...criteria, accountType: '巴林账户' })).candidates).toHaveLength(0);
    expect((await transactions.diagnoseDepositRecords({ ...criteria, submittedToMs: criteria.submittedFromMs })).candidates).toHaveLength(0);
    expect((await transactions.diagnoseDepositRecords({ ...criteria, status: /已完成/ })).candidates).toHaveLength(0);
    expect((await transactions.depositRecordById(txn))?.ledgerTransactionId).toBe(txn);
  });
}

test('two matching Client deposits remain ambiguous', async ({ page }) => {
  await page.setContent(`<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${[txn, 'TXN-20260914-test5678'].map(id =>
    `<tr>${['法币转入', '', '香港账户', '+11.66 USD', '待处理', '<p>2026-09-14</p><div>17:35:31</div>', id].map(v => `<td>${v}</td>`).join('')}</tr>`
  ).join('')}</tbody></table>`);
  const transactions = new TransactionsPage(page);
  expect((await transactions.diagnoseDepositRecords(criteria)).candidates).toHaveLength(2);
  await expect(transactions.findUniqueDepositRecord(criteria)).rejects.toThrow('2');
});
