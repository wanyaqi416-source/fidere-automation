import { TransferPage } from '../../../pages/client/TransferPage';
import { expect, test } from '../../../fixtures/client.fixture';
import { env } from '../../../src/config/env';
import { deriveUniqueTransferAmount } from '../../../src/transfer/transfer-e2e';
import { Decimal } from '../../../src/utils/money';
import { getClientSecurityKey } from '../../../src/utils/security-key';
import {
  getTransferTestConfig,
  parseTransferAmount
} from './transferTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });

async function openConfiguredTransferPage(
  baseURL: string,
  transferPage: TransferPage
): Promise<void> {
  const config = getTransferTestConfig();
  await transferPage.gotoBrokerageDetail(
    baseURL,
    config.brokerName,
    config.brokerAccountId
  );
}

test(
  '资金互转入口、方向和账户组合校验 @client @transfer @validation @readonly @L1',
  async ({ baseURL, page }) => {
    if (!baseURL) {
      throw new Error('CLIENT_BASE_URL is required for Transfer validation tests.');
    }

    const config = getTransferTestConfig();
    const transferPage = new TransferPage(page);
    expect(config.sourceAccountType).not.toBe(config.targetAccountType);
    await openConfiguredTransferPage(baseURL, transferPage);

    await test.step('校验信托账户转入券商账户', async () => {
      await transferPage.open('trust-to-broker');
      const currencies = await transferPage.readSupportedCurrencies();
      expect(currencies).toContain(config.currency);
      await transferPage.selectCurrency(config.currency);
      await transferPage.expectConfiguredForm(
        'trust-to-broker',
        config.sourceAccountType,
        config.targetAccountType,
        config.currency
      );
      await expect(transferPage.submitForReviewButton).toBeVisible();
      expect(transferPage.wasSubmissionClicked()).toBe(false);
      await transferPage.closeWithoutSubmitting();
    });

    await test.step('校验券商账户转出至信托账户', async () => {
      await transferPage.open('broker-to-trust');
      const currencies = await transferPage.readSupportedCurrencies();
      expect(currencies).toContain(config.currency);
      await transferPage.selectCurrency(config.currency);
      await transferPage.expectConfiguredForm(
        'broker-to-trust',
        config.targetAccountType,
        config.sourceAccountType,
        config.currency
      );
      await expect(transferPage.submitForReviewButton).toBeVisible();
      expect(transferPage.wasSubmissionClicked()).toBe(false);
      await transferPage.closeWithoutSubmitting();
    });
  }
);

test(
  '资金互转金额边界校验 @client @transfer @validation @readonly @L1',
  async ({ baseURL, page }, testInfo) => {
    if (!baseURL) {
      throw new Error('CLIENT_BASE_URL is required for Transfer validation tests.');
    }

    const config = getTransferTestConfig();
    const transferPage = new TransferPage(page);
    await openConfiguredTransferPage(baseURL, transferPage);
    await transferPage.open('trust-to-broker');
    await transferPage.selectCurrency(config.currency);

    await test.step('校验金额为空', async () => {
      await transferPage.expectAmountValue('');
      const preview = await transferPage.readPreview();
      expect(
        parseTransferAmount(preview.receivedAmountText, 'empty transfer preview').isZero()
      ).toBe(true);
      testInfo.annotations.push({
        type: 'transfer-empty-amount',
        description: '金额为空时提交审核按钮仍启用；因禁止点击最终按钮，提交时校验规则待确认'
      });
    });

    await test.step('校验金额为零', async () => {
      await transferPage.fillAmount('0');
      await transferPage.blurAmount();
      const preview = await transferPage.readPreview();
      expect(
        parseTransferAmount(preview.receivedAmountText, 'zero transfer preview').isZero()
      ).toBe(true);
      testInfo.annotations.push({
        type: 'transfer-zero-amount',
        description: '金额为0时页面未在提交前显示错误；因禁止点击最终按钮，提交时校验规则待确认'
      });
    });

    await test.step('校验两位小数金额格式', async () => {
      const decimalAmount = deriveUniqueTransferAmount(
        'TR-001-DECIMAL-CAPABILITY',
        config.uniqueAmountBase,
        config.amountPrecision
      ).toFixed(config.amountPrecision);
      await transferPage.fillAmount(decimalAmount);
      await transferPage.expectAmountValue(decimalAmount);
      await transferPage.blurAmount();
      const preview = await transferPage.readPreview();
      const fee = parseTransferAmount(preview.feeText, 'decimal transfer fee');
      const received = parseTransferAmount(
        preview.receivedAmountText,
        'decimal transfer expected received amount'
      );
      expect(fee.plus(received).equals(new Decimal(decimalAmount))).toBe(true);
      testInfo.annotations.push({
        type: 'transfer-amount-precision',
        description: `页面接受${config.amountPrecision}位小数金额${decimalAmount}，费用与预计到账之和精确匹配`
      });
    });

    await test.step('校验余额不足', async () => {
      await transferPage.fillPurposeIfPresent(config.purpose);
      const sourceBalanceText = await transferPage.readSourceBalanceText(config.currency);
      if (sourceBalanceText) {
        const sourceBalance = parseTransferAmount(sourceBalanceText, 'transfer source balance');
        await transferPage.fillAmount(sourceBalance.plus(new Decimal(1)).toString());
        await transferPage.blurAmount();
        testInfo.annotations.push({
          type: 'transfer-insufficient-balance',
          description: (await transferPage.hasInsufficientBalanceState())
            ? '页面在提交前识别余额不足'
            : '页面在提交前未识别余额不足；最终提交校验待确认'
        });
      } else {
        testInfo.annotations.push({
          type: 'transfer-insufficient-balance',
          description: '付款账户下拉未显示余额，无法在不提交申请的前提下构造余额不足边界'
        });
      }
    });

    await test.step('记录页面限额规则', async () => {
      const limits = await transferPage.readDisplayedLimits();
      testInfo.annotations.push({
        type: 'transfer-limits',
        description: limits.length > 0 ? limits.join('；') : '页面未显示最低或最高金额规则'
      });
    });

    expect(transferPage.wasSubmissionClicked()).toBe(false);
    await transferPage.closeWithoutSubmitting();
  }
);

