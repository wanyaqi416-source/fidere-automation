import { FundTradingPage } from '../../../pages/client/FundTradingPage';
import { expect, test } from '../../../fixtures/client.fixture';
import { env } from '../../../src/config/env';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'WR-001 理财赎回资格与历史Validation',
  {
    tag: ['@client', '@wealth', '@redeem', '@validation', '@readonly', '@L1'],
    annotation: [
      { type: 'caseId', description: 'WR-001' },
      { type: 'flowId', description: 'wealth-redeem-validation' },
      { type: 'module', description: '客户端理财赎回' },
      { type: 'priority', description: 'P1' },
      { type: 'type', description: 'Validation / Readiness' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' },
      { type: 'readiness', description: 'BLOCKED_TEST_DATA' }
    ]
  },
  async ({ baseURL, page, business }) => {
    if (!baseURL) throw new Error('CLIENT_BASE_URL is required for WR-001.');
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);
    const funds = new FundTradingPage(page);

    business.case({
      flowId: 'wealth-redeem-validation',
      caseId: 'WR-001',
      module: '客户端理财赎回',
      name: '理财赎回资格与历史Validation',
      description: '读取真实持仓区、赎回入口和赎回历史；无可赎回持仓时明确标记测试数据阻塞。',
      priority: 'P1',
      level: 'L1',
      type: ['Validation', 'Readonly', 'Readiness'],
      scope: 'Client',
      owner: 'QA',
      requirement: 'Wealth Redeem readiness',
      preconditions: ['客户端自动登录成功', '两个Mutation开关均关闭'],
      target: '确认当前Sandbox是否具备可赎回持仓，而不是伪造赎回数据。',
      expectedResult: '持仓与赎回历史页面可读；当前无赎回入口时记录BLOCKED_TEST_DATA。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: true,
      safetySwitches: ['ALLOW_MONEY_TESTS=false', 'ALLOW_ADMIN_MUTATION_TESTS=false']
    });

    await business.step(
      { action: '打开基金页并检查我的投资', expected: '页面真实返回持仓行和赎回入口数量' },
      async ({ setActual, setBusinessData, recordPrimaryOracle }) => {
        await funds.goto(baseURL);
        const state = await funds.openPositions();
        expect(state.redeemActionCount).toBe(0);
        expect(state.renderedPositionRows).toBe(0);
        setBusinessData({
          positionRecordCount: state.renderedPositionRows,
          redeemablePositionCount: state.redeemActionCount,
          readinessStatus: 'BLOCKED_TEST_DATA',
          blockerReason: '当前测试账号未渲染可赎回持仓或赎回入口'
        });
        recordPrimaryOracle({
          id: 'wr-readiness-observed',
          name: '赎回测试数据真实性',
          expected: '仅使用页面真实可赎回持仓',
          actual: '当前可赎回持仓0条，未伪造测试数据',
          status: 'passed'
        });
        setActual('我的投资区域未渲染持仓卡或赎回按钮，Mutation准备被测试数据门禁阻塞');
      }
    );

    await business.step(
      { action: '读取赎回交易历史结构', expected: '赎回Tab和日期、编号、产品、类型、金额、状态列可访问' },
      async ({ setActual, setBusinessData }) => {
        const records = await funds.readHistory('赎回');
        setBusinessData({ wealthHistoryCount: records.length, mutationPerformed: false });
        setActual(`赎回历史页面正常；当前解析到${records.length}条INV历史记录，未执行赎回`);
      }
    );
  }
);
