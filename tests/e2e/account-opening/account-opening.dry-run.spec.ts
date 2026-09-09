import { AccountOpeningReviewPage } from '../../../pages/admin/AccountOpeningReviewPage';
import { SecuritiesTradingPage } from '../../../pages/client/SecuritiesTradingPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { prepareAccountOpeningResume } from '../../../src/account-opening/account-opening-e2e';
import { env } from '../../../src/config/env';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'OPEN-002/003 开户双端Readiness Dry Run',
  {
    tag: ['@e2e', '@account-opening', '@readonly', '@dry-run', '@L3'],
    annotation: [
      { type: 'caseId', description: 'OPEN-DRY' },
      { type: 'flowId', description: 'account-opening-dry-run' },
      { type: 'module', description: 'Client + Admin开户' },
      { type: 'priority', description: 'P0/P1' },
      { type: 'type', description: 'Dry Run / Readonly' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' },
      { type: 'blocker', description: 'BLOCKED_TEST_DATA: 当前测试账号三个券商账户均已开通' }
    ]
  },
  async ({ clientPage, adminPage, business }) => {
    test.setTimeout(120_000);
    if (!env.client.baseUrl || !env.admin.baseUrl || !env.client.username) {
      throw new Error('Client/Admin URLs and CLIENT_USERNAME are required for Account Opening Dry Run.');
    }
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);

    const client = new SecuritiesTradingPage(clientPage);
    const admin = new AccountOpeningReviewPage(adminPage);
    const runId = `OPEN-DRY-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
    const prepared = prepareAccountOpeningResume(runId, 'broker');

    business.case({
      flowId: 'account-opening-dry-run',
      caseId: 'OPEN-DRY',
      module: 'Client + Admin开户',
      name: 'OPEN-002/003 开户双端Readiness Dry Run',
      description: '验证Client资格、Admin开户审核入口、搜索和Resume骨架；因当前账号全部已开户而不创建新申请。',
      priority: 'P0/P1',
      level: 'L3',
      type: ['Dry Run', 'Readonly', 'Non-mutation'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'OPEN-002 Reject / OPEN-003 Approve readiness',
      preconditions: ['Client/Admin认证有效', '两个Mutation开关均关闭'],
      target: '在任何开户写操作之前验证双端入口和测试数据门禁。',
      expectedResult: 'Admin审核页可读；当前账号无可申请券商，流程以BLOCKED_TEST_DATA停止。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: true,
      safetySwitches: ['ALLOW_MONEY_TESTS=false', 'ALLOW_ADMIN_MUTATION_TESTS=false']
    });
    business.setBusinessData({ runId, readinessStatus: 'BLOCKED_TEST_DATA', dryRun: true });

    await business.step(
      { action: '预检Client开户资格与Resume状态', expected: '识别真实可申请券商；Resume停在PREPARED' },
      async ({ setActual, setBusinessData }) => {
        await client.goto(env.client.baseUrl!);
        const cards = await client.readBrokerCards();
        const available = cards.filter(card => card.action === '立即开户');
        expect(available).toHaveLength(0);
        expect(prepared.stage).toBe('PREPARED');
        setBusinessData({
          openingBrokerCount: cards.length,
          openingAvailableBrokerCount: available.length,
          mutationPerformed: false
        });
        setActual('当前三个券商均已开通；未进入申请，Resume仅生成PREPARED内存结构');
      }
    );

    await business.step(
      { action: '打开Admin开户审核并验证客户搜索能力', expected: '开户审核路由、个人/企业Tab和客户ID/名称/邮箱搜索可用' },
      async ({ setActual, setBusinessData }) => {
        await admin.goto(env.admin.baseUrl!);
        await admin.searchCustomer(env.client.username!);
        const records = await admin.readRecords(env.client.username!);
        expect(await admin.tableRowCount()).toBeGreaterThan(0);
        setBusinessData({ adminCandidateCount: records.filter(record => record.customerMatched).length });
        setActual('Admin开户审核页面和测试客户搜索已真实验证；未打开或处理任何申请');
      }
    );

    await business.step(
      { action: '验证零写操作门禁', expected: 'Client申请0次、Admin审核0次，两个安全开关保持关闭' },
      async ({ setActual }) => {
        expect(client.applicationClickCount()).toBe(0);
        expect(admin.reviewClickCount()).toBe(0);
        setActual('Client申请点击0次，Admin审核点击0次；OPEN-002/003等待可重置的未开户账号');
      }
    );
  }
);
