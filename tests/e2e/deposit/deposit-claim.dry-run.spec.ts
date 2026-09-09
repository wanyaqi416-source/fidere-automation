import { DepositClaimListPage } from '../../../pages/admin/DepositClaimListPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { DepositPage } from '../../../pages/client/DepositPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { runDepositAuthPreflight } from '../../../src/deposit/deposit-auth-preflight';
import {
  DepositExecutionGuard,
  deriveUniqueDepositAmount
} from '../../../src/deposit/deposit-e2e';
import { Decimal } from '../../../src/utils/money';
import { getDepositTestConfig } from '../../client/deposit/depositTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'DP-003 香港账户USD入金认领成功闭环Dry Run',
  {
    tag: ['@e2e', '@deposit', '@readonly', '@dry-run'],
    annotation: [
      { type: 'caseId', description: 'DP-003-DRY-RUN' },
      { type: 'module', description: '入金' },
      { type: 'priority', description: 'P0' },
      { type: 'scope', description: 'Client + Admin' },
      { type: 'type', description: 'Dry Run / Read-only' }
    ]
  },
  async ({ adminPage, clientPage, business }, testInfo) => {
    test.setTimeout(120_000);
    if (!env.client.baseUrl || !env.admin.baseUrl) {
      throw new Error('CLIENT_BASE_URL and ADMIN_BASE_URL are required for DP-003 Dry Run.');
    }
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);
    expect(testInfo.config.workers).toBe(1);
    expect(testInfo.project.retries).toBe(0);
    expect(testInfo.project.repeatEach).toBe(1);

    const config = getDepositTestConfig();
    expect(config.accountType).toBe('香港账户');
    expect(config.currency).toBe('USD');
    expect(config.currencyLabel).toBe('美元');

    const runId = `DP003-DRY-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
    const amount = deriveUniqueDepositAmount(
      runId,
      config.uniqueAmountBase,
      config.amountPrecision
    );
    const displayedAmount = amount.toFixed(config.amountPrecision);
    const guard = new DepositExecutionGuard();
    const accountPage = new AccountDetailPage(clientPage);
    const depositPage = new DepositPage(clientPage);
    const adminList = new DepositClaimListPage(adminPage);

    business.case({
      caseId: 'DP-003-DRY-RUN',
      module: 'Client + Admin入金',
      name: '香港账户USD入金认领成功闭环Dry Run',
      description: '只读验证USD余额、Client入金表单和Admin USD历史解析，不提交申请、不认领、不改变余额。',
      priority: 'P0',
      type: ['Dry Run', 'Read-only'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'DP-003 USD readiness',
      preconditions: ['Client/Admin认证有效', '两个Mutation安全开关均关闭'],
      target: '确认DP-003所有配置与只读Oracle已统一为香港账户USD。',
      expectedResult: 'USD余额稳定可读、Client与Admin均支持USD、两位小数表单有效且无写操作。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: false,
      safetySwitches: ['ALLOW_MONEY_TESTS=false', 'ALLOW_ADMIN_MUTATION_TESTS=false']
    });
    business.setBusinessData({
      runId,
      accountType: config.accountType,
      depositCurrency: config.currency,
      depositAmount: displayedAmount,
      amountPrecision: config.amountPrecision,
      confirmationClicks: 0,
      claimConfirmationClicks: 0,
      candidateCount: 0,
      dryRun: true,
      confirmed: false
    });

    await business.step(
      {
        action: '1. 执行Client/Admin认证和安全开关预检',
        expected: '两端业务页面可访问，两个Mutation开关保持关闭'
      },
      async ({ setActual }) => {
        await runDepositAuthPreflight({
          clientPage,
          adminPage,
          clientBaseUrl: env.client.baseUrl!,
          adminBaseUrl: env.admin.baseUrl!,
          guard
        });
        expect(() => guard.assertClientSubmissionAllowed(false, false)).toThrow();
        setActual('Client与Admin认证有效；Client提交和Admin处理均被安全开关阻断');
      }
    );

    const balanceBefore = await business.step(
      {
        action: '2. 使用公共余额组件读取香港账户USD余额',
        expected: 'AccountBalanceReader按账户和币种唯一返回USD可用余额'
      },
      async ({ setActual, setBusinessData }) => {
        await accountPage.goto(env.client.baseUrl!);
        const balance = await accountPage.readBalance({
          accountType: config.accountType,
          currency: config.currency
        });
        setBusinessData({ depositBalanceBefore: balance.availableBalance.toString() });
        setActual('香港账户USD余额已由Transfer与Deposit共享的账户余额组件唯一读取');
        return balance.availableBalance;
      }
    );

    await business.step(
      {
        action: '3. 验证Client银行电汇入金支持香港账户USD和两位小数',
        expected: '香港账户选项包含美元，11.xx USD表单校验通过但不点击提交'
      },
      async ({ setActual }) => {
        await depositPage.goto(env.client.baseUrl!);
        const matrix = await depositPage.readAccountCurrencyMatrix();
        expect(matrix[config.accountType]).toContain(config.currencyLabel);
        await depositPage.selectAccount(config.accountType);
        await depositPage.selectCurrency(config.currencyLabel);
        await depositPage.selectFirstPayingBank();
        await depositPage.fillAmount(displayedAmount);
        await depositPage.selectChannel(config.channel);
        await depositPage.selectPurpose(config.purpose);
        await depositPage.selectSourceOfFunds(config.sourceOfFunds);
        const snapshot = await depositPage.readFormSnapshot();
        expect(snapshot.accountType).toContain(config.accountType);
        expect(snapshot.currencyLabel).toContain(config.currencyLabel);
        expect(new Decimal(snapshot.amount).equals(amount)).toBe(true);
        expect(snapshot.submitEnabled).toBe(true);
        expect(depositPage.submissionClicks()).toBe(0);
        setActual(`Client支持香港账户USD；${displayedAmount} USD两位小数表单有效，提交点击0次`);
      }
    );

    await business.step(
      {
        action: '4. 验证Admin入账认领列表USD字段解析',
        expected: '历史列表存在可标准化的USD记录，申请金额与实际金额均可用Decimal读取'
      },
      async ({ setActual, setBusinessData }) => {
        await adminList.goto(env.admin.baseUrl!);
        await adminList.applyFilters({ matchStatus: '已匹配' });
        const usdRecords = (await adminList.readAllFilteredRecords(5))
          .filter(record => record.currency === config.currency);
        expect(usdRecords.length).toBeGreaterThan(0);
        expect(usdRecords.every(record =>
          new Decimal(record.requestedAmount).isFinite() &&
          new Decimal(record.actualAmount).isFinite()
        )).toBe(true);
        setBusinessData({ clientRecordCandidateCount: usdRecords.length });
        setActual(`Admin历史列表已安全解析${usdRecords.length}条USD记录；未打开或处理任何申请`);
      }
    );

    await business.step(
      {
        action: '5. 复核余额与零写操作',
        expected: '香港账户USD余额不变，Client提交0次、Admin认领0次'
      },
      async ({ setActual, setBusinessData }) => {
        await accountPage.goto(env.client.baseUrl!);
        const balanceAfter = await accountPage.readBalance({
          accountType: config.accountType,
          currency: config.currency
        });
        expect(balanceAfter.availableBalance.equals(balanceBefore)).toBe(true);
        expect(depositPage.submissionClicks()).toBe(0);
        setBusinessData({
          depositBalanceAfter: balanceAfter.availableBalance.toString(),
          finalStatus: 'Dry Run通过，无资金写操作'
        });
        setActual('USD余额前后一致；Client提交0次，Admin认领0次，未创建入金申请');
      }
    );
  }
);
