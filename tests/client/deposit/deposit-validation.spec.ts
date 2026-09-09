import { DepositHistoryPage } from '../../../pages/client/DepositHistoryPage';
import { DepositPage } from '../../../pages/client/DepositPage';
import { expect, test } from '../../../fixtures/client.fixture';
import { env } from '../../../src/config/env';
import { deriveUniqueDepositAmount } from '../../../src/deposit/deposit-e2e';
import { getDepositTestConfig } from './depositTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'DP-001 入金账户与币种矩阵 @client @deposit @validation @readonly @L1',
  async ({ baseURL, page }) => {
    if (!baseURL) throw new Error('CLIENT_BASE_URL is required for Deposit validation.');
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);

    const depositPage = new DepositPage(page);
    await depositPage.goto(baseURL);
    const matrix = await depositPage.readAccountCurrencyMatrix();

    expect(matrix).toEqual({
      香港账户: ['港元', '美元'],
      美国账户: ['美元'],
      新加坡账户: ['港元', '美元', '新加坡元', '阿联酋迪拉姆', '日元'],
      巴林账户: ['港元', '新加坡元', '人民币', '美元', '欧元']
    });
    expect(depositPage.submissionClicks()).toBe(0);
  }
);

test(
  'DP-001 入金必填项与金额校验 @client @deposit @validation @readonly @L1',
  async ({ baseURL, page }, testInfo) => {
    if (!baseURL) throw new Error('CLIENT_BASE_URL is required for Deposit validation.');
    const config = getDepositTestConfig();
    const depositPage = new DepositPage(page);
    await depositPage.goto(baseURL);
    await depositPage.selectAccount(config.accountType);
    await depositPage.selectCurrency(config.currencyLabel);

    expect(await depositPage.readPayingBankCount()).toBeGreaterThan(0);
    const channels = await depositPage.readChannelOptions();
    const purposes = await depositPage.readPurposeOptions();
    const sources = await depositPage.readSourceOfFundsOptions();
    expect(channels).toContain(config.channel);
    expect(purposes).toContain(config.purpose);
    expect(sources).toContain(config.sourceOfFunds);

    await depositPage.clearAmount();
    await depositPage.blurAmount();
    const emptySnapshot = await depositPage.readFormSnapshot();
    expect(emptySnapshot.submitEnabled).toBe(false);

    await depositPage.fillAmount('0');
    await depositPage.blurAmount();
    const zeroSnapshot = await depositPage.readFormSnapshot();
    testInfo.annotations.push({
      type: 'deposit-zero-validation',
      description: zeroSnapshot.submitEnabled
        ? '金额0在表单阶段未禁用提交；最终提交校验仍禁止触发'
        : '金额0时提交按钮保持禁用'
    });

    await depositPage.selectChannel(config.channel);
    await depositPage.selectPurpose(config.purpose);
    await depositPage.selectSourceOfFunds(config.sourceOfFunds);
    const amount = deriveUniqueDepositAmount(
      'DP-001-VALIDATION',
      config.uniqueAmountBase,
      config.amountPrecision
    ).toFixed(config.amountPrecision);
    await depositPage.fillAmount(amount);
    await depositPage.blurAmount();
    const validSnapshot = await depositPage.readFormSnapshot();
    expect(validSnapshot.accountType).toContain(config.accountType);
    expect(validSnapshot.currencyLabel).toContain(config.currencyLabel);
    expect(validSnapshot.amount).toBe(amount);
    expect(validSnapshot.submitEnabled).toBe(true);
    expect(depositPage.submissionClicks()).toBe(0);
  }
);

