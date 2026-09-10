import { test, expect } from '@playwright/test';
import { renderBusinessReport } from '../../src/reporting/html-template';
import type { BusinessReportRun } from '../../src/reporting/business-report.types';

function fixture(): BusinessReportRun {
  return {
    title: 'Fidere 自动化测试报告', runId: 'private-run-reference', flowId: 'flow-id', flowName: '转账审核',
    environment: 'Sandbox', hostname: 'sandbox.test', startedAt: '2026/09/10 17:00:00', endedAt: '', finishedAt: '',
    durationMs: 49800, command: 'test', projects: [], browsers: [], executionMode: '本地',
    summary: { total: 1, passed: 1, passedWithWarning: 0, failed: 0, skipped: 0, blocked: 0, timedOut: 0, interrupted: 0, manualReview: 0, passRate: 100 },
    cases: [{
      flowId: 'flow-id', caseId: 'CASE-001', module: '用户转账', name: '用户转账 Admin 审核', description: '', priority: 'P0', level: 'L4', type: [], scope: '', owner: '', requirement: '', tags: [], preconditions: [], target: '', expectedResult: '', changesData: true, affectsMoney: true, dependsOnAdmin: true, dependsOnThirdParty: false, safetySwitches: ['ALLOW_MONEY_TESTS'], rawStatus: 'passed', displayStatus: '通过', statusKey: 'passed', businessOutcome: 'PASS', startedAt: '', durationMs: 49800,
      businessData: { candidateCount: 1 }, steps: [
        { action: '1. 完整分页唯一定位及详情二次核对', expected: '原TXN、双方、币种、金额和待审核状态全部匹配', actual: 'candidateCount=1，原详情全部匹配', status: 'passed', durationMs: 35000 },
        { action: '2. 批准原订单一次并确认成功', expected: '唯一原TXN批准一次且已批准', actual: '原TXN已批准，批准1次；没有新建交易', status: 'passed', durationMs: 7400 }
      ],
      oracles: [{ id: 'unique', name: 'candidateCount=1', expected: '1', actual: '1', status: 'passed', level: 'primary' }, { id: 'immutable', name: 'original TXN immutable', expected: '', actual: '', status: 'passed', level: 'primary' }],
      diagnostics: [{ id: 'search', name: 'Admin search', status: 'unavailable', summary: '搜索框未加载', affectsCoreBusiness: false }], warnings: [], failedStep: '', failureSummary: '', failureExpected: '', failureActual: '', technicalError: '', review: { manualReviewRequired: false, potentiallySubmitted: false, duplicateSubmissionRisk: false, safeToRerun: false }, evidence: []
    }]
  };
}

test('business first, diagnostics unscored, technical content preserved and expandable', async ({ page }) => {
  const report = fixture();
  const before = JSON.stringify(report);
  await page.setContent(renderBusinessReport(report));
  expect(JSON.stringify(report)).toBe(before);
  await expect(page.locator('.biz-metrics > div')).toHaveCount(5);
  await expect(page.locator('.biz-metrics > div').last()).toContainText('通过率100.0%');
  await expect(page.locator('.business-overview')).not.toContainText('candidateCount');
  await expect(page.locator('.biz-results thead')).toHaveText(/序号测试场景测试步骤预期结果实际结果测试结果/);
  await expect(page.locator('.biz-results tbody tr')).toHaveCount(1);
  await expect(page.locator('.biz-results tbody tr').first()).toContainText('验证用户转账申请能够在管理端正确查询并完成审核');
  await expect(page.locator('.biz-results tbody tr').first()).toContainText('唯一匹配到1条本次业务记录');
  await expect(page.locator('.biz-results tbody tr').first().locator('td').nth(2).locator('li')).toHaveCount(5);
  await expect(page.locator('.business-overview h2', { hasText: '业务验证' })).toHaveCount(0);
  await expect(page.locator('#technical-details')).not.toHaveAttribute('open', '');
  const runReference = page.locator('.run-meta > div').filter({ hasText: 'private-run-reference' });
  await expect(runReference).toBeHidden();
  await page.locator('#technical-details > summary').click();
  await expect(runReference).toBeVisible();
  await page.locator('.link-button').click();
  await expect(page.locator('#case-0')).toHaveAttribute('open', '');
  await expect(page.locator('#case-0')).toContainText('candidateCount=1');
});

test('older reports without steps fall back to primary business oracles', async ({ page }) => {
  const report = fixture();
  report.cases[0].steps = [];
  await page.setContent(renderBusinessReport(report));
  await expect(page.locator('.biz-results tbody tr')).toHaveCount(1);
  await expect(page.locator('.biz-results')).toContainText('原交易数据保持一致');
  await expect(page.locator('.biz-results')).not.toContainText('original TXN immutable');
});

for (const outcome of ['FAIL', 'BLOCKED', 'MANUAL_REVIEW', 'PASS_WITH_WARNING', 'NOT_RUN'] as const) {
  test(`preserves ${outcome} without exposing exception in business view`, async ({ page }) => {
    const report = fixture();
    report.cases[0].businessOutcome = outcome;
    report.cases[0].failureActual = 'Error: locator("#secret").click() timeout';
    report.cases[0].technicalError = 'original technical error';
    await page.setContent(renderBusinessReport(report));
    await expect(page.locator('.biz-header > strong')).not.toHaveText('✅ 测试通过');
    await expect(page.locator('.business-overview')).not.toContainText('locator(');
    expect(await page.content()).toContain('original technical error');
  });
}

test('responsive report, conclusion visible on desktop and no script injection', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const report = fixture();
  report.cases[0].name = '<script>window.bad = true</script>用户转账';
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(renderBusinessReport(report));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 1440) await expect(page.locator('.biz-conclusion')).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath(`business-${width}.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});
