import { AccountOpeningReviewPage } from '../../../pages/admin/AccountOpeningReviewPage';
import { AccountTypeConfigurationPage } from '../../../pages/admin/AccountTypeConfigurationPage';
import { JurisdictionAccountChooserPage } from '../../../pages/client/JurisdictionAccountChooserPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { resolveUsOpeningDocumentAssets } from '../../../src/account-opening/account-opening-assets';
import { runUsAccountOpeningAuthPreflight } from '../../../src/account-opening/account-opening-auth-preflight';
import { UsAccountOpeningExecutionGuard } from '../../../src/account-opening/account-opening-e2e';
import { env } from '../../../src/config/env';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'OPEN-US-PREFLIGHT 美国账户开户真实执行前只读检查',
  {
    tag: ['@e2e', '@account-opening', '@us', '@readonly', '@preflight', '@L2'],
    annotation: [
      { type: 'caseId', description: 'OPEN-US-PREFLIGHT' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ clientPage, adminPage, business }, testInfo) => {
    test.setTimeout(120_000);
    if (!env.client.baseUrl || !env.admin.baseUrl || !env.accountOpening.testEmail) {
      throw new Error('Client/Admin URLs and OPENING_TEST_EMAIL are required.');
    }
    expect(testInfo.config.workers).toBe(1);
    expect(testInfo.project.retries).toBe(0);
    expect(testInfo.project.repeatEach).toBe(1);
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);

    business.case({
      caseId: 'OPEN-US-PREFLIGHT',
      module: '美国账户开户',
      name: '美国账户开户真实执行前只读检查',
      priority: 'P0',
      level: 'L2',
      type: ['Readonly', 'Preflight', 'External Sandbox'],
      scope: 'Client + Admin + Third Party',
      preconditions: ['专用Sandbox开户用户', 'Client自动认证', 'Admin storageState有效'],
      target: '在任何不可逆操作前确认账号、资料、Documenso网络、Admin入口和Interlace配置。',
      expectedResult: '美国账户仍可申请、无既有美国开户记录、全部依赖可用且Mutation开关关闭。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: true,
      safetySwitches: []
    });

    const guard = new UsAccountOpeningExecutionGuard();
    const chooser = new JurisdictionAccountChooserPage(clientPage);
    const reviews = new AccountOpeningReviewPage(adminPage);
    const accountTypes = new AccountTypeConfigurationPage(adminPage);
    const assets = resolveUsOpeningDocumentAssets();

    await business.step(
      {
        action: '1. 验证Sandbox与双端认证',
        expected: 'Admin先通过真实业务页验证，Client随后通过仪表板验证'
      },
      async ({ setActual }) => {
        await runUsAccountOpeningAuthPreflight({
          clientPage,
          adminPage,
          clientBaseUrl: env.client.baseUrl!,
          adminBaseUrl: env.admin.baseUrl!,
          guard
        });
        setActual('Client与Admin认证有效，均停留在Sandbox业务页面。');
      }
    );

    await business.step(
      {
        action: '2. 核对专用用户美国账户状态',
        expected: '美国账户未开通且存在唯一申请入口'
      },
      async ({ setActual, setBusinessData, recordPrimaryOracle }) => {
        await chooser.goto(env.client.baseUrl!);
        await chooser.openChooser();
        const option = await chooser.readOption('美国账户');
        expect(option.status).toBe('可申请');
        expect(option.actionAvailable).toBe(true);
        setBusinessData({ usOpeningStatusBefore: option.status });
        recordPrimaryOracle({
          id: 'OPEN-US-PRE-1',
          name: '执行前美国账户未开通',
          expected: '可申请',
          actual: option.status,
          status: 'passed'
        });
        setActual('美国账户仍未开通，申请入口唯一可用。');
      }
    );

    await business.step(
      {
        action: '3. 核对Admin不存在既有美国账户申请',
        expected: '配置邮箱的历史记录中美国账户候选数为0'
      },
      async ({ setActual, setBusinessData, recordPrimaryOracle }) => {
        await reviews.goto(env.admin.baseUrl!);
        await reviews.searchCustomer(env.accountOpening.testEmail!);
        const records = await reviews.readRecords(env.accountOpening.testEmail!);
        let usCount = 0;
        for (const record of records) {
          const detail = await reviews.openDetail(record);
          const data = await detail.readDetail(record.applicationId!);
          if (data.accountType === '美国账户') usCount += 1;
        }
        expect(usCount).toBe(0);
        setBusinessData({ existingUsOpeningApplicationCount: usCount });
        recordPrimaryOracle({
          id: 'OPEN-US-PRE-2',
          name: '不存在既有美国账户申请',
          expected: '0',
          actual: String(usCount),
          status: 'passed'
        });
        setActual('专用用户仅有其他法域历史记录，美国账户申请候选数=0。');
      }
    );

    await business.step(
      {
        action: '4. 验证固定资料、Documenso网络与Interlace配置',
        expected: '5份资料存在，Documenso可访问，美国账户Interlace渠道启用'
      },
      async ({ setActual, setBusinessData, recordPrimaryOracle }) => {
        expect(assets).toHaveLength(5);
        const response = await clientPage.request.get('https://app.documenso.com', {
          failOnStatusCode: false,
          timeout: 20_000
        });
        expect(response.status()).toBeLessThan(500);
        await accountTypes.goto(env.admin.baseUrl!);
        const config = await accountTypes.readUsConfiguration();
        expect(config.channel).toBe('interlace');
        expect(config.enabled).toBe(true);
        setBusinessData({
          openingDocumentAssetCount: assets.length,
          documensoNetworkStatus: response.status(),
          usOpeningChannel: config.channel,
          usOpeningChannelEnabled: config.enabled,
          mutationPerformed: false
        });
        recordPrimaryOracle({
          id: 'OPEN-US-PRE-3',
          name: '开户资料与外部Sandbox依赖可用',
          expected: '5份资料、Documenso可访问、Interlace启用',
          actual: `资料=${assets.length}；Documenso HTTP ${response.status()}；Interlace已启用`,
          status: 'passed'
        });
        setActual('固定资料完整，Documenso无网络阻塞，美国账户Interlace渠道为启用状态。');
      }
    );
  }
);