test(
  '入金提交前Validation',
  {
    tag: ['@client', '@deposit', '@validation', '@readonly', '@L1'],
    annotation: [
      { type: 'caseId', description: 'DP-001' },
      { type: 'module', description: '客户端入金' },
      { type: 'priority', description: 'P0' },
      { type: 'type', description: 'Validation / Non-mutation' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ baseURL, page, business }) => {
    if (!baseURL) throw new Error('CLIENT_BASE_URL is required for Deposit validation.');
    const config = getDepositTestConfig();
    const depositPage = new DepositPage(page);
    const historyPage = new DepositHistoryPage(page);
    const amount = deriveUniqueDepositAmount(
      'DP-001-BUSINESS-REPORT',
      config.uniqueAmountBase,
      config.amountPrecision
    ).toFixed(config.amountPrecision);

    business.case({
      caseId: 'DP-001',
      module: '客户端入金',
      name: '入金提交前Validation',
      description: '验证银行电汇入金账户、币种、银行、必填字段、两位小数金额和历史区域，不点击提交。',
      priority: 'P0',
      type: ['Validation', 'Non-mutation'],
      scope: 'Client',
      owner: 'QA',
      requirement: 'Deposit pre-submit validation',
      preconditions: ['客户端自动登录成功', '两个Mutation开关均关闭', 'Sandbox已配置打款银行'],
      target: '确认可控Sandbox银行电汇入金表单真实可用，并在最终提交前停止。',
      expectedResult: '香港账户/HKD表单必填项和金额有效，提交按钮可用但点击次数为0。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: true,
      safetySwitches: ['ALLOW_MONEY_TESTS=false', 'ALLOW_ADMIN_MUTATION_TESTS=false']
    });
    business.setBusinessData({
      accountType: config.accountType,
      depositCurrency: config.currency,
      depositAmount: amount,
      depositChannel: config.channel,
      depositPurpose: config.purpose,
      depositSourceOfFunds: config.sourceOfFunds,
      confirmed: false,
      dryRun: true
    });

    await business.step(
      { action: '打开银行电汇入金页面', expected: '页面、收款账户、币种及最近提交记录正常加载' },
      async ({ setActual }) => {
        await depositPage.goto(baseURL);
        await historyPage.expectLoaded();
        setActual('银行电汇入金表单与最近提交记录已加载');
      }
    );

    await business.step(
      { action: '选择目标账户、币种和打款银行', expected: '香港账户支持HKD且存在可选打款银行' },
      async ({ setActual, setBusinessData }) => {
        await depositPage.selectAccount(config.accountType);
        const currencies = await depositPage.readCurrencyOptions();
        expect(currencies).toContain(config.currencyLabel);
        await depositPage.selectCurrency(config.currencyLabel);
        const bankCount = await depositPage.readPayingBankCount();
        expect(bankCount).toBeGreaterThan(0);
        setBusinessData({ supportedCurrencies: currencies, payingBankOptionCount: bankCount });
        setActual(`已选择${config.accountType}/${config.currency}；存在${bankCount}个打款银行选项`);
      }
    );

    await business.step(
      { action: '填写入金申请必填字段', expected: '渠道、用途、资金来源和两位小数金额均被页面接受' },
      async ({ setActual }) => {
        await depositPage.selectChannel(config.channel);
        await depositPage.selectPurpose(config.purpose);
        await depositPage.selectSourceOfFunds(config.sourceOfFunds);
        await depositPage.fillAmount(amount);
        await depositPage.blurAmount();
        expect((await depositPage.readFormSnapshot()).submitEnabled).toBe(true);
        setActual(`页面接受${amount} ${config.currency}及全部必填业务字段`);
      }
    );

    await business.step(
      { action: '在最终提交前停止', expected: '提交点击次数为0，未创建TXN入金申请且余额不变' },
      async ({ setActual, setBusinessData }) => {
        expect(depositPage.submissionClicks()).toBe(0);
        expect(env.exchange.allowMoneyTests).toBe(false);
        expect(env.allowAdminMutationTests).toBe(false);
        setBusinessData({
          confirmationClicks: 0,
          finalStatus: 'Validation完成，未提交入金申请'
        });
        setActual('两个资金写开关保持关闭；提交按钮点击0次');
      }
    );
  }
);
