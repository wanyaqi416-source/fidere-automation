import { expect, type Page, type Route, type TestInfo } from '@playwright/test';
import { OperationsCustomersPage } from '../../pages/admin/OperationsCustomersPage';
import { env } from '../config/env';
import { assertSandboxEnvironment, MoneyMutationGuard, requireExactlyOneCandidate } from '../flow-engine';
import { PersonalPostRegistrationJourneyStore } from '../journey';
import type { BusinessReportApi } from '../reporting/business-report.types';
import { maskSensitiveText } from '../reporting/sensitive-data-mask';
import {
  COUNTRY_LABELS, matchOperationsCustomers, operationsOpeningFlowId, OperationsOpeningRun,
  validateOperationsOpeningForm, operationsOpeningFeeInput, type OpeningCountry, type OperationsOpeningForm, type OperationsOpeningIdentity
} from './admin-operations-opening';

function config(country: OpeningCountry, dryRun: boolean) {
  const sourceRunId = process.env.ADMIN_OPENING_SOURCE_RUN_ID;
  const source = sourceRunId ? new PersonalPostRegistrationJourneyStore(sourceRunId).load() : undefined;
  if (sourceRunId && !source) throw new Error('Existing Admin opening source Journey not found; never create a replacement user.');
  const email = source?.email ?? process.env.ADMIN_OPENING_EMAIL;
  const displayName = source?.displayName ?? process.env.ADMIN_OPENING_DISPLAY_NAME;
  const accountType = source?.accountType ?? process.env.ADMIN_OPENING_ACCOUNT_TYPE;
  const userId = process.env.ADMIN_OPENING_USER_ID;
  if (!email || !displayName || !userId || !/^\d+$/.test(userId) || !['PERSONAL', 'BUSINESS'].includes(accountType ?? '')) {
    throw new Error('An existing Sandbox user email, display name, userId and PERSONAL/BUSINESS type are required.');
  }
  const identity: OperationsOpeningIdentity = { email, displayName, userId, accountType: accountType as 'PERSONAL' | 'BUSINESS' };
  const runId = dryRun ? `ADMIN-OPEN-${country}-DRY-${Date.now()}` : process.env.ADMIN_OPENING_RUN_ID;
  if (!runId || !/^[A-Z0-9._-]+$/i.test(runId)) throw new Error('Named Admin country-opening Run required.');
  if (!dryRun && process.env.ADMIN_OPENING_AUTHORIZED_COUNTRY !== country) {
    throw new Error('Authorize exactly this country before opening; BH authorization never authorizes SG.');
  }
  const form: OperationsOpeningForm = {
    holder: process.env.ADMIN_OPENING_HOLDER || displayName,
    accountNumber: dryRun ? `SANDBOX-${country}-DRY` : process.env.ADMIN_OPENING_ACCOUNT_NUMBER || '',
    iban: process.env.ADMIN_OPENING_IBAN || '',
    fee: operationsOpeningFeeInput(dryRun ? '0' : process.env.ADMIN_OPENING_AUTHORIZED_FEE, process.env.ADMIN_OPENING_FEE_INPUT),
    note: `AUTO_SANDBOX_${runId}`
  };
  validateOperationsOpeningForm(form);
  return { sourceRunId, runId, identity, form };
}

