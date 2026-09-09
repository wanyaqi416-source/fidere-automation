import { test, expect } from '../../../fixtures/registration.fixture';
import { WebullOpeningPage } from '../../../pages/client/WebullOpeningPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment } from '../../../src/flow-engine';
import { PersonalPostRegistrationJourneyStore } from '../../../src/journey';
import { openPersonalJourneyClientSession } from '../../../src/registration';
import { assessWebullFunding, WEBULL_DOCUMENTS } from '../../../src/journey/webull-opening';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });

test('OPEN-WEBULL-001 微牛开户双文档提交前校验 @dry-run @L3', async ({ browser, business }) => {
  test.setTimeout(150_000);
  assertSandboxEnvironment(env.client.baseUrl);
  for (const key of ['ALLOW_MONEY_TESTS', 'ALLOW_CLIENT_MUTATION_TESTS', 'ALLOW_ADMIN_MUTATION_TESTS']) {
    expect(process.env[key] === 'true', `${key} must stay off in Webull Dry Run`).toBe(false);
  }
  const sourceRunId = process.env.BROKER_SOURCE_RUN_ID;
  if (!sourceRunId) throw new Error('BROKER_SOURCE_RUN_ID must identify an existing funded Journey.');
  const source = new PersonalPostRegistrationJourneyStore(sourceRunId).load();
  if (!source || source.stage !== 'COMPLETED') throw new Error('An existing completed Journey is required; no registration or funding is performed.');
  business.flow('webull-broker-opening-dry-run');
  for (const document of WEBULL_DOCUMENTS) business.setDocumentProgress({ ...document, field: document.label,
    file: 'Documenso在线文档（本次不创建）', status: 'PENDING' });
  const client = await openPersonalJourneyClientSession({ browser, baseURL: env.client.baseUrl!, runId: sourceRunId,
    email: source.email, password: env.client.password!, otp: env.client.otp!, forceFreshLogin: true });
  const blockedWrites: string[] = [];
  const readOnlyPosts = new Set(['/api/get-activitys-table', '/api/account/list-all', '/api/assets-overview', '/api/get-fiat-info', '/api/get-digital-info']);
  const webull = new WebullOpeningPage(client.page);
  try {
    // Authentication has finished. The remaining preflight is navigation and local form state only.
    await client.context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const readOnlyPost = request.method() === 'POST' && url.origin === new URL(env.client.baseUrl!).origin && readOnlyPosts.has(url.pathname);
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && !readOnlyPost) {
        blockedWrites.push(new URL(route.request().url()).pathname);
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    await business.step({ action: '读取原用户香港账户和微牛开户入口', expected: '原用户可登录，微牛尚未开户；读取实际费用，不新增账户或余额。' }, async step => {
      const accounts = new AccountDetailPage(client.page);
      await accounts.goto(env.client.baseUrl!);
      const balance = await accounts.readSnapshot('香港账户', 'USD');
      const { card, fee } = await webull.open(env.client.baseUrl!);
      const funding = assessWebullFunding({ available: balance.available, fee: fee.amount, currency: fee.currency });
      step.setBusinessData({ feeBalanceBefore: balance.available, openingFeeAmount: fee.amount, openingFeeCurrency: fee.currency });
      step.setActual(`微牛状态：${card.status}；页面开户费：${fee.amount} ${fee.currency}；香港USD可用余额：${balance.available}；${funding.status}，差额${funding.shortfall} USD。未确认扣费。`);
      if (funding.status === 'FUNDING_REQUIRED') step.recordDiagnostic({ id: 'funding', name: '开户前入金', status: 'info',
        summary: '余额不足，真实开户前需复用独立授权的入金流程并验证到账；本次不自动入金。', affectsCoreBusiness: false });
    });
    await business.step({ action: '检查W-8BEN和CRS两个独立文档入口', expected: '两份文档分别展示，尚未签署时不得进入最终开户提交；不创建签署文档。' }, async step => {
      const result = await webull.inspectUnsignedDocuments();
      for (const document of result.documents) step.setDocumentProgress({ id: document.id, field: document.label,
        file: 'Documenso在线文档（本次不创建）', status: 'PASS', actual: '独立签署入口已定位且可点击；仅入口检查通过，未实际签署。' });
      expect(blockedWrites, 'No business write should be requested during preflight').toEqual([]);
      if (/^0\s*\/\s*0/.test(result.progressText)) step.recordDiagnostic({ id: 'document-progress', name: '微牛资料进度展示', status: 'info',
        summary: '两份签署文档存在，但进度显示0 / 0；总进度不能代替逐份签署及Fidere回写证据。', affectsCoreBusiness: false });
      step.setActual(`W-8BEN及CRS分别关联唯一去签署按钮；页面进度：${result.progressText}；下一步禁用。文档创建、签署、开户提交、安全验证及Admin审核均为0次。`);
      step.recordPrimaryOracle({ id: 'webull-preflight', name: '双文档提交前校验', expected: '两个独立入口，未签署时下一步禁用，无业务写请求',
        actual: '独立文档入口2个；下一步禁用；写请求0', status: 'passed' });
    });
  } finally {
    await client.context.close();
  }
});
