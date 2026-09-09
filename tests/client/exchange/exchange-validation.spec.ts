import { ExchangePage } from '../../../pages/client/ExchangePage';
import { expect, test } from '../../../fixtures/client.fixture';
import { Decimal } from '../../../src/utils/money';
import {
  getExchangeTestConfig,
  parseExchangeBalance,
  parseExchangeQuote
} from './exchangeTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });

async function openConfiguredExchange(baseURL: string, exchangePage: ExchangePage): Promise<void> {
  const config = getExchangeTestConfig();
  await exchangePage.gotoDashboard(baseURL);
  await exchangePage.openFromAssetRow(config.dashboardAsset, config.dashboardNetwork);
  await exchangePage.selectSourceAsset(config.sourceAccountType, config.fromCurrency);
  await exchangePage.selectTargetAsset(config.targetAccountType, config.toCurrency);
}

test('@client @exchange @validation @L1 兑换弹窗按账户类型和币种选择真实资产', async ({ baseURL, page }) => {
  if (!baseURL) {
    throw new Error('CLIENT_BASE_URL is required for Exchange validation tests.');
  }

  const config = getExchangeTestConfig();
  const exchangePage = new ExchangePage(page);

  await test.step('打开兑换弹窗', async () => {
    await openConfiguredExchange(baseURL, exchangePage);
  });

  await test.step('验证转出和转入资产来自指定账户分组', async () => {
    await expect(exchangePage.dialog).toBeVisible();
    await expect(exchangePage.sourcePanel).toContainText(config.fromCurrency.split('_')[0]);
    await expect(exchangePage.targetPanel).toContainText(config.toCurrency);
    expect(await exchangePage.readSourceBalanceText()).toContain('可用余额:');
    expect(await exchangePage.readTargetBalanceText()).toContain('可用余额:');
  });
});

test('@client @exchange @validation @L1 兑换金额和不支持币种组合执行真实页面校验', async ({
  baseURL,
  page
}) => {
  if (!baseURL) {
    throw new Error('CLIENT_BASE_URL is required for Exchange validation tests.');
  }

  const config = getExchangeTestConfig();
  const exchangePage = new ExchangePage(page);
  await openConfiguredExchange(baseURL, exchangePage);

  await test.step('校验空金额', async () => {
    await expect(exchangePage.sourceAmountInput).toHaveValue('');
    await expect(exchangePage.quoteButton).toBeDisabled();
  });

  await test.step('校验金额为零', async () => {
    await exchangePage.fillSourceAmount('0');
    await expect(exchangePage.quoteButton).toBeEnabled();
    await exchangePage.requestQuote();
    await expect(exchangePage.positiveAmountError).toBeVisible();
  });

  await test.step('校验金额超过账户可用余额', async () => {
    const sourceBalance = parseExchangeBalance(
      await exchangePage.readSourceBalanceText(),
      'source available balance'
    );
    await exchangePage.fillSourceAmount(sourceBalance.plus(new Decimal('0.0001')).toFixed());
    await expect(exchangePage.insufficientBalanceError).toBeVisible();
    await expect(exchangePage.quoteButton).toBeDisabled();
  });

  await test.step('校验转出和转入币种不能相同', async () => {
    await exchangePage.selectTargetAsset(config.sourceAccountType, config.fromCurrency);
    await exchangePage.fillSourceAmount(config.testAmount);
    await expect(exchangePage.quoteButton).toBeEnabled();
    await exchangePage.requestQuote();
    await expect(exchangePage.sameCurrencyError).toBeVisible();
  });
});

