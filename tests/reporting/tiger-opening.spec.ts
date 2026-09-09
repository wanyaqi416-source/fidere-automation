import { test, expect } from '@playwright/test';
import { matchTigerOpening } from '../../src/journey/tiger-opening';
import type { BrokerOpeningRow } from '../../pages/admin/BrokerOpeningReviewPage';
import { BrokerOpeningReviewPage } from '../../pages/admin/BrokerOpeningReviewPage';
import { SecuritiesTradingPage } from '../../pages/client/SecuritiesTradingPage';
import { advanceFlowState, createPreparedFlowState } from '../../src/flow-engine';

const row: BrokerOpeningRow = { customerText: 'TEST SANDBOX AH\nah@example.test', accountType: '个人', broker: 'TIGER（老虎证券）',
  submittedAt: '2026-09-08 16:30', status: '待处理', reference: '99', detailPath: '/zh-CN/kyc/brokerAccountManagement/99' };
const input = { email: 'ah@example.test', displayName: 'TEST SANDBOX AH', submittedFrom: '2026-09-08T08:30:10Z', submittedTo: '2026-09-08T08:30:20Z' };
test('Tiger matches actual broker label, email, personal type and minute-precision time', () => {
  expect(matchTigerOpening([row], input).candidates).toHaveLength(1);
});
test('Tiger excludes another user, broker, time or pinned application; never hides duplicates', () => {
  for (const changed of [{ customerText: 'TEST SANDBOX AH\nother@example.test' }, { broker: 'webull（Webull 微牛证券）' }, { submittedAt: '2026-08-24 18:33' }]) {
    expect(matchTigerOpening([{ ...row, ...changed }], input).candidates).toHaveLength(0);
  }
  expect(matchTigerOpening([row], { ...input, reference: '98' }).candidates).toHaveLength(0);
  expect(matchTigerOpening([row, { ...row, reference: '100' }], input).candidates).toHaveLength(2);
});

test('Broker approval confirmation stage cannot roll back a final submission attempt', () => {
  const located = advanceFlowState(createPreparedFlowState({ runId: 'UNIT-TIGER', flowId: 'tiger-broker-opening' }), 'ADMIN_LOCATED', { clientReference: '99' });
  const opened = advanceFlowState(located, 'ADMIN_APPROVAL_CONFIRMATION_REQUIRED');
  const attempted = advanceFlowState(opened, 'ADMIN_APPROVAL_SUBMISSION_ATTEMPTED');
  expect(() => advanceFlowState(attempted, 'ADMIN_APPROVAL_CONFIRMATION_REQUIRED')).toThrow('advance');
});

test('Broker state is readable while its action is review progress, not open/detail', async ({ page }) => {
  await page.setContent('<section><h6>老虎证券</h6><p>审核中</p><p>开户费用</p><p>100.00 USD</p><p>可投市场</p><p>美股</p><button>查看审核进度</button></section>');
  expect(await new SecuritiesTradingPage(page).readBrokerStatus('老虎证券')).toBe('审核中');
});

test('Opening the broker approval dialog is not a final approval', async ({ page }) => {
  await page.route('https://broker.example.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<button id="open">保存处理结果</button><div role="dialog" hidden><h2>审核通过</h2><button>确认通过</button></div><script>document.getElementById("open").onclick=()=>document.querySelector("[role=dialog]").hidden=false</script>' }));
  await page.goto('https://broker.example.test/');
  const admin = new BrokerOpeningReviewPage(page);
  await admin.openApprovalConfirmationOnce();
  expect(admin.approvalFormOpenClickCount()).toBe(1);
  expect(admin.approvalClickCount()).toBe(0);
  await expect(admin.openApprovalConfirmationOnce()).rejects.toThrow('only open once');
});
