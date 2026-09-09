import { FundSubscribePage } from '../../../pages/client/FundSubscribePage';
import { FundTradingPage } from '../../../pages/client/FundTradingPage';
import { expect, test } from '../../../fixtures/client.fixture';
import { env } from '../../../src/config/env';
import { Decimal } from '../../../src/utils/money';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'WS-001 理财认购提交前Validation',
  {
    tag: ['@client', '@wealth', '@subscribe', '@validation', '@readonly', '@L1'],
    annotation: [
      { type: 'caseId', description: 'WS-001' },
      { type: 'flowId', description: 'wealth-subscribe-validation' },
      { type: 'module', description: '客户端理财认购' },
      { type: 'priority', description: 'P1' },
      { type: 'type', description: 'Validation / Non-mutation' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ baseURL, page, business }) => {
    if (!baseURL) throw new Error('CLIENT_BASE_URL is required for WS-001.');
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);

    const funds = new FundTradingPage(page);
    const subscribe = new FundSubscribePage(page);
    business.case({
      flowId: 'wealth-subscribe-validation',
      caseId: 'WS-001',
      module: '客户端理财认购',
      name: '理财认购提交前Validation',
      description: '验证产品目录、最低金额、付款账户、余额、协议、手续费和确认摘要，在确认并提交前停止。',
      priority: 'P1',
      level: 'L1',
      type: ['Validation', 'Readonly', 'Non-mutation'],
      scope: 'Client',
      owner: 'QA',
      requirement: 'Wealth Subscribe readiness',
      preconditions: ['客户端自动登录成功', '存在已上架USD产品', 'ALLOW_MONEY_TESTS=false'],
      target: '确认理财认购表单可形成有效但未提交的订单摘要。',
      expectedResult: '金额边界有效，付款账户余额充足，手续费和合计一致；提交点击0次。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: true,
      safetySwitches: ['ALLOW_MONEY_TESTS=false', 'ALLOW_ADMIN_MUTATION_TESTS=false']
    });

    const product = await business.step(
      { action: '读取真实理财产品目录', expected: '至少存在一个最低金额大于0的可申购USD产品' },
      async ({ setActual, setBusinessData }) => {
        await funds.goto(baseURL);
        await funds.openCatalog();
        const products = await funds.readProducts();
        expect(products.length).toBeGreaterThanOrEqual(4);
        const eligible = products
          .filter(item => item.currency === 'USD' && new Decimal(item.minimumInvestment).greaterThan(0))
          .sort((left, right) => new Decimal(left.minimumInvestment).comparedTo(right.minimumInvestment))[0];
        expect(eligible).toBeDefined();
        setBusinessData({
          productCount: products.length,
          selectedProduct: eligible.name,
          minimumInvestment: `${eligible.minimumInvestment} ${eligible.currency}`,
          productType: eligible.productType,
          productRiskLevel: eligible.riskLevel,
          productLockPeriod: eligible.lockPeriod
        });
        setActual(`目录显示${products.length}个产品；选择最低合法金额为${eligible.minimumInvestment} ${eligible.currency}的产品`);
        return eligible;
      }
    );

    const selectedAccount = await business.step(
      { action: '打开认购页并选择余额充足的付款账户', expected: '付款账户余额可读且不低于产品最低投资额' },
      async ({ setActual, setBusinessData }) => {
        await funds.openSubscription(product.name);
        await subscribe.expectLoaded();
        const accounts = await subscribe.readPaymentAccounts();
        const eligible = accounts.find(account =>
          account.currency === product.currency &&
          new Decimal(account.balance).greaterThanOrEqualTo(product.minimumInvestment)
        );
        expect(eligible).toBeDefined();
        await subscribe.selectPaymentAccount(eligible!.accountType);
        await subscribe.acceptTerms();
        setBusinessData({ paymentAccount: eligible!.accountType, paymentBalance: eligible!.balance });
        setActual(`已选择余额满足最低金额的${eligible!.accountType}，账户具体标识未记录`);
        return eligible!;
      }
    );

    await business.step(
      { action: '验证空值、0和低于最低金额', expected: '三种无效金额均不能启用确认并提交' },
      async ({ setActual }) => {
        await subscribe.fillAmount('');
        expect(await subscribe.submitEnabled()).toBe(false);
        await subscribe.fillAmount('0');
        expect(await subscribe.submitEnabled()).toBe(false);
        const belowMinimum = new Decimal(product.minimumInvestment).minus('0.01');
        await subscribe.fillAmount(belowMinimum.toFixed(2));
        expect(await subscribe.submitEnabled()).toBe(false);
        setActual('空值、0和低于产品最低金额均保持提交禁用');
      }
    );

    await business.step(
      { action: '形成合法认购摘要并在提交前停止', expected: '金额、币种、付款账户、手续费和合计一致，提交点击0次' },
      async ({ setActual, setBusinessData, recordPrimaryOracle }) => {
        await subscribe.fillAmount(product.minimumInvestment);
        expect(await subscribe.submitEnabled()).toBe(true);
        const snapshot = await subscribe.readSnapshot();
        expect(new Decimal(snapshot.amount).equals(product.minimumInvestment)).toBe(true);
        expect(snapshot.currency).toBe(product.currency);
        expect(snapshot.paymentAccount).toContain(selectedAccount.accountType);
        expect(new Decimal(snapshot.totalAmount).equals(product.minimumInvestment)).toBe(true);
        expect(subscribe.submissionClickCount()).toBe(0);
        setBusinessData({
          feeAmount: `${snapshot.feeAmount} ${snapshot.currency}`,
          feeRate: snapshot.feeRate,
          requestedAmount: `${snapshot.amount} ${snapshot.currency}`,
          productLockPeriod: product.lockPeriod,
          securityKeyRequiredForMutation: true,
          securityKeyVerificationClicks: 0,
          mutationPerformed: false,
          readinessStatus: 'IN_PROGRESS'
        });
        recordPrimaryOracle({
          id: 'ws-validation-summary',
          name: '认购提交前摘要',
          expected: '合法最低金额与0手续费摘要一致，提交0次',
          actual: `${snapshot.amount} ${snapshot.currency}，手续费${snapshot.feeAmount}，提交0次`,
          status: 'passed'
        });
        setActual('确认摘要与页面输入一致；未点击确认并提交，未触发安全密钥或创建INV订单');
      }
    );
  }
);