test(
  '兑换提交前校验',
  {
    tag: ['@client', '@exchange', '@validation', '@L1'],
    annotation: [
      { type: 'caseId', description: 'EX-003' },
      { type: 'module', description: '客户端兑换' },
      { type: 'priority', description: 'P0' },
      { type: 'owner', description: 'QA' },
      { type: 'requirement', description: 'Exchange pre-submit validation' },
      { type: 'type', description: 'Validation / Non-mutation' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ baseURL, page, business }, testInfo) => {
    if (!baseURL) {
      throw new Error('CLIENT_BASE_URL is required for Exchange validation tests.');
    }

    const config = getExchangeTestConfig();
    const exchangePage = new ExchangePage(page);
    let sourceDisplayLabel = '';
    let targetDisplayLabel = '';

    business.case({
      caseId: 'EX-003',
      module: '客户端兑换',
      name: '兑换提交前校验',
      description: '验证真实账户、测试金额、报价和指令预确认信息，停在确认兑换按钮之前。',
      priority: 'P0',
      type: ['Validation', 'Non-mutation'],
      scope: 'Client',
      owner: 'QA',
      requirement: 'Exchange pre-submit validation',
      preconditions: ['客户端登录状态有效', '测试账号具有足够的配置币种余额'],
      target: '确认兑换报价与预确认页完整正确，且不提交任何交易。',
      expectedResult: '报价包含汇率、手续费、预计到账和有效期，确认按钮可见但不点击。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: false,
      dependsOnThirdParty: false
    });
    business.setBusinessData({
      sourceAccountType: config.sourceAccountType,
      targetAccountType: config.targetAccountType,
      fromCurrency: config.fromCurrency,
      toCurrency: config.toCurrency,
      exchangePair: `${config.fromCurrency} -> ${config.toCurrency}`,
      amount: config.testAmount
    });

    await business.step(
      { action: '打开兑换页面并选择账户', expected: '显示配置的转出和转入账户及可用余额' },
      async ({ setActual }) => {
        await openConfiguredExchange(baseURL, exchangePage);
        setActual(`已显示 ${config.fromCurrency} 转出账户和 ${config.toCurrency} 转入账户`);
      }
    );

    await business.step(
      { action: '确认测试余额并填写兑换金额', expected: '转出余额足够且获取报价按钮可用' },
      async ({ setActual, setBusinessData }) => {
        const sourceBalance = parseExchangeBalance(
          await exchangePage.readSourceBalanceText(),
          'source available balance'
        );
        expect(
          sourceBalance.greaterThanOrEqualTo(new Decimal(config.testAmount)),
          `转出余额不足：当前 ${sourceBalance.toString()} ${config.fromCurrency}，测试金额 ${config.testAmount} ${config.fromCurrency}`
        ).toBe(true);
        sourceDisplayLabel = await exchangePage.readSourceAssetLabel();
        targetDisplayLabel = await exchangePage.readTargetAssetLabel();
        await exchangePage.fillSourceAmount(config.testAmount);
        await expect(exchangePage.quoteButton).toBeEnabled();
        setBusinessData({ sourceBalanceBefore: sourceBalance.toString() });
        setActual(`余额充足，已填写 ${config.testAmount} ${config.fromCurrency}`);
      }
    );

    await business.step(
      { action: '获取并校验兑换报价', expected: '显示有效汇率、手续费、预计到账金额和倒计时' },
      async ({ setActual, setBusinessData }) => {
        await exchangePage.requestQuote();
        await expect(exchangePage.confirmationDialog).toBeVisible();

        const confirmationText = await exchangePage.readConfirmationText();
        expect(confirmationText).not.toMatch(/undefined|null|NaN|\[object Object\]/);
        const quote = parseExchangeQuote(
          confirmationText,
          config,
          sourceDisplayLabel,
          targetDisplayLabel
        );

        expect(quote.sourceAmount.equals(new Decimal(config.testAmount))).toBe(true);
        expect(quote.receivedAmount.greaterThanOrEqualTo(0)).toBe(true);
        expect(quote.rate.isPositive()).toBe(true);
        expect(quote.feeText).toBe('免费');
        expect(quote.countdown).toMatch(/^\d{2}:\d{2}$/);
        setBusinessData({
          sourceAmount: quote.sourceAmount.toString(),
          rate: quote.rate.toString(),
          fee: quote.feeText,
          expectedReceivedAmount: quote.receivedAmount.toString(),
          quoteValidity: quote.countdown
        });
        setActual(`报价有效：汇率 ${quote.rate.toString()}，手续费 ${quote.feeText}，预计到账 ${quote.receivedAmount.toString()} ${config.toCurrency}`);

        await testInfo.attach('exchange-quote-summary.json', {
          body: Buffer.from(
            JSON.stringify(
              {
                fromCurrency: config.fromCurrency,
                toCurrency: config.toCurrency,
                sourceAmount: quote.sourceAmount.toString(),
                receivedAmount: quote.receivedAmount.toString(),
                rate: quote.rate.toString(),
                fee: quote.feeText,
                validity: quote.countdown
              },
              null,
              2
            )
          ),
          contentType: 'application/json'
        });
      }
    );

    await business.step(
      { action: '验证确认页但不提交兑换', expected: '返回修改和确认兑换按钮可见，测试不点击确认兑换' },
      async ({ setActual, setBusinessData }) => {
        await expect(exchangePage.returnToEditButton).toBeVisible();
        await expect(exchangePage.confirmExchangeButton).toBeVisible();
        setBusinessData({ confirmed: false, finalStatus: '停在确认兑换前，未提交' });
        setActual('确认页按钮正常显示，未点击确认兑换，未产生交易');
      }
    );
  }
);
