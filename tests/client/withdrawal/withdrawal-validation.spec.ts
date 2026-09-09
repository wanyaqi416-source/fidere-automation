import { WithdrawalPage } from '../../../pages/client/WithdrawalPage';
import { expect, test } from '../../../fixtures/client.fixture';
import { env } from '../../../src/config/env';
import { Decimal } from '../../../src/utils/money';
import { getWithdrawalTestConfig } from './withdrawalTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'WD-001 出金账户与币种矩阵 @client @withdrawal @validation @readonly @L1',
  async ({ baseURL, page }) => {
    if (!baseURL) throw new Error('CLIENT_BASE_URL is required for Withdrawal validation.');
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);
    const withdrawal = new WithdrawalPage(page);
    await withdrawal.goto(baseURL);
    expect(await withdrawal.readAccountCurrencyMatrix()).toEqual({
      香港账户: ['港元', '美元'],
      美国账户: ['美元'],
      新加坡账户: ['港元', '美元', '新加坡元', '阿联酋迪拉姆', '日元'],
      巴林账户: ['港元', '新加坡元', '人民币', '美元', '欧元']
    });
    expect(withdrawal.confirmationClicks()).toBe(0);
    expect(withdrawal.securityVerificationClicks()).toBe(0);
  }
);

test(
  '出金提交前Validation',
  {
    tag: ['@client', '@withdrawal', '@validation', '@readonly', '@L1'],
    annotation: [
      { type: 'caseId', description: 'WD-001' },
      { type: 'module', description: '客户端出金' },
      { type: 'priority', description: 'P0' },
      { type: 'type', description: 'Validation / Non-mutation' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ baseURL, page, business }, testInfo) => {
    if (!baseURL) throw new Error('CLIENT_BASE_URL is required for Withdrawal validation.');
    const config = getWithdrawalTestConfig();
    const withdrawal = new WithdrawalPage(page);
    const postMetadata: Array<{ path: string; status: number }> = [];
    page.on('response', response => {
      if (response.request().method() === 'POST') {
        postMetadata.push({ path: new URL(response.url()).pathname, status: response.status() });
      }
    });

    business.case({
      caseId: 'WD-001',
      module: '客户端出金',
      name: '出金提交前Validation',
      description: '验证法币出金账户、币种、收款人、金额、全部、确认页和安全密钥弹窗，不点击安全密钥验证。',
      priority: 'P0',
      type: ['Validation', 'Non-mutation'],
      scope: 'Client',
      owner: 'QA',
      requirement: 'Withdrawal pre-submit validation',
      preconditions: ['客户端自动登录成功', 'Sandbox环境', '两个Mutation开关均关闭'],
      target: '确认法币出金提交前链路真实可用，并停在安全密钥验证前。',
      expectedResult: '页面校验、确认摘要和安全密钥弹窗可用；验证点击0次且不创建TXN。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: true,
      safetySwitches: ['ALLOW_MONEY_TESTS=false', 'ALLOW_ADMIN_MUTATION_TESTS=false']
    });
    business.setBusinessData({
      runId: testInfo.testId,
      accountType: config.accountType,
      withdrawalCurrency: config.currency,
      requestedAmount: config.testAmount,
      beneficiaryAccountSuffix: `****${config.beneficiaryAccountSuffix}`,
      withdrawalPurpose: config.purpose,
      confirmationClicks: 0,
      securityVerificationClicks: 0,
      dryRun: true
    });

    await business.step(
      { action: '打开法币转出并选择付款账户、币种和收款人', expected: '配置的账户、USD收款人和用途均可选择' },
      async ({ setActual, setBusinessData }) => {
        await withdrawal.goto(baseURL);
        await withdrawal.selectAccount(config.accountType);
        await withdrawal.selectCurrency(config.currencyLabel);
        expect(await withdrawal.readBeneficiaryCount()).toBeGreaterThan(0);
        await withdrawal.selectBeneficiary({
          name: config.beneficiaryName,
          accountSuffix: config.beneficiaryAccountSuffix,
          currency: config.currency
        });
        const purposes = await withdrawal.readPurposeOptions();
        expect(purposes).toContain(config.purpose);
        await withdrawal.selectPurpose(config.purpose);
        const transferMethods = await withdrawal.readTransferMethodOptions();
        expect(transferMethods).toContain(config.transferMethod);
        await withdrawal.selectTransferMethod(config.transferMethod);
        const supportingDocument = await withdrawal.uploadSupportingDocument(
          config.supportingDocumentPath
        );
        const balance = await withdrawal.readBalanceSnapshot();
        setBusinessData({
          beforeAvailableBalance: balance.availableBalance.toString(),
          beforeTotalBalance: '页面未提供',
          withdrawalTransferMethod: config.transferMethod,
          supportingDocument
        });
        setActual(`已选择${config.accountType}/${config.currency}、${config.transferMethod}及尾号${config.beneficiaryAccountSuffix}收款人；支持性文件已上传；可用余额已读取`);
      }
    );

    await business.step(
      { action: '验证空金额和0金额', expected: '空金额不能继续，0金额提示“请输入有效金额”' },
      async ({ setActual }) => {
        await withdrawal.clearAmount();
        expect(await withdrawal.continueButton.isDisabled()).toBe(true);
        await withdrawal.fillAmount('0');
        await withdrawal.continueButton.click();
        expect(await withdrawal.readVisibleValidationMessages()).toContain('请输入有效金额');
        expect(await withdrawal.confirmButton.isVisible()).toBe(false);
        setActual('空金额按钮禁用；0金额被页面明确拒绝');
      }
    );

    await business.step(
      { action: '验证全部金额、超余额和页面限额', expected: '全部金额等于可用余额；记录超余额与限额的真实页面行为' },
      async ({ setActual, setBusinessData, warn }) => {
        const balance = await withdrawal.readBalanceSnapshot();
        const allAmount = await withdrawal.useAllAvailableBalance();
        expect(new Decimal(allAmount).equals(balance.availableBalance)).toBe(true);
        const displayedLimits = await withdrawal.readDisplayedLimits();
        const overBalance = balance.availableBalance.plus('0.01').toFixed(2);
        await withdrawal.fillAmount(overBalance);
        const overBalanceConfirmation = await withdrawal.continueToConfirmation();
        await withdrawal.returnToForm();
        warn('当前页面允许超出可用余额的金额进入确认态，余额不足需在安全验证或服务端提交阶段校验。');
        setBusinessData({
          allWithdrawalAmount: allAmount,
          displayedLimits,
          overBalanceAmount: overBalance,
          overBalanceFormBehavior: '可进入确认态',
          overBalanceFeeText: overBalanceConfirmation.feeText
        });
        setActual(`全部金额=${allAmount}；页面未展示最低/最高限额；${overBalance}可进入确认态`);
      }
    );

    await business.step(
      { action: '校验有效金额确认页', expected: '账户、收款人、金额一致，并读取手续费与实际扣款' },
      async ({ setActual, setBusinessData, warn }) => {
        await withdrawal.fillAmount(config.testAmount);
        const confirmation = await withdrawal.continueToConfirmation();
        expect(confirmation.accountType).toBe(config.accountType);
        expect(confirmation.beneficiary).toBe(config.beneficiaryName);
        expect(confirmation.requestedAmountText).toContain(config.testAmount);
        if (confirmation.feeText === '-' || confirmation.actualDebitText === '-') {
          warn('当前Sandbox确认页手续费和实际扣款显示“-”，真实金额Oracle尚未形成。');
        }
        setBusinessData({
          feeAmount: confirmation.feeText,
          expectedNetAmount: '页面未显示',
          actualDebitAmount: confirmation.actualDebitText
        });
        setActual(`确认页金额一致；手续费=${confirmation.feeText}，实际扣款=${confirmation.actualDebitText}`);
      }
    );

    await business.step(
      { action: '打开安全密钥弹窗并在验证前停止', expected: '弹窗有6个输入框和验证按钮；验证点击0次且无出金提交请求' },
      async ({ setActual, setBusinessData }) => {
        await withdrawal.openSecurityKeyDialogOnce();
        const structure = await withdrawal.readSecurityKeyDomStructure();
        expect(structure.visibleInputCount).toBe(6);
        expect(structure.buttonLabels).toContain('验证');
        expect(withdrawal.confirmationClicks()).toBe(1);
        expect(withdrawal.securityVerificationClicks()).toBe(0);
        await withdrawal.closeSecurityKeyWithoutVerifying();
        const businessMutationPaths = postMetadata.filter(({ path }) =>
          /(?:confirm|create|submit).*(?:withdraw|cash)|(?:withdraw|out-cash).*(?:confirm|create|submit)/i.test(path)
        );
        expect(businessMutationPaths).toEqual([]);
        expect(postMetadata.some(({ path, status }) =>
          path.endsWith('/check-operate') && status === 200
        )).toBe(true);
        setBusinessData({
          confirmationClicks: withdrawal.confirmationClicks(),
          securityVerificationClicks: withdrawal.securityVerificationClicks(),
          securityInputCount: structure.visibleInputCount,
          safeRequestEvidence: postMetadata
            .filter(({ path }) => path.endsWith('/check-operate'))
            .map(({ path, status }) => `${path} HTTP ${status}`),
          finalStatus: 'Validation完成，未创建出金申请'
        });
        setActual('确认转账点击1次，仅打开安全密钥弹窗；安全密钥验证点击0次，无出金提交请求');
      }
    );
  }
);
