import { TransferDetailPage } from '../../../pages/admin/TransferDetailPage';
import { TransferListPage } from '../../../pages/admin/TransferListPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import {
  adminTransferIdPattern,
  diagnoseAdminTransferCandidates,
  matchesAdminCustomerIdentity,
  requireUniqueAdminTransferCandidate,
  transferAccountsMatch
} from '../../../src/transfer/transfer-e2e';
import { Decimal } from '../../../src/utils/money';
import {
  getTransferReconciliationConfig,
  getTransferTestConfig
} from '../../client/transfer/transferTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'TR-003现有待审核记录Admin候选只读复核 @e2e @transfer @readonly @reconciliation',
  async ({ adminPage, business }, testInfo) => {
    if (!env.admin.baseUrl) {
      throw new Error('ADMIN_BASE_URL is required for the Transfer candidate reconciliation.');
    }

    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);
    expect(testInfo.config.workers).toBe(1);
    expect(testInfo.project.retries).toBe(0);
    expect(testInfo.project.repeatEach).toBe(1);

    const transferConfig = getTransferTestConfig();
    const expected = getTransferReconciliationConfig();
    const adminList = new TransferListPage(adminPage);
    const adminDetail = new TransferDetailPage(adminPage);

    business.case({
      caseId: 'TR-003-RECON',
      module: '资金互转',
      name: '现有80.02 USD待审核记录Admin候选只读复核',
      description: '逐层验证Admin资金互转列表标准化、候选唯一性和详情字段，不执行审批或拒绝。',
      priority: 'P0',
      type: ['E2E', 'Readonly', 'Reconciliation'],
      scope: 'Admin',
      owner: 'QA',
      requirement: 'TR-003 existing Admin candidate reconciliation',
      preconditions: ['现有TR-003申请仍为待审核', '两个资金写入开关均为false'],
      target: '安全定位并打开现有80.02 USD资金互转记录。',
      expectedResult: '逐层候选最终恰好为1，列表和详情金额、方向、状态一致。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: false,
      safetySwitches: ['ALLOW_MONEY_TESTS=false', 'ALLOW_ADMIN_MUTATION_TESTS=false']
    });
    business.setBusinessData({
      transferDirection: `${expected.sourceAccount} -> ${expected.targetAccount}`,
      transferCurrency: expected.currency,
      transferAmount: expected.requestedAmount,
      displayedFee: expected.feeAmount,
      displayedExpectedReceivedAmount: expected.netAmount,
      timeWindowApplied: false,
      customerMatchStrategy: 'Admin客户复合单元格中的已配置测试账号唯一标识（原始值不输出）',
      approved: false
    });

    const candidate = await business.step(
      {
        action: '1. 读取Admin资金互转列表并逐层应用业务指纹',
        expected: '金额独立标准化，列表阶段不使用时间窗口，最终候选数严格为1'
      },
      async ({ setActual, setBusinessData }) => {
        await adminPage.goto(
          new URL('/zh-CN/operation/fiatAssets', env.admin.baseUrl!).toString(),
          { waitUntil: 'domcontentloaded' }
        );
        if (/\/login|\/signin|\/sign-in/i.test(adminPage.url())) {
          throw new Error('Admin storageState is expired. Run npm run auth:admin.');
        }
        await adminList.goto(env.admin.baseUrl!);
        const records = await adminList.readAllFilteredRecords();
        const diagnostics = diagnoseAdminTransferCandidates(records, {
          recordType: expected.recordType,
          userIdentity: transferConfig.adminUserIdentity,
          sourceAccountType: expected.sourceAccount,
          targetAccountType: expected.targetAccount,
          currency: expected.currency,
          requestedAmount: expected.requestedAmount,
          status: expected.status
        });
        const unique = requireUniqueAdminTransferCandidate(diagnostics.candidates);

        expect(new Decimal(unique.feeAmount).equals(expected.feeAmount)).toBe(true);
        expect(new Decimal(unique.netAmount).equals(expected.netAmount)).toBe(true);
        expect(adminTransferIdPattern.test(unique.adminTransactionId)).toBe(true);

        setBusinessData({
          candidateCount: diagnostics.candidates.length,
          candidateStageCounts: diagnostics.counts,
          adminTransactionId: unique.adminTransactionId,
          normalizedAdminTransfer: {
            recordType: unique.recordType,
            customerText: '[已匹配测试用户，原始客户信息不输出]',
            sourceAccount: unique.sourceAccountType,
            targetAccount: unique.targetAccountType,
            currency: unique.currency,
            requestedAmount: unique.requestedAmount,
            feeAmount: unique.feeAmount,
            netAmount: unique.netAmount,
            status: unique.status,
            adminTransactionId: unique.adminTransactionId
          }
        });
        setActual(
          `逐层候选数：记录类型=${diagnostics.counts.recordType}，转出账户=${diagnostics.counts.sourceAccount}，转入账户=${diagnostics.counts.targetAccount}，币种=${diagnostics.counts.currency}，金额=${diagnostics.counts.requestedAmount}，状态=${diagnostics.counts.status}，测试用户=${diagnostics.counts.user}；最终候选=1`
        );
        return unique;
      }
    );

    await business.step(
      {
        action: '2. 打开唯一候选详情并二次核对字段',
        expected: 'TXN、测试用户、方向、USD、80.02、40.00、40.02和待审核全部一致'
      },
      async ({ setActual, setBusinessData }) => {
        await adminDetail.openFromList(adminList, candidate.adminTransactionId);
        const detail = await adminDetail.readDetail();

        expect(detail.adminTransactionId).toBe(candidate.adminTransactionId);
        expect(detail.recordType).toBe(expected.recordType);
        expect(matchesAdminCustomerIdentity(
          detail.userIdentity,
          transferConfig.adminUserIdentity
        )).toBe(true);
        expect(transferAccountsMatch(detail.sourceAccountType, expected.sourceAccount)).toBe(true);
        expect(transferAccountsMatch(detail.targetAccountType, expected.targetAccount)).toBe(true);
        expect(detail.currency).toBe(expected.currency);
        expect(new Decimal(detail.amount).equals(expected.requestedAmount)).toBe(true);
        expect(detail.fee && new Decimal(detail.fee).equals(expected.feeAmount)).toBe(true);
        expect(
          detail.receivedAmount && new Decimal(detail.receivedAmount).equals(expected.netAmount)
        ).toBe(true);
        expect(detail.status).toBe(expected.status);

        setBusinessData({
          adminTransactionId: detail.adminTransactionId,
          detailVerified: true,
          approved: false
        });
        setActual('已打开唯一TXN详情；用户、方向、币种、三项金额和待审核状态全部一致；未点击批准或拒绝');
      }
    );
  }
);
