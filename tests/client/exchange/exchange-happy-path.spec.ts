import { ExchangePage, type SecurityKeyDomStructure } from '../../../pages/client/ExchangePage';
import type { ExchangeDetail } from '../../../pages/client/ExchangeDetailDrawer';
import { TransactionsPage } from '../../../pages/client/TransactionsPage';
import type { Request, TestInfo } from '@playwright/test';
import { expect, test } from '../../../fixtures/client.fixture';
import { env } from '../../../src/config/env';
import { MoneyMutationGuard } from '../../../src/flow-engine/mutation-guard';
import type { BusinessReportApi } from '../../../src/reporting/business-report.types';
import { maskBusinessId } from '../../../src/reporting/sensitive-data-mask';
import {
  isExchangeBusinessId,
  isLedgerTransactionId
} from '../../../src/utils/business-id';
import { Decimal, decimalFromText } from '../../../src/utils/money';
import {
  getExchangeTestConfig,
  parseExchangeBalance,
  parseExchangeQuote,
  type ExchangeQuote
} from './exchangeTestSupport';
import { getClientSecurityKey } from '../../../src/utils/security-key';

test.describe.configure({ mode: 'serial', retries: 0 });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.skip(
  !env.exchange.allowMoneyTests,
  '真实兑换默认禁用；仅在审批后显式设置 ALLOW_MONEY_TESTS=true 才执行一次。'
);

async function businessStep<T>(
  business: BusinessReportApi,
  title: string,
  expected: string,
  action: () => Promise<T>
): Promise<T> {
  return business.step({ action: title, expected }, async ({ setActual }) => {
    const result = await action();
    setActual('步骤已按业务预期完成，具体值见业务执行数据。');
    return result;
  });
}

type MutationRequestObservation = {
  phase: string;
  method: string;
  path: string;
  status: number;
  requestedAt: string;
};

function pageTimestamp(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, '0');

  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
    ':',
    pad(date.getSeconds())
  ].join('');
}

async function savePostVerificationNetworkEvidence(
  testInfo: TestInfo,
  business: BusinessReportApi,
  observations: MutationRequestObservation[],
  attachmentName: string
): Promise<void> {
  const safeObservations = observations.filter(
    observation => observation.phase === '点击安全密钥验证后'
  );

  business.setBusinessData({ networkObservations: safeObservations });
  await testInfo.attach(attachmentName, {
    body: Buffer.from(JSON.stringify(safeObservations, null, 2)),
    contentType: 'application/json'
  });
}

