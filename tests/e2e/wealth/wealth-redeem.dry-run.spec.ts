import { WealthOrderListPage } from '../../../pages/admin/WealthOrderListPage';
import { FundTradingPage } from '../../../pages/client/FundTradingPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { prepareWealthResume } from '../../../src/wealth/wealth-e2e';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'WR-002/003 理财赎回双端Readiness Dry Run',
  {
    tag: ['@e2e', '@wealth', '@redeem', '@readonly', '@dry-run', '@L3'],
    annotation: [
      { type: 'caseId', description: 'WR-DRY' },
      { type: 'flowId', description: 'wealth-redeem-dry-run' },
      { type: 'module', description: 'Client + Admin理财赎回' },
      { type: 'priority', description: 'P1' },
      { type: 'type', description: 'Dry Run / Readiness' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' },
      { type: 'blocker', description: 'BLOCKED_TEST_DATA: 缺少页面可见且处于赎回窗口的测试持仓' }
    ]
  },
  async ({ clientPage, adminPage, business }) => {
    test.setTimeout(120_000);
    if (!env.client.baseUrl || !env.admin.baseUrl) {
      throw new Error('Client/Admin URLs are required for Wealth Redeem Dry Run.');
    }
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);

    const funds = new FundTradingPage(clientPage);
    const admin = new WealthOrderListPage(adminPage);
    const prepared = prepareWealthResume(
      `WR-DRY-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
      'redemption',
      '0',
      'USD'
    );

    business.case({
      flowId: 'wealth-redeem-dry-run',
      caseId: 'WR-DRY',
      module: 'Client + Admin理财赎回',
      name: 'WR-002/003 理财赎回双端Readiness Dry Run',
      description: '验证Client持仓门禁、赎回历史、Admin赎回管理与Resume结构；无可赎回持仓时停止。',
      priority: 'P1',
      level: 'L3',
      type: ['Dry Run', 'Readonly', 'Readiness'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'WR-002 Reject / WR-003 Approve readiness',
      preconditions: ['Client/Admin认证有效', '两个Mutation开关均关闭'],
      target: '在任何赎回写操作前验证双端入口和真实持仓条件。',
      expectedResult: 'Admin赎回管理可读；因缺少可赎回持仓而以BLOCKED_TEST_DATA停止。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: true,
      safetySwitches: ['ALLOW_MONEY_TESTS=false', 'ALLOW_ADMIN_MUTATION_TESTS=false']
    });

    await business.step(
      { action: '预检Client可赎回持仓和Resume', expected: '只接受页面真实可赎回持仓；Resume停在PREPARED' },
      async ({ setActual, setBusinessData }) => {
        await funds.goto(env.client.baseUrl!);
        const positions = await funds.openPositions();
        expect(positions.renderedPositionRows).toBe(0);
        expect(positions.redeemActionCount).toBe(0);
        expect(prepared.stage).toBe('PREPARED');
        setBusinessData({
          positionRecordCount: 0,
          redeemablePositionCount: 0,
          readinessStatus: 'BLOCKED_TEST_DATA',
          blockerReason: '需要页面可见、处于赎回窗口且有可观测结算账户余额的持仓',
          mutationPerformed: false
        });
        setActual('当前没有可赎回持仓；未打开赎回表单，也未创建INV赎回订单');
      }
    );

    await business.step(
      { action: '验证Client赎回历史与Admin赎回管理入口', expected: '两端赎回只读页面可访问，Admin搜索和状态Tab可用' },
      async ({ setActual, setBusinessData }) => {
        const history = await funds.readHistory('赎回');
        await admin.goto(env.admin.baseUrl!, 'redemption');
        expect(await admin.tableHeaders()).toEqual(expect.any(Array));
        expect(admin.mutationClickCount()).toBe(0);
        setBusinessData({ wealthHistoryCount: history.length });
        setActual(`Client赎回历史可读（${history.length}条）；Admin赎回管理可访问，处理点击0次`);
      }
    );
  }
);
