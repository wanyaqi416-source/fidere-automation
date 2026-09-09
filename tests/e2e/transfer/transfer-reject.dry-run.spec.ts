import { TransferDetailPage } from '../../../pages/admin/TransferDetailPage';
import { TransferListPage } from '../../../pages/admin/TransferListPage';
import { TransferRejectDialog } from '../../../pages/admin/TransferRejectDialog';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { TransferPage } from '../../../pages/client/TransferPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { runTransferAuthPreflight } from '../../../src/transfer/transfer-auth-preflight';
import {
  buildTransferRejectReason,
  requireUniqueAdminTransferCandidate,
  TransferExecutionGuard
} from '../../../src/transfer/transfer-e2e';
import { decimalFromText } from '../../../src/utils/money';
import {
  getTransferDryRunConfig,
  getTransferTestConfig
} from '../../client/transfer/transferTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

test(
  'TR-002资金互转审核拒绝闭环Dry Run @e2e @transfer @readonly @dry-run',
  async ({ adminPage, clientPage, business }) => {
    if (!env.client.baseUrl || !env.admin.baseUrl) {
      throw new Error('CLIENT_BASE_URL and ADMIN_BASE_URL are required for TR-002 Dry Run.');
    }

    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);

    const config = getTransferTestConfig();
    const dryRun = getTransferDryRunConfig();
    const runId = 'TR002-DRY-RUN';
    const rejectReason = buildTransferRejectReason(runId);
    const guard = new TransferExecutionGuard();
    const accountPage = new AccountDetailPage(clientPage);
    const transferPage = new TransferPage(clientPage);
    const adminList = new TransferListPage(adminPage);
    const adminDetail = new TransferDetailPage(adminPage);
    const rejectDialog = new TransferRejectDialog(adminPage);

    business.case({
      caseId: 'TR-002',
      module: '资金互转',
      name: '资金互转审核拒绝闭环（Dry Run）',
      description: '使用历史TRF和Admin TXN只读验证TR-002 Page Object、业务指纹字段及双端安全门禁。',
      priority: 'P0',
      type: ['E2E', 'Mutation', 'Money', 'Dry Run'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'Transfer rejection end-to-end dry run',
      preconditions: ['两个Mutation开关均关闭', 'Client/Admin认证有效', '存在历史Transfer数据'],
      target: '在不创建TRF、不验证安全密钥、不拒绝Admin记录的前提下验证完整读取链路。',
      expectedResult: 'Client余额和TRF可读，Admin历史候选唯一且详情可读，拒绝入口存在但不点击。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: false,
      safetySwitches: ['ALLOW_MONEY_TESTS=false', 'ALLOW_ADMIN_MUTATION_TESTS=false']
    });
    business.setBusinessData({
      runId,
      dryRun: true,
      transferDirection: dryRun.direction,
      transferCurrency: config.currency,
      transferAmount: dryRun.amount,
      rejectReason,
      candidateCount: 0,
      confirmed: false
    });

    await business.step(
      { action: '执行双端认证与关闭状态门禁', expected: '两端认证有效，两个Mutation开关保持关闭' },
      async ({ setActual }) => {
        await runTransferAuthPreflight({
          clientPage,
          adminPage,
          clientBaseUrl: env.client.baseUrl!,
          adminBaseUrl: env.admin.baseUrl!,
          guard
        });
        expect(() =>
          guard.assertClientSubmissionAllowed(
            env.exchange.allowMoneyTests,
            env.allowAdminMutationTests
          )
        ).toThrow('ALLOW_MONEY_TESTS is false');
        setActual('Client/Admin认证有效；资金与Admin Mutation开关均为false');
      }
    );

    await business.step(
      { action: '读取Client法域账户余额', expected: '按香港账户和USD唯一读取当前可用余额' },
      async ({ setActual, setBusinessData }) => {
        await accountPage.goto(env.client.baseUrl!);
        const balance = await accountPage.readAvailableBalance(
          config.sourceAccountType,
          config.currency
        );
        setBusinessData({
          jurisdictionBalanceBefore: balance.availableBalance.toString(),
          brokerBalanceOracle: '券商账户当前无余额查询能力'
        });
        setActual('Client账户页已按账户类型和币种读取法域账户可用余额');
      }
    );

    const clientRecord = await business.step(
      { action: '按业务字段读取历史Client TRF', expected: '不取第一条/最新一条，历史指纹候选恰好1条' },
      async ({ setActual, setBusinessData }) => {
        await transferPage.gotoBrokerageDetail(
          env.client.baseUrl!,
          config.brokerName,
          config.brokerAccountId
        );
        const records = await transferPage.readHistoryRecords();
        const candidates = records.filter(record =>
          record.direction === dryRun.direction &&
          record.sourceAccountType === config.sourceAccountType &&
          record.targetAccountType === config.brokerName &&
          record.currency === config.currency &&
          decimalFromText(record.transferAmount, 'Client transfer amount').equals(
            decimalFromText(dryRun.amount, 'configured Dry Run amount')
          ) &&
          record.status === dryRun.clientStatus
        );
        expect(candidates).toHaveLength(1);
        const record = candidates[0];
        expect(record.clientTransferId).toMatch(/^TRF-/);
        await transferPage.readHistoryRecord(record.clientTransferId);
        await transferPage.openHistoryDetailsIfAvailable(record.clientTransferId);
        setBusinessData({
          clientTransferId: record.clientTransferId,
          fee: record.fee,
          expectedReceivedAmount: record.receivedAmount,
          finalStatus: record.status
        });
        setActual('已通过方向、账户、币种、金额和状态唯一读取历史TRF');
        return record;
      }
    );

    const adminRecord = await business.step(
      { action: '读取Admin资金互转列表并形成历史候选', expected: '读取TXN及全部业务指纹字段，候选恰好1条' },
      async ({ setActual, setBusinessData }) => {
        await adminList.goto(env.admin.baseUrl!);
        await adminList.applySupportedFilters({
          status: dryRun.adminStatus,
          direction: dryRun.direction,
          userKeyword: config.adminUserIdentity
        });
        const records = await adminList.readAllFilteredRecords();
        const clientDate = clientRecord.dateText.match(/\d{4}-\d{2}-\d{2}/)?.[0];
        const candidates = records.filter(record =>
          normalized(record.userIdentity).includes(normalized(config.adminUserIdentity)) &&
          normalized(record.sourceAccountType).includes(normalized(config.sourceAccountType)) &&
          normalized(record.targetAccountType).includes(normalized(config.brokerName)) &&
          record.currency === config.currency &&
          decimalFromText(record.amount, 'Admin transfer amount').equals(
            decimalFromText(dryRun.amount, 'configured Dry Run amount')
          ) &&
          normalized(record.status).includes(normalized(dryRun.adminStatus)) &&
          (!clientDate || record.createdAtText.includes(clientDate))
        );
        const unique = requireUniqueAdminTransferCandidate(candidates);
        setBusinessData({
          candidateCount: candidates.length,
          adminTransactionId: unique.adminTransactionId,
          fingerprintFields: [
            '测试用户',
            '转出账户',
            '转入账户',
            '币种',
            '精确金额',
            '创建日期',
            '状态'
          ]
        });
        setActual('Admin列表已读取独立TXN和完整业务字段；历史候选数为1');
        return unique;
      }
    );

    await business.step(
      { action: '打开Admin Transfer详情并二次核对', expected: '详情TXN、账户、币种、金额和状态与列表一致' },
      async ({ setActual, setBusinessData }) => {
        await adminDetail.openFromList(adminList, adminRecord.adminTransactionId);
        const detail = await adminDetail.readDetail();
        expect(detail.adminTransactionId).toBe(adminRecord.adminTransactionId);
        expect(normalized(detail.userIdentity)).toContain(
          normalized(config.adminUserIdentity)
        );
        expect(normalized(detail.sourceAccountType)).toContain(
          normalized(adminRecord.sourceAccountType)
        );
        expect(normalized(detail.targetAccountType)).toContain(
          normalized(adminRecord.targetAccountType)
        );
        expect(detail.currency).toBe(adminRecord.currency);
        expect(
          decimalFromText(detail.amount, 'Admin detail amount').equals(
            decimalFromText(adminRecord.amount, 'Admin list amount')
          )
        ).toBe(true);
        expect(normalized(detail.status)).toContain(normalized(adminRecord.status));
        setBusinessData({ adminTransactionId: detail.adminTransactionId });
        setActual('Admin详情已完成列表字段二次核对');
      }
    );

    await business.step(
      {
        action: '验证Admin拒绝能力保持只读',
        expected: '按完整历史指纹唯一定位一条待审核记录，确认拒绝入口存在但不点击'
      },
      async ({ setActual, setBusinessData }) => {
        await adminDetail.close();
        const records = await adminList.readAllFilteredRecords();
        const candidates = records.filter(record =>
          normalized(record.userIdentity).includes(normalized(config.adminUserIdentity)) &&
          normalized(record.sourceAccountType).includes(normalized(config.brokerName)) &&
          normalized(record.targetAccountType).includes(normalized(config.sourceAccountType)) &&
          record.currency === config.currency &&
          decimalFromText(record.amount, 'Admin reject-action amount').equals(
            decimalFromText(config.uniqueAmountBase, 'configured unique amount base')
          ) &&
          normalized(record.status).includes(normalized('待审核'))
        );
        const unique = requireUniqueAdminTransferCandidate(candidates);
        await adminDetail.openFromList(adminList, unique.adminTransactionId);
        await rejectDialog.open(adminDetail);
        expect(await rejectDialog.readConfirmationSummary()).toContain('审核备注');
        expect(rejectDialog.wasConfirmed()).toBe(false);
        setBusinessData({
          rejectActionAvailable: true,
          rejectReasonFieldAvailable: true,
          finalStatus: 'Dry Run完成，未创建TRF且未执行Admin拒绝'
        });
        setActual('已唯一定位待审核记录，审核备注和最终拒绝入口均可见；拒绝按钮点击次数为0');
      }
    );
  }
);