test(
  '客户端兑换完整闭环',
  {
    tag: ['@client', '@exchange', '@money', '@mutation'],
    annotation: [
      { type: 'caseId', description: 'EX-001' },
      { type: 'module', description: '客户端兑换' },
      { type: 'priority', description: 'P0' },
      { type: 'owner', description: 'QA' },
      { type: 'requirement', description: 'Exchange end-to-end settlement' },
      { type: 'type', description: 'Money / Mutation' },
      { type: 'changesData', description: 'true' },
      { type: 'affectsMoney', description: 'true' },
      {
        type: 'precondition',
        description: '专用测试账号余额充足；测试环境；资金开关已审批；单 worker、零重试'
      },
      {
        type: 'expectedResult',
        description: '安全密钥验证后兑换成功，余额按最终报价变化并生成唯一成功 OTC 记录'
      }
    ]
  },
  async ({ baseURL, page, business }, testInfo) => {
    if (!baseURL) {
      throw new Error('CLIENT_BASE_URL is required for the Exchange money test.');
    }

    const config = getExchangeTestConfig();
    const mutationGuard = new MoneyMutationGuard('exchange', false);
    const exchangePage = new ExchangePage(page);
    const transactionsPage = new TransactionsPage(page);
    let submittedAfter: Date | undefined;
    let beforeSource = new Decimal(0);
    let beforeTarget = new Decimal(0);
    let afterSource: Decimal | undefined;
    let afterTarget: Decimal | undefined;
    let quote: ExchangeQuote | undefined;
    let ledgerTransactionId: string | undefined;
    let exchangeOrderId: string | undefined;
    let exchangeDetail: ExchangeDetail | undefined;
    let recordOccurredAt: string | undefined;
    let sourceDisplayLabel = '';
    let targetDisplayLabel = '';
    let securityDom: SecurityKeyDomStructure | undefined;
    let recordIdsBefore: string[] = [];
    let resultSignal = '未观察到明确页面成功提示，转入历史和余额交叉核查';
    let requestPhase = '验证前';
    let verificationAttempts = 0;
    let potentiallySubmitted = false;
    let manualCheckRequired = false;
    const mutationRequests: MutationRequestObservation[] = [];
    const mutationRequestMetadata = new WeakMap<Request, { phase: string; requestedAt: string }>();

    page.on('request', request => {
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) {
        mutationRequestMetadata.set(request, {
          phase: requestPhase,
          requestedAt: new Date().toISOString()
        });
      }
    });

    page.on('response', response => {
      const request = response.request();
      const method = request.method();

      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        return;
      }

      const metadata = mutationRequestMetadata.get(request);

      mutationRequests.push({
        phase: metadata?.phase ?? requestPhase,
        method,
        path: new URL(response.url()).pathname,
        status: response.status(),
        requestedAt: metadata?.requestedAt ?? new Date().toISOString()
      });
    });

    business.case({
      caseId: 'EX-001',
      module: '客户端兑换',
      name: '客户端兑换完整闭环',
      description: '完成报价、预确认、安全密钥验证、余额变化和唯一交易记录的客户端兑换闭环。',
      priority: 'P0',
      type: ['Money', 'Mutation'],
      scope: 'Client',
      owner: 'QA',
      requirement: 'Exchange end-to-end settlement',
      preconditions: [
        '当前环境为Sandbox或Staging测试环境',
        '专用测试账号余额充足',
        'ALLOW_MONEY_TESTS=true',
        'workers=1且retries=0'
      ],
      target: '验证真实兑换只提交一次，并通过余额和唯一OTC业务编号完成业务闭环。',
      expectedResult: '安全密钥验证后兑换成功，余额按最终报价变化并生成唯一成功OTC记录。',
      changesData: true,
      affectsMoney: true,
      dependsOnAdmin: false,
      dependsOnThirdParty: false,
      safetySwitches: ['ALLOW_MONEY_TESTS=true']
    });
    business.setBusinessData({
      sourceAccountType: config.sourceAccountType,
      targetAccountType: config.targetAccountType,
      fromCurrency: config.fromCurrency,
      toCurrency: config.toCurrency,
      exchangePair: `${config.fromCurrency} -> ${config.toCurrency}`,
      amount: config.testAmount
    });

    await businessStep(
      business,
      '1. 检查测试环境和资金安全开关',
      '仅在已识别测试域名、ALLOW_MONEY_TESTS=true、workers=1、retries=0 时继续',
      async () => {
        mutationGuard.markAuthenticationReady(true, false);
        mutationGuard.validateRuntime({
          baseURL,
          workers: testInfo.config.workers,
          retries: testInfo.project.retries,
          repeatEach: testInfo.project.repeatEach,
          safetySwitches: { ALLOW_MONEY_TESTS: env.exchange.allowMoneyTests }
        });
        mutationGuard.assertClientSubmissionAllowed({
          ALLOW_MONEY_TESTS: env.exchange.allowMoneyTests
        });
        expect(testInfo.retry).toBe(0);
        expect(testInfo.repeatEachIndex).toBe(0);

        await transactionsPage.goto(baseURL);
        await transactionsPage.selectTransferType();
        recordIdsBefore = await transactionsPage.readVisibleExchangeRecordIds(
          config.fromCurrency,
          config.toCurrency
        );

      }
    );

    await businessStep(business, '2. 读取兑换前账户余额', '读取配置币种的两端可用余额且转出余额充足', async () => {
      await exchangePage.gotoDashboard(baseURL);
      await exchangePage.openFromAssetRow(config.dashboardAsset, config.dashboardNetwork);
      await exchangePage.selectSourceAsset(config.sourceAccountType, config.fromCurrency);
      await exchangePage.selectTargetAsset(config.targetAccountType, config.toCurrency);
      beforeSource = parseExchangeBalance(
        await exchangePage.readSourceBalanceText(),
        'source balance before exchange'
      );
      beforeTarget = parseExchangeBalance(
        await exchangePage.readTargetBalanceText(),
        'target balance before exchange'
      );
      business.setBusinessData({
        sourceBalanceBefore: beforeSource.toString(),
        targetBalanceBefore: beforeTarget.toString()
      });

      if (beforeSource.lessThan(new Decimal(config.testAmount))) {
        throw new Error(
          `转出余额不足：当前余额 ${beforeSource.toString()} ${config.fromCurrency}，测试金额 ${config.testAmount} ${config.fromCurrency}。`
        );
      }
    });

    await businessStep(business, '3. 选择转出账户和转入账户', '页面显示已配置的账户类型和币种', async () => {
      sourceDisplayLabel = await exchangePage.readSourceAssetLabel();
      targetDisplayLabel = await exchangePage.readTargetAssetLabel();
      await expect(exchangePage.sourcePanel).toContainText(config.fromCurrency.split('_')[0]);
      await expect(exchangePage.targetPanel).toContainText(config.toCurrency);
    });

    await businessStep(business, '4. 填写兑换金额', '显示配置金额且获取报价按钮可用', async () => {
      await exchangePage.fillSourceAmount(config.testAmount);
      await expect(exchangePage.sourceAmountInput).toHaveValue(config.testAmount);
      await expect(exchangePage.quoteButton).toBeEnabled();
    });

    await businessStep(business, '5. 获取并校验兑换报价', '获得正数汇率、免费手续费、正数预计到账和有效倒计时', async () => {
      await exchangePage.requestQuote();
      await expect(exchangePage.confirmationDialog).toBeVisible();
      quote = parseExchangeQuote(
        await exchangePage.readConfirmationText(),
        config,
        sourceDisplayLabel,
        targetDisplayLabel
      );

      expect(quote.sourceAmount.equals(new Decimal(config.testAmount))).toBe(true);
      expect(quote.receivedAmount.isPositive()).toBe(true);
      expect(quote.rate.isPositive()).toBe(true);
      expect(quote.feeText).toBe('免费');
      expect(quote.countdown).not.toBe('00:00');
      business.setBusinessData({
        sourceAmount: quote.sourceAmount.toString(),
        rate: quote.rate.toString(),
        fee: quote.feeText,
        expectedReceivedAmount: quote.receivedAmount.toString(),
        quoteValidity: quote.countdown
      });

      await testInfo.attach('exchange-pre-submit-quote.json', {
        body: Buffer.from(
          JSON.stringify(
            {
              sourceAccountType: config.sourceAccountType,
              targetAccountType: config.targetAccountType,
              fromCurrency: config.fromCurrency,
              toCurrency: config.toCurrency,
              sourceBalanceBefore: beforeSource.toString(),
              targetBalanceBefore: beforeTarget.toString(),
              sourceAmount: quote.sourceAmount.toString(),
              rate: quote.rate.toString(),
              fee: quote.feeText,
              expectedReceivedAmount: quote.receivedAmount.toString(),
              quoteValidity: quote.countdown
            },
            null,
            2
          )
        ),
        contentType: 'application/json'
      });
    });

    await businessStep(business, '6. 校验兑换确认信息', '确认页仍显示本次报价并提供返回修改和确认兑换按钮', async () => {
      if (!quote) {
        throw new Error('报价对象不存在，不能校验确认信息。');
      }

      const confirmationText = await exchangePage.readConfirmationText();
      expect(confirmationText).toContain(sourceDisplayLabel);
      expect(confirmationText).toContain(targetDisplayLabel);
      expect(confirmationText).toContain(quote.rate.toString());
      await expect(exchangePage.returnToEditButton).toBeVisible();
      await expect(exchangePage.confirmExchangeButton).toBeVisible();
    });

    await businessStep(business, '7. 打开安全密钥验证弹窗', '确认兑换只点击一次并出现“安全密钥验证”弹窗', async () => {
      requestPhase = '确认兑换后、验证前';
      await exchangePage.openSecurityKeyDialogOnce();
      mutationGuard.recordClientSubmission();
      securityDom = await exchangePage.readSecurityKeyDomStructure();
      await testInfo.attach('security-key-dom.json', {
        body: Buffer.from(JSON.stringify(securityDom, null, 2)),
        contentType: 'application/json'
      });
      business.setBusinessData({ securityKeyDom: securityDom });
    });

    await businessStep(business, '8. 完成安全密钥验证', '六位密钥填写完成，“验证”只点击一次且弹窗消失', async () => {
      const securityKey = getClientSecurityKey();
      await exchangePage.fillSecurityKey(securityKey);
      await expect(exchangePage.verifySecurityKeyButton).toBeEnabled();

      requestPhase = '点击安全密钥验证后';
      submittedAfter = new Date();
      verificationAttempts += 1;
      mutationGuard.recordSecurityKeyVerification();
      potentiallySubmitted = true;
      business.markPotentiallySubmitted();
      business.markDuplicateSubmissionRisk();
      business.disallowSafeRerun();
      try {
        await exchangePage.verifySecurityKeyOnce();
      } finally {
        await savePostVerificationNetworkEvidence(
          testInfo,
          business,
          mutationRequests,
          'exchange-network-after-security-verification.json'
        );
      }
      expect(verificationAttempts).toBe(1);
    });

    await businessStep(business, '9. 等待兑换处理结果', '安全验证弹窗消失；成交结论交由OTC业务编号、余额和历史组合证据判断', async () => {
      await expect(exchangePage.securityKeyDialog).toBeHidden();
      const successMessage = page.getByText(/兑换成功|兑换已完成|交易成功/, { exact: false }).first();

      if (await successMessage.isVisible()) {
        resultSignal = (await successMessage.innerText()).trim();
      }

      await savePostVerificationNetworkEvidence(
        testInfo,
        business,
        mutationRequests,
        'exchange-network-before-history-assertion.json'
      );
    });

    await businessStep(business, '10. 打开兑换详情并取得两个编号', '从唯一新增流水读取TXN编号，并从对应兑换详情读取OTC订单编号', async () => {
      if (quote && submittedAfter) {
        const criteria = {
          fromCurrency: config.fromCurrency,
          toCurrency: config.toCurrency,
          sourceAmount: quote.sourceAmount.toString(),
          receivedAmount: quote.receivedAmountText,
          status: '已完成',
          executedFrom: pageTimestamp(new Date(submittedAfter.getTime() - 60_000)),
          executedTo: pageTimestamp(new Date(Date.now() + 60_000))
        };
        await transactionsPage.goto(baseURL);
        await transactionsPage.selectTransferType();
        const matchingRecords = await transactionsPage.findExchangeRecords({
          ...criteria
        });
        const newRecords = matchingRecords.filter(
          record => !recordIdsBefore.includes(record.ledgerTransactionId)
        );

        if (newRecords.length !== 1) {
          manualCheckRequired = true;
          business.requireManualReview('客户端交易流水和兑换详情');
          throw new Error(
            `按本次账号、币种、金额、状态和时间窗口匹配到 ${newRecords.length} 条新增兑换流水，无法唯一定位本次提交。`
          );
        }

        const record = newRecords[0];
        ledgerTransactionId = record.ledgerTransactionId;
        recordOccurredAt = record.occurredAt;

        try {
          const detailDrawer = await transactionsPage.openExchangeDetail(record);
          exchangeDetail = await detailDrawer.read();
          exchangeOrderId = exchangeDetail.exchangeOrderId;
        } catch (error) {
          manualCheckRequired = true;
          business.requireManualReview('客户端兑换详情');
          throw error;
        }
      }

      if (!ledgerTransactionId || !exchangeOrderId || !exchangeDetail || !quote) {
        manualCheckRequired = true;
        business.requireManualReview('客户端交易流水、兑换详情和两端账户余额');
        testInfo.annotations.push({
          type: 'manual-check',
          description: '安全密钥验证后未取得唯一TXN流水编号及OTC订单编号；不会再次点击验证，将继续核查余额后停止。'
        });
      } else {
        expect(isLedgerTransactionId(ledgerTransactionId)).toBe(true);
        expect(isExchangeBusinessId(exchangeOrderId)).toBe(true);
        expect(exchangeDetail.status).toBe('已完成');
        expect(exchangeDetail.sourceCurrency).toBe(config.fromCurrency);
        expect(exchangeDetail.targetCurrency).toBe(config.toCurrency);
        expect(exchangeDetail.createdAt).toMatch(/^\d{4}年\d{1,2}月\d{1,2}日$/);
        expect(exchangeDetail.completedAt).toMatch(/^\d{4}年\d{1,2}月\d{1,2}日$/);
        expect(
          decimalFromText(exchangeDetail.sourceAmount, 'exchange detail source amount').equals(
            quote.sourceAmount
          )
        ).toBe(true);
        expect(
          decimalFromText(exchangeDetail.targetAmount, 'exchange detail target amount').equals(
            quote.receivedAmount
          )
        ).toBe(true);
        expect(
          decimalFromText(
            exchangeDetail.actualReceivedAmount,
            'exchange detail actual received amount'
          ).equals(quote.receivedAmount)
        ).toBe(true);
        if (quote.feeText === '免费') {
          expect(decimalFromText(exchangeDetail.fee, 'exchange detail fee').isZero()).toBe(true);
        } else {
          expect(
            decimalFromText(exchangeDetail.fee, 'exchange detail fee').equals(
              decimalFromText(quote.feeText, 'exchange quote fee')
            )
          ).toBe(true);
        }
        business.setBusinessData({
          ledgerTransactionId,
          exchangeOrderId,
          exchangeCreatedAt: exchangeDetail.createdAt,
          exchangeCompletedAt: exchangeDetail.completedAt
        });
      }
    });

    await businessStep(business, '11. 校验兑换后账户余额', '转出余额减少报价金额，转入余额增加最终预计到账金额', async () => {
      if (!quote) {
        throw new Error('缺少最终报价，无法计算兑换后预期余额。');
      }

      await exchangePage.gotoDashboard(baseURL);
      await exchangePage.openFromAssetRow(config.dashboardAsset, config.dashboardNetwork);
      await exchangePage.selectSourceAsset(config.sourceAccountType, config.fromCurrency);
      await exchangePage.selectTargetAsset(config.targetAccountType, config.toCurrency);
      afterSource = parseExchangeBalance(
        await exchangePage.readSourceBalanceText(),
        'source balance after exchange'
      );
      afterTarget = parseExchangeBalance(
        await exchangePage.readTargetBalanceText(),
        'target balance after exchange'
      );
      business.setBusinessData({
        sourceBalanceAfter: afterSource.toString(),
        targetBalanceAfter: afterTarget.toString(),
        actualReceivedAmount: afterTarget.minus(beforeTarget).toString()
      });

      const expectedSource = beforeSource.minus(quote.sourceAmount);
      const expectedTarget = beforeTarget.plus(quote.receivedAmount);

      if (!afterSource.equals(expectedSource)) {
        manualCheckRequired = true;
        business.requireManualReview('客户端交易流水和转出账户余额');
        throw new Error(
          `转出余额校验失败：\n兑换前余额：${beforeSource.toString()} ${config.fromCurrency}\n转出金额：${quote.sourceAmount.toString()} ${config.fromCurrency}\n预计兑换后余额：${expectedSource.toString()} ${config.fromCurrency}\n实际兑换后余额：${afterSource.toString()} ${config.fromCurrency}\n安全密钥验证已点击一次，禁止重试，需要人工核查本次提交。`
        );
      }

      if (!afterTarget.equals(expectedTarget)) {
        manualCheckRequired = true;
        business.requireManualReview('客户端交易流水和转入账户余额');
        throw new Error(
          `转入余额校验失败：\n兑换前余额：${beforeTarget.toString()} ${config.toCurrency}\n预计到账：${quote.receivedAmount.toString()} ${config.toCurrency}\n预计兑换后余额：${expectedTarget.toString()} ${config.toCurrency}\n实际兑换后余额：${afterTarget.toString()} ${config.toCurrency}\n安全密钥验证已点击一次，禁止重试，需要人工核查本次提交。`
        );
      }
    });

    await businessStep(business, '12. 校验兑换历史记录', '已读取的TXN流水和OTC订单详情显示正确币种组合、到账金额和已完成状态', async () => {
      if (!quote) {
        throw new Error('缺少最终报价，无法校验交易记录。');
      }

      if (!ledgerTransactionId || !exchangeOrderId || !exchangeDetail) {
        manualCheckRequired = true;
        business.requireManualReview('客户端交易流水和兑换详情');
        throw new Error(
          '安全密钥验证已点击一次，但兑换历史未返回唯一TXN流水编号及OTC订单编号；禁止再次提交，需要人工核查。'
        );
      }

      if (!submittedAfter) {
        throw new Error('缺少安全密钥验证时间，无法按时间窗口复核交易记录。');
      }

      if (!recordOccurredAt) {
        throw new Error('交易记录缺少可校验的执行时间或本次验证时间。');
      }

      const recordedAt = new Date(recordOccurredAt.replace(' ', 'T'));
      expect(recordedAt.getTime()).toBeGreaterThanOrEqual(submittedAfter.getTime() - 60_000);
      expect(exchangeDetail.status).toBe('已完成');
      expect(exchangeDetail.sourceCurrency).toBe(config.fromCurrency);
      expect(exchangeDetail.targetCurrency).toBe(config.toCurrency);
    });

    await businessStep(business, '13. 生成业务执行摘要', '生成不含凭据的报价、余额、TXN流水编号、OTC订单编号、状态和网络阶段摘要', async () => {
      business.setBusinessData({
        sourceBalanceAfter: afterSource?.toString(),
        targetBalanceAfter: afterTarget?.toString(),
        actualReceivedAmount: afterTarget?.minus(beforeTarget).toString(),
        ledgerTransactionId,
        exchangeOrderId,
        transactionStatus: '已完成',
        resultSignal,
        confirmationClicks: 1,
        securityVerificationClicks: verificationAttempts,
        potentiallySubmitted,
        manualCheckRequired,
        networkObservations: mutationRequests,
        finalStatus: '已完成',
        confirmed: true
      });
      await testInfo.attach('exchange-result-summary.json', {
        body: Buffer.from(
          JSON.stringify(
            {
              fromCurrency: config.fromCurrency,
              toCurrency: config.toCurrency,
              amount: config.testAmount,
              sourceBalanceBefore: beforeSource.toString(),
              sourceBalanceAfter: afterSource?.toString(),
              targetBalanceBefore: beforeTarget.toString(),
              targetBalanceAfter: afterTarget?.toString(),
              rate: quote?.rate.toString(),
              fee: quote?.feeText,
              expectedReceivedAmount: quote?.receivedAmount.toString(),
              actualReceivedAmount: afterTarget?.minus(beforeTarget).toString(),
              ledgerTransactionId: ledgerTransactionId
                ? maskBusinessId(ledgerTransactionId)
                : undefined,
              exchangeOrderId: exchangeOrderId
                ? maskBusinessId(exchangeOrderId)
                : undefined,
              status: '已完成',
              resultSignal,
              confirmationClicks: 1,
              securityVerificationClicks: verificationAttempts,
              potentiallySubmitted,
              manualCheckRequired,
              securityKeyDom: securityDom,
              networkObservations: mutationRequests
            },
            null,
            2
          )
        ),
        contentType: 'application/json'
      });
    });
  }
);
