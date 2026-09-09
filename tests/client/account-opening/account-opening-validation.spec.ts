import { SecuritiesTradingPage } from '../../../pages/client/SecuritiesTradingPage';
import { expect, test } from '../../../fixtures/client.fixture';
import { env } from '../../../src/config/env';
import { Decimal } from '../../../src/utils/money';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'OPEN-001 开户目录与申请资格Validation',
  {
    tag: ['@client', '@account-opening', '@validation', '@readonly', '@L1'],
    annotation: [
      { type: 'caseId', description: 'OPEN-001' },
      { type: 'flowId', description: 'account-opening-validation' },
      { type: 'module', description: '客户端开户' },
      { type: 'priority', description: 'P0' },
      { type: 'type', description: 'Validation / Non-mutation' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ baseURL, page, business }) => {
    if (!baseURL) throw new Error('CLIENT_BASE_URL is required for OPEN-001.');
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);

    const securities = new SecuritiesTradingPage(page);
    business.case({
      flowId: 'account-opening-validation',
      caseId: 'OPEN-001',
      module: '客户端开户',
      name: '开户目录与申请资格Validation',
      description: '验证真实券商账户目录、账户类型、开户费和当前申请资格，不进入或提交开户申请。',
      priority: 'P0',
      level: 'L1',
      type: ['Validation', 'Readonly', 'Non-mutation'],
      scope: 'Client',
      owner: 'QA',
      requirement: 'Account Opening readiness',
      preconditions: ['客户端自动登录成功', '两个Mutation开关均关闭'],
      target: '确认开户目录与费用可读，并识别当前账号是否仍有可申请券商。',
      expectedResult: '券商卡片字段完整；不点击立即开户，不创建任何申请。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: true,
      safetySwitches: ['ALLOW_MONEY_TESTS=false', 'ALLOW_ADMIN_MUTATION_TESTS=false']
    });

    const cards = await business.step(
      {
        action: '打开投资-券商开户目录',
        expected: '真实券商卡片加载，显示账户状态、账户类型、开户费和可投市场'
      },
      async ({ setActual }) => {
        await securities.goto(baseURL);
        const result = await securities.readBrokerCards();
        expect(result.length).toBeGreaterThanOrEqual(3);
        setActual(`已读取${result.length}个真实券商账户卡片`);
        return result;
      }
    );

    await business.step(
      {
        action: '核对开户费用与当前申请资格',
        expected: '每个券商均显示数值开户费；当前可申请状态由页面真实动作判断'
      },
      async ({ setActual, setBusinessData }) => {
        expect(cards.every(card => new Decimal(card.openingFee).isFinite())).toBe(true);
        expect(cards.every(card => card.accountType.length > 0)).toBe(true);
        const available = cards.filter(card => card.action === '立即开户');
        setBusinessData({
          openingBrokerCount: cards.length,
          openingAvailableBrokerCount: available.length,
          openingAccountTypes: [...new Set(cards.map(card => card.accountType))],
          openingFees: cards.map(card => `${card.openingFee} ${card.feeCurrency}`),
          readinessStatus: available.length > 0 ? 'IN_PROGRESS' : 'BLOCKED_TEST_DATA'
        });
        setActual(
          available.length > 0
            ? `当前存在${available.length}个可申请券商；本用例未进入申请`
            : '当前Webull、IBKR和老虎证券均已开通，无新的可申请券商测试数据'
        );
      }
    );

    await business.step(
      { action: '在开户申请入口前停止', expected: '开户申请动作点击0次，未创建申请且未扣费' },
      async ({ setActual, setBusinessData, recordPrimaryOracle }) => {
        expect(securities.applicationClickCount()).toBe(0);
        setBusinessData({ mutationPerformed: false });
        recordPrimaryOracle({
          id: 'open-validation-no-mutation',
          name: '开户Validation零写操作',
          expected: '开户申请点击0次',
          actual: '开户申请点击0次',
          status: 'passed'
        });
        setActual('未点击立即开户或任何最终提交动作');
      }
    );
  }
);
