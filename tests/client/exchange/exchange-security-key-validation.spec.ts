import { ExchangePage, type SecurityKeyDomStructure } from '../../../pages/client/ExchangePage';
import { TransactionsPage } from '../../../pages/client/TransactionsPage';
import { expect, test } from '../../../fixtures/client.fixture';
import { Decimal } from '../../../src/utils/money';
import { getClientSecurityKey } from '../../../src/utils/security-key';
import {
  getExchangeTestConfig,
  parseExchangeBalance,
  parseExchangeQuote,
  type ExchangeQuote
} from './exchangeTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test(
  '安全密钥弹窗提交前验证',
  {
    tag: ['@client', '@exchange', '@security-key', '@validation', '@L1'],
    annotation: [
      { type: 'caseId', description: 'EX-002' },
      { type: 'module', description: '客户端兑换' },
      { type: 'priority', description: 'P0' },
      { type: 'owner', description: 'QA' },
      { type: 'requirement', description: 'Exchange security-key gate' },
      { type: 'type', description: 'Pre-submit / Non-mutation' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' },
      {
        type: 'precondition',
        description: '测试账号余额充足；确认兑换只打开安全密钥弹窗，完成验证前不会成交'
      },
      {
        type: 'expectedResult',
        description: '密钥填写后验证按钮可用；不点击验证并关闭弹窗后，无新增交易且余额不变'
      }
    ]
  },
  async ({ baseURL, page, business }, testInfo) => {
    if (!baseURL) {
      throw new Error('CLIENT_BASE_URL is required for the Exchange security-key validation test.');
    }

    const config = getExchangeTestConfig();
    const exchangePage = new ExchangePage(page);
    const transactionsPage = new TransactionsPage(page);
    let beforeSource = new Decimal(0);
    let beforeTarget = new Decimal(0);
    let afterSource = new Decimal(0);
    let afterTarget = new Decimal(0);
    let recordIdsBefore: string[] = [];
    let recordIdsAfter: string[] = [];
    let quote: ExchangeQuote | undefined;
    let securityDom: SecurityKeyDomStructure | undefined;
    let requestPhase = '准备阶段';
    const mutationRequests: Array<{ phase: string; method: string; path: string; status: number }> = [];

    page.on('response', response => {
      const method = response.request().method();

      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        return;
      }

      mutationRequests.push({
        phase: requestPhase,
        method,
        path: new URL(response.url()).pathname,
        status: response.status()
      });
    });

    business.case({
      caseId: 'EX-002',
      module: '客户端兑换',
      name: '安全密钥弹窗提交前验证',
      description: '验证六位安全密钥输入结构和按钮状态，但不点击验证，不产生真实成交。',
      priority: 'P0',
      type: ['Pre-submit', 'Non-mutation'],
      scope: 'Client',
      owner: 'QA',
      requirement: 'Exchange security-key gate',
      preconditions: [
        '客户端登录状态有效',
        '当前测试账号余额充足',
        '真实成交必须在点击安全密钥验证后发生'
      ],
      target: '确认安全密钥弹窗可被自动化稳定识别和填写，并证明验证前无业务变化。',
      expectedResult: '安全密钥可填写且验证按钮可用；不点击验证并关闭弹窗后无资金或交易变化。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: false,
      dependsOnThirdParty: false
    });
    business.setBusinessData({
      sourceAccountType: config.sourceAccountType,
      targetAccountType: config.targetAccountType,
      exchangePair: `${config.fromCurrency} -> ${config.toCurrency}`,
      fromCurrency: config.fromCurrency,
      toCurrency: config.toCurrency,
      amount: config.testAmount,
      confirmed: false
    });

    await business.step(
      { action: '记录提交前交易与余额基线', expected: '读取当前可见兑换交易编号和两端可用余额' },
      async ({ setActual, setBusinessData }) => {
      await transactionsPage.goto(baseURL);
      await transactionsPage.selectTransferType();
      recordIdsBefore = await transactionsPage.readVisibleExchangeRecordIds(
        config.fromCurrency,
        config.toCurrency
      );

      await exchangePage.gotoDashboard(baseURL);
      await exchangePage.openFromAssetRow(config.dashboardAsset, config.dashboardNetwork);
      await exchangePage.selectSourceAsset(config.sourceAccountType, config.fromCurrency);
      await exchangePage.selectTargetAsset(config.targetAccountType, config.toCurrency);
      beforeSource = parseExchangeBalance(
        await exchangePage.readSourceBalanceText(),
        'source balance before security-key validation'
      );
      beforeTarget = parseExchangeBalance(
        await exchangePage.readTargetBalanceText(),
        'target balance before security-key validation'
      );
        setBusinessData({
          sourceBalanceBefore: beforeSource.toString(),
          targetBalanceBefore: beforeTarget.toString()
        });
        setActual(`已记录两端余额和 ${recordIdsBefore.length} 条当前可见兑换记录`);
      }
    );

    await business.step(
      { action: '进入兑换页面并填写信息', expected: '显示正确的转出、转入账户和金额' },
      async ({ setActual }) => {
      expect(
        beforeSource.greaterThanOrEqualTo(new Decimal(config.testAmount)),
        `兑换余额不足：预期转出余额至少为 ${config.testAmount} ${config.fromCurrency}，实际为 ${beforeSource.toString()} ${config.fromCurrency}。`
      ).toBe(true);
      await exchangePage.fillSourceAmount(config.testAmount);
      await expect(exchangePage.quoteButton).toBeEnabled();
        setActual(`已填写 ${config.testAmount} ${config.fromCurrency}，获取报价按钮可用`);
      }
    );

    await business.step(
      { action: '获取报价并进入确认页', expected: '确认页显示完整汇率、手续费和预计到账金额' },
      async ({ setActual, setBusinessData }) => {
      const sourceLabel = await exchangePage.readSourceAssetLabel();
      const targetLabel = await exchangePage.readTargetAssetLabel();
      await exchangePage.requestQuote();
      await expect(exchangePage.confirmationDialog).toBeVisible();
      quote = parseExchangeQuote(
        await exchangePage.readConfirmationText(),
        config,
        sourceLabel,
        targetLabel
      );
      expect(quote.sourceAmount.equals(new Decimal(config.testAmount))).toBe(true);
      expect(quote.rate.isPositive()).toBe(true);
      expect(quote.feeText).toBe('免费');
        setBusinessData({
          sourceAmount: quote.sourceAmount.toString(),
          rate: quote.rate.toString(),
          fee: quote.feeText,
          expectedReceivedAmount: quote.receivedAmount.toString(),
          quoteValidity: quote.countdown
        });
        setActual(`确认页显示汇率 ${quote.rate.toString()}、手续费 ${quote.feeText}、预计到账 ${quote.receivedAmount.toString()} ${config.toCurrency}`);
      }
    );

    await business.step(
      { action: '打开安全密钥验证弹窗', expected: '点击一次确认兑换后显示安全密钥验证弹窗' },
      async ({ setActual, setBusinessData }) => {
      requestPhase = '确认兑换后、验证前';
      await exchangePage.openSecurityKeyDialogOnce();
      securityDom = await exchangePage.readSecurityKeyDomStructure();

      await testInfo.attach('security-key-dom.json', {
        body: Buffer.from(JSON.stringify(securityDom, null, 2)),
        contentType: 'application/json'
      });
        setBusinessData({ securityKeyDom: securityDom });
        setActual(`安全密钥弹窗已显示，发现 ${securityDom.visibleInputCount} 个可见输入框`);
      }
    );

    await business.step(
      { action: '填写安全密钥但不验证', expected: '六位密钥填写完成且验证按钮可点击' },
      async ({ setActual }) => {
      const securityKey = getClientSecurityKey();
      await exchangePage.fillSecurityKey(securityKey);
      await expect(
        exchangePage.verifySecurityKeyButton,
        '安全密钥填写完成后，预期“验证”按钮可点击，实际仍为禁用状态。'
      ).toBeEnabled();
      expect(
        exchangePage.wasSecurityKeyVerificationClicked(),
        '提交前验证禁止点击“验证”按钮，实际检测到已点击。'
      ).toBe(false);
        setActual('六位安全密钥已填写且验证按钮可用；密钥值未记录，验证按钮未点击');
      }
    );

    await business.step(
      { action: '关闭安全密钥弹窗', expected: '不点击验证即可关闭弹窗' },
      async ({ setActual }) => {
      requestPhase = '关闭安全密钥弹窗';
      await exchangePage.closeSecurityKeyDialogWithoutVerifying();
      expect(exchangePage.wasSecurityKeyVerificationClicked()).toBe(false);
        setActual('安全密钥弹窗已关闭，“验证”按钮点击次数为0');
      }
    );

    await business.step(
      { action: '确认没有余额和交易变化', expected: '两端余额及可见兑换交易编号与基线一致' },
      async ({ setActual, setBusinessData }) => {
      await exchangePage.gotoDashboard(baseURL);
      await exchangePage.openFromAssetRow(config.dashboardAsset, config.dashboardNetwork);
      await exchangePage.selectSourceAsset(config.sourceAccountType, config.fromCurrency);
      await exchangePage.selectTargetAsset(config.targetAccountType, config.toCurrency);
      afterSource = parseExchangeBalance(
        await exchangePage.readSourceBalanceText(),
        'source balance after closing security-key dialog'
      );
      afterTarget = parseExchangeBalance(
        await exchangePage.readTargetBalanceText(),
        'target balance after closing security-key dialog'
      );

      expect(
        afterSource.equals(beforeSource),
        `转出余额发生变化：关闭安全密钥弹窗后预期仍为 ${beforeSource.toString()} ${config.fromCurrency}，实际为 ${afterSource.toString()} ${config.fromCurrency}。`
      ).toBe(true);
      expect(
        afterTarget.equals(beforeTarget),
        `转入余额发生变化：关闭安全密钥弹窗后预期仍为 ${beforeTarget.toString()} ${config.toCurrency}，实际为 ${afterTarget.toString()} ${config.toCurrency}。`
      ).toBe(true);

      await transactionsPage.goto(baseURL);
      await transactionsPage.selectTransferType();
      await expect
        .poll(
          async () => {
            recordIdsAfter = await transactionsPage.readVisibleExchangeRecordIds(
              config.fromCurrency,
              config.toCurrency
            );
            return recordIdsAfter;
          },
          {
            message:
              '兑换记录发生变化：未点击安全密钥“验证”按钮，预期可见兑换交易编号与执行前完全一致。',
            timeout: 20_000
          }
        )
        .toEqual(recordIdsBefore);
        setBusinessData({
          sourceBalanceAfter: afterSource.toString(),
          targetBalanceAfter: afterTarget.toString(),
          actualReceivedAmount: '0',
          recordIdsUnchanged: true,
          verificationClicked: false,
          potentiallySubmitted: false,
          manualCheckRequired: false,
          finalStatus: '未提交（安全密钥弹窗已关闭）',
          networkObservations: mutationRequests
        });
        setActual('转出余额、转入余额和可见兑换交易编号均与执行前一致，确认未成交');
      }
    );

    await testInfo.attach('exchange-security-key-validation-summary.json', {
      body: Buffer.from(
        JSON.stringify(
          {
            exchangePair: `${config.fromCurrency} -> ${config.toCurrency}`,
            sourceAmount: config.testAmount,
            sourceBalanceBefore: beforeSource.toString(),
            sourceBalanceAfter: afterSource.toString(),
            targetBalanceBefore: beforeTarget.toString(),
            targetBalanceAfter: afterTarget.toString(),
            rate: quote?.rate.toString(),
            fee: quote?.feeText,
            expectedReceivedAmount: quote?.receivedAmount.toString(),
            actualReceivedAmount: '0',
            recordIdsUnchanged: JSON.stringify(recordIdsBefore) === JSON.stringify(recordIdsAfter),
            securityKeyDom: securityDom,
            networkObservations: mutationRequests,
            verificationClicked: false,
            potentiallySubmitted: false,
            manualCheckRequired: false,
            finalStatus: '未提交（安全密钥弹窗已关闭）'
          },
          null,
          2
        )
      ),
      contentType: 'application/json'
    });
  }
);
