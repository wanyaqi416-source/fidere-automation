import { expect, test } from '@playwright/test';
import { TransactionDetailDrawer } from '../../pages/client/TransactionDetailDrawer';

const txn = 'TXN-20260915-abcdef12';
for (const [name, html, status] of [
  ['paragraph', '<div><p>拒绝原因</p><p>TEST REJECTION</p></div>', 'read'],
  ['generic element', '<div><span>拒绝原因</span><div>TEST REJECTION</div></div>', 'read'],
  ['missing value', '<div><p>拒绝原因</p></div>', 'unavailable'],
  ['duplicate labels', '<div><p>拒绝原因</p><p>A</p></div><div><p>拒绝原因</p><p>B</p></div>', 'unavailable'],
  ['missing optional field', '', 'absent']
] as const) {
  test(`optional rejection reason ${name} does not block original deposit detail`, async ({ page }) => {
    await page.setContent(`<div role="presentation"><h2>法币转入 详情</h2>
      <div>11.14<br>USD</div><p>手续费: 0.00 USD</p><p>已拒绝</p>
      <section><h3>详情</h3>${Object.entries({ '交易编号': txn, '账户类型': '香港账户', '创建日期': '2026-09-15', '审核时间': '2026-09-15' })
        .map(([label, value]) => `<div><p>${label}</p><p>${value}</p></div>`).join('')}</section>${html}</div>`);
    const detail = await new TransactionDetailDrawer(page, txn).readFiatDepositDetail();
    expect(detail).toMatchObject({ displayedTransactionNumber: txn, status: '已拒绝', amount: '11.14', currency: 'USD', rejectionReasonReadStatus: status });
    expect(detail.rejectionReason).toBe(status === 'read' ? 'TEST REJECTION' : undefined);
  });
}