test(
  '资金互转提交前校验',
  {
    tag: ['@client', '@transfer', '@validation', '@readonly', '@L1'],
    annotation: [
      { type: 'caseId', description: 'TR-001' },
      { type: 'module', description: '客户端资金互转' },
      { type: 'priority', description: 'P0' },
      { type: 'owner', description: 'QA' },
      { type: 'requirement', description: 'Transfer pre-submit validation' },
      { type: 'type', description: 'Validation / Non-mutation' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ baseURL, page, business }) => {
    if (!baseURL) {
      throw new Error('CLIENT_BASE_URL is required for Transfer validation tests.');
    }

    const config = getTransferTestConfig();
    const transferPage = new TransferPage(page);
    const validationRunId = 'TR-001-VALIDATION';
    const validationAmount = deriveUniqueTransferAmount(
      validationRunId,
      config.uniqueAmountBase,
      config.amountPrecision
    ).toFixed(config.amountPrecision);
    let sourceBalance: Decimal | undefined;

    business.case({
      caseId: 'TR-001',
      module: '客户端资金互转',
      name: '资金互转提交前校验',
      description: '验证已开通券商账户的互转入口、账户、金额、手续费、预计到账和安全密钥弹窗，在点击安全密钥验证前停止。',
      priority: 'P0',
      type: ['Validation', 'Non-mutation'],
      scope: 'Client',
      owner: 'QA',
      requirement: 'Transfer pre-submit validation',
      preconditions: ['客户端自动登录成功', '老虎证券账户已开通', 'ALLOW_MONEY_TESTS=false'],
      target: '确认信托账户转券商账户的申请表、费用预览和安全密钥弹窗真实可用，且不创建互转申请。',
      expectedResult: '配置账户与USD币种正确，费用和预计到账计算一致；提交审核只点击一次，填写安全密钥但不点击验证。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: true
    });
    business.setBusinessData({
      sourceAccountType: config.sourceAccountType,
      targetAccountType: config.targetAccountType,
      transferDirection: '信托账户 -> 券商账户',
      transferCurrency: config.currency,
      transferAmount: validationAmount,
      runId: validationRunId,
      amountPrecision: config.amountPrecision
    });

    await business.step(
      {
        action: '打开已开通券商的资金互转页面',
        expected: '老虎证券状态为已开通，显示两个真实资金划转方向'
      },
      async ({ setActual }) => {
        await openConfiguredTransferPage(baseURL, transferPage);
        setActual('已进入已开通券商详情，信托转券商和券商转信托入口均可见');
      }
    );

    await business.step(
      {
        action: '选择信托账户转入券商账户',
        expected: '表单显示不同的转出/转入账户和配置币种'
      },
      async ({ setActual }) => {
        await transferPage.open('trust-to-broker');
        const currencies = await transferPage.readSupportedCurrencies();
        expect(currencies).toContain(config.currency);
        await transferPage.selectCurrency(config.currency);
        await transferPage.expectConfiguredForm(
          'trust-to-broker',
          config.sourceAccountType,
          config.targetAccountType,
          config.currency
        );
        business.setBusinessData({ supportedCurrencies: currencies });
        setActual(`转出账户为${config.sourceAccountType}，转入账户为${config.targetAccountType}，币种为${config.currency}`);
      }
    );

    await business.step(
      {
        action: '读取余额并填写测试金额',
        expected: '不硬编码余额，当前转出余额足以预览配置金额'
      },
      async ({ setActual, setBusinessData }) => {
        const sourceBalanceText = await transferPage.readSourceBalanceText(config.currency);
        sourceBalance = sourceBalanceText
          ? parseTransferAmount(sourceBalanceText, 'transfer source balance')
          : undefined;
        await transferPage.fillAmount(validationAmount);
        await transferPage.expectAmountValue(validationAmount);
        await transferPage.fillPurposeIfPresent(config.purpose);
        setBusinessData({
          transferSourceBalanceBefore: sourceBalance?.toString() ?? '表单未显示'
        });
        setActual(
          sourceBalance
            ? `已读取当前余额并填写${validationAmount} ${config.currency}`
            : `付款账户下拉未显示余额；已填写${validationAmount} ${config.currency}用于只读费用预览`
        );
      }
    );

    await business.step(
      {
        action: '校验手续费和预计到账',
        expected: '信托转券商手续费从转账金额中扣除，转账金额等于手续费加预计到账'
      },
      async ({ setActual, setBusinessData }) => {
        const preview = await transferPage.readPreview();
        const fee = parseTransferAmount(preview.feeText, 'transfer fee');
        const receivedAmount = parseTransferAmount(
          preview.receivedAmountText,
          'transfer expected received amount'
        );
        expect(fee.isPositive()).toBe(true);
        expect(
          fee.plus(receivedAmount).equals(new Decimal(validationAmount))
        ).toBe(true);
        setBusinessData({
          fee: preview.feeText,
          expectedReceivedAmount: receivedAmount.toString()
        });
        setActual(`手续费为${preview.feeText}，预计到账${preview.receivedAmountText}，费用从转账金额中扣除`);
      }
    );

    await business.step(
      {
        action: '打开并校验安全密钥弹窗后停止',
        expected: '提交审核只点击一次；弹窗读取CLIENT_SECURITY_KEY并正确填写，但不点击“验证”'
      },
      async ({ setActual, setBusinessData }) => {
        await expect(transferPage.submitForReviewButton).toBeVisible();
        await transferPage.openSecurityKeyDialogOnce();
        const securityKeyDom = await transferPage.readSecurityKeyDomStructure();
        expect([1, 6]).toContain(securityKeyDom.visibleInputCount);
        await transferPage.fillSecurityKey(getClientSecurityKey());
        await expect(transferPage.securityKey.verifyButton).toBeEnabled();
        expect(transferPage.wasSubmissionClicked()).toBe(true);
        expect(transferPage.wasSecurityVerificationClicked()).toBe(false);
        setBusinessData({
          confirmationClicks: 1,
          securityVerificationClicks: 0,
          verificationClicked: false,
          securityKeyDom,
          confirmed: false,
          finalStatus: '安全密钥已填写，停在“验证”前，未创建资金互转申请'
        });
        setActual(`已打开安全密钥弹窗并填写${securityKeyDom.visibleInputCount}个可见输入框；“验证”点击0次`);
        await transferPage.closeSecurityKeyWithoutVerifying();
      }
    );

    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(transferPage.wasSubmissionClicked()).toBe(true);
    expect(transferPage.wasSecurityVerificationClicked()).toBe(false);
    await transferPage.closeWithoutSubmitting();
  }
);

test(
  '券商转信托费用预览校验 @client @transfer @validation @readonly @L1',
  async ({ baseURL, page }) => {
    if (!baseURL) {
      throw new Error('CLIENT_BASE_URL is required for Transfer validation tests.');
    }

    const config = getTransferTestConfig();
    const transferPage = new TransferPage(page);
    await openConfiguredTransferPage(baseURL, transferPage);
    await transferPage.open('broker-to-trust');
    await transferPage.selectCurrency(config.currency);
    await transferPage.expectConfiguredForm(
      'broker-to-trust',
      config.targetAccountType,
      config.sourceAccountType,
      config.currency
    );
    await transferPage.fillAmount(config.testAmount);
    await transferPage.fillPurposeIfPresent(config.purpose);

    const preview = await transferPage.readPreview();
    expect(parseTransferAmount(preview.feeText, 'reverse transfer fee').isZero()).toBe(true);
    expect(
      parseTransferAmount(
        preview.receivedAmountText,
        'reverse transfer expected received amount'
      ).equals(new Decimal(config.testAmount))
    ).toBe(true);
    await transferPage.expectNoSecurityKeyDialog();
    expect(transferPage.wasSubmissionClicked()).toBe(false);
    await transferPage.closeWithoutSubmitting();
  }
);