export async function runOperationsOpening(input: {
  adminPage: Page; business: BusinessReportApi; testInfo: TestInfo; country: OpeningCountry; dryRun: boolean;
}): Promise<void> {
  const { adminPage, business, testInfo, country, dryRun } = input;
  const flowId = operationsOpeningFlowId(country);
  business.flow(dryRun ? `${flowId}-dry-run` : flowId);
  const { runId, sourceRunId, identity, form } = config(country, dryRun);
  const guard = new MoneyMutationGuard(flowId);
  const switches = { ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests };
  assertSandboxEnvironment(env.admin.baseUrl);
  expect(testInfo.config.workers).toBe(1);
  expect(testInfo.project.retries).toBe(0);
  expect(testInfo.project.repeatEach).toBe(1);
  expect(testInfo.retry + testInfo.repeatEachIndex).toBe(0);
  if (dryRun) expect(env.allowAdminMutationTests || env.allowClientMutationTests || env.exchange.allowMoneyTests).toBe(false);
  else guard.validateRuntime({ baseURL: env.admin.baseUrl, workers: testInfo.config.workers, retries: testInfo.project.retries,
    repeatEach: testInfo.project.repeatEach, safetySwitches: switches });
  const run = dryRun ? undefined : new OperationsOpeningRun(runId, country, identity, form);
  const page = new OperationsCustomersPage(adminPage);
  const blockedPaths: string[] = [];
  const blockWrites = async (route: Route) => {
    const request = route.request();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && !page.isReadonlyList(request)) {
      blockedPaths.push(new URL(request.url()).pathname);
      await route.abort('blockedbyclient');
    } else await route.continue();
  };
  business.setBusinessData({ runId, sourceRunId, registrationTestName: identity.displayName,
    registrationLoginIdentity: maskSensitiveText(identity.email), accountType: identity.accountType,
    targetAccountType: COUNTRY_LABELS[country], openingFeeAmount: form.fee || '0', openingFeeCurrency: 'N/A（免费）',
    beneficiaryAccountSuffix: `****${form.accountNumber.slice(-4)}`, dryRun, finalSubmissionClicks: 0 });
  business.setResumeState(run?.state().stage ?? 'PREPARED');
  try {
    await business.step({ action: '1. 进入运营客户页面，确认原用户和地区账户状态',
      expected: 'Admin认证有效；邮箱、用户ID、个人/企业类型和启用状态一致；本地区未开通。' }, async step => {
      await page.goto(env.admin.baseUrl!);
      await page.searchEmail(identity.email);
      const status = run?.attempted() ? '已开户' : '未开通';
      const match = matchOperationsCustomers(await page.readRows(), identity, country, status);
      step.setBusinessData({ candidateCount: match.candidates.length,
        candidateStageCounts: match.stages.map(stage => ({ field: stage.label, count: stage.candidateCount })),
        adminBeforeStatus: status });
      const candidate = requireExactlyOneCandidate(match.candidates, flowId);
      expect(candidate.displayName === identity.displayName, 'The original customer display name must match').toBe(true);
      run?.located(identity.userId);
      business.setResumeState(run?.state().stage ?? 'ADMIN_LOCATED');
      step.setActual(`${COUNTRY_LABELS[country]}${status}；原客户逐层匹配后candidateCount=1。`);
    });
    if (dryRun) await adminPage.context().route('**/*', blockWrites);
    if (!run?.attempted()) {
      await business.step({ action: '2. 打开本地区开户表单并二次核对',
        expected: '只打开本地区开通按钮；弹窗客户、UID、账户类型和后台手动开通来源一致。' }, async step => {
        await page.openCountryForm(identity, country);
        step.setActual(`${COUNTRY_LABELS[country]}开户弹窗已打开，未触发确认开通。`);
      });
      await business.step({ action: '3. 填写收款银行信息与开户设置',
        expected: '收款人、账号必填；IBAN和备注按配置；验证明确的零费用分支及确认开通按钮。' }, async step => {
        await page.fillForm(form);
        await page.expectFormIdentity(identity, country);
        step.setActual(`必填字段均已填写并回读一致；${form.fee === '' ? '费用框保持空白，未输入费用，按页面提示为免费' : '开户费0'}；币种控件禁用，确认开通按钮可用。`);
      });
      if (dryRun) {
        await business.step({ action: '4. 取消表单，确认未创建地区账户', expected: '最终确认0次，开户请求0次，原地区仍未开通。' }, async step => {
          await page.cancel();
          await adminPage.context().unroute('**/*', blockWrites);
          await page.goto(env.admin.baseUrl!);
          await page.searchEmail(identity.email);
          requireExactlyOneCandidate(matchOperationsCustomers(await page.readRows(), identity, country, '未开通').candidates, flowId);
          expect(blockedPaths).toEqual([]);
          expect(page.counts().finalSubmissionClicks).toBe(0);
          step.recordPrimaryOracle({ id: 'operations-opening-dry-run', name: '运营开户表单真实可用且未提交',
            expected: '候选唯一、表单可填、最终点击0、仍未开通', actual: '全部通过', status: 'passed' });
          step.setBusinessData({ finalSubmissionClicks: 0, mutationPerformed: false, finalStatus: 'Dry Run通过，未开户', confirmed: true });
          step.setActual('Dry Run通过，账户仍未开通；没有确认开通、扣费或Client操作。');
        });
        return;
      }
      await business.step({ action: '4. Admin确认开通一次', expected: '重新核对表单和权限；先持久化attempt，再点击确认开通一次。' }, async step => {
        await page.expectFormIdentity(identity, country);
        await page.expectFormValues(form);
        guard.validateRuntime({ baseURL: adminPage.url(), workers: testInfo.config.workers, retries: testInfo.project.retries,
          repeatEach: testInfo.project.repeatEach, safetySwitches: switches });
        await page.confirmOnce(() => {
          run!.attempt();
          business.setResumeState(run!.state().stage);
          step.markPotentiallySubmitted();
          step.disallowSafeRerun();
        });
        business.markMutationPerformed(`Admin开通${COUNTRY_LABELS[country]}`);
        await page.waitForConfirmationClosed();
        step.setBusinessData(page.counts());
        step.setActual('确认开通已点击一次；随后只读查询原客户，不重复提交。');
      });
    }
    await business.step({ action: '5. 重新查询原客户，验证本地区已开户',
      expected: '同一邮箱/UID/类型的唯一客户，本地区已开户且账号、收款人与本次配置一致。' }, async step => {
      step.disallowSafeRerun();
      await expect.poll(async () => {
        await page.goto(env.admin.baseUrl!);
        await page.searchEmail(identity.email);
        const match = matchOperationsCustomers(await page.readRows(), identity, country, '已开户');
        if (match.candidates.length !== 1) return false;
        const account = match.candidates[0].countries[country];
        return account.accountNumber === form.accountNumber && account.holder === form.holder;
      }, { timeout: 60_000 }).toBe(true);
      run!.complete();
      business.setResumeState('COMPLETED');
      step.setBusinessData({ ...page.counts(), finalStatus: `${COUNTRY_LABELS[country]}已开户`, confirmed: true });
      step.recordPrimaryOracle({ id: 'operations-country-opened', name: '原客户指定地区账户开通成功',
        expected: '已开户且账户信息匹配', actual: '重新查询真实列表，原用户本地区已开户、账号和收款人匹配', status: 'passed' });
      step.setActual(`${COUNTRY_LABELS[country]}开通成功；原用户保持不变，未操作另一地区账户。`);
    });
  } catch (error) {
    if (run?.attempted() && run.state().stage !== 'COMPLETED') {
      business.requireManualReview('OPERATIONS_OPENING_UNCONFIRMED：仅允许查询同一客户同一地区；禁止重复确认开通。');
    }
    throw error;
  } finally {
    business.setBusinessData(page.counts());
    if (dryRun) await adminPage.context().unroute('**/*', blockWrites);
  }
}
