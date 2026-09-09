import { TransferApprovalReview } from '../../../pages/admin/TransferApprovalReview';
import { TransferDetailPage } from '../../../pages/admin/TransferDetailPage';
import { TransferListPage } from '../../../pages/admin/TransferListPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { HomePage } from '../../../pages/client/HomePage';
import {
  TransactionsPage,
  type TransferLedgerRecord
} from '../../../pages/client/TransactionsPage';
import { TransferPage, type ClientTransferRecord } from '../../../pages/client/TransferPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import {
  adminTransferIdPattern,
  buildTransferApprovalRemark,
  diagnoseAdminTransferCandidates,
  expectedJurisdictionBalanceAfterApproval,
  matchesAdminCustomerIdentity,
  requireUniqueAdminTransferCandidate,
  transferAccountsMatch,
  TransferExecutionGuard
} from '../../../src/transfer/transfer-e2e';
import { assertClientTestEnvironment } from '../../../src/utils/clientSafety';
import { Decimal, decimalFromText } from '../../../src/utils/money';
import {
  getTransferReconciliationConfig,
  getTransferTestConfig
} from '../../client/transfer/transferTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });
test.skip(
  !env.exchange.allowMoneyTests || !env.allowAdminMutationTests,
  'TR-003 Resume默认禁用；必须在单次进程中显式开启两个Mutation安全开关。'
);

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

test(
  '续跑现有TR-003并完成Admin审核与Client验证',
  {
    tag: ['@e2e', '@transfer', '@mutation', '@money', '@resume'],
    annotation: [
      { type: 'caseId', description: 'TR-003' },
      { type: 'module', description: '资金互转' },
      { type: 'priority', description: 'P0' },
      { type: 'scope', description: 'Client + Admin' },
      { type: 'type', description: 'E2E / Mutation / Money / Resume' }
    ]
  },
  async ({ adminPage, clientPage, business }, testInfo) => {
    if (!env.client.baseUrl || !env.admin.baseUrl) {
      throw new Error('CLIENT_BASE_URL and ADMIN_BASE_URL are required for TR-003 Resume.');
    }

    assertClientTestEnvironment(env.client.baseUrl);
    expect(new URL(env.admin.baseUrl).hostname).toContain('sandbox');
    expect(testInfo.config.workers).toBe(1);
    expect(testInfo.project.retries).toBe(0);
    expect(testInfo.project.repeatEach).toBe(1);
    expect(testInfo.retry).toBe(0);
    expect(testInfo.repeatEachIndex).toBe(0);
    expect(env.exchange.allowMoneyTests).toBe(true);
    expect(env.allowAdminMutationTests).toBe(true);

    const config = getTransferTestConfig();
    const existing = getTransferReconciliationConfig();
    const amount = new Decimal(existing.requestedAmount);
    const fee = new Decimal(existing.feeAmount);
    const netAmount = new Decimal(existing.netAmount);
    const baselineBalance = new Decimal(existing.sourceBalanceBefore);
    const expectedFinalBalance = expectedJurisdictionBalanceAfterApproval(
      baselineBalance,
      amount
    );
    const runId = `TR003-RESUME-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
    const approvalRemark = buildTransferApprovalRemark(runId);
    const guard = new TransferExecutionGuard();
    const homePage = new HomePage(clientPage);
    const accountPage = new AccountDetailPage(clientPage);
    const transferPage = new TransferPage(clientPage);
    const transactionsPage = new TransactionsPage(clientPage);
    const adminList = new TransferListPage(adminPage);
    const adminDetail = new TransferDetailPage(adminPage);
    const approvalReview = new TransferApprovalReview(adminPage);

    business.case({
      caseId: 'TR-003',
      module: '资金互转',
      name: '续跑现有TR-003：Admin审核通过与Client终态验证',
      description: '复用已存在的80.02 USD TRF，仅执行Admin批准及Client终态、余额和流水验证。',
      priority: 'P0',
      type: ['E2E', 'Mutation', 'Money', 'Resume'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'Resume existing TR-003 without creating another Transfer',
      preconditions: ['现有TRF待审核', 'Client/Admin认证有效', 'Sandbox', '两个进程安全开关开启'],
      target: '只批准现有唯一Admin TXN，并验证原TRF、香港账户余额和Client资金流水。',
      expectedResult: 'Admin已批准、原TRF已完成、源余额减少80.02 USD并生成唯一Client TXN。',
      changesData: true,
      affectsMoney: true,
      dependsOnAdmin: true,
      dependsOnThirdParty: false,
      safetySwitches: ['ALLOW_MONEY_TESTS', 'ALLOW_ADMIN_MUTATION_TESTS']
    });
    business.setBusinessData({
      runId,
      existingTransferResume: true,
      transferDirection: `${existing.sourceAccount} -> ${existing.targetAccount}`,
      transferCurrency: existing.currency,
      transferAmount: amount.toString(),
      fee: fee.toString(),
      actualReceivedAmount: netAmount.toString(),
      jurisdictionBalanceBefore: baselineBalance.toString(),
      targetBrokerBalanceOracle: '券商目标账户当前无余额查询能力',
      approvalRemark,
      candidateCount: 0,
      approvalClickCount: 0,
      secondaryConfirmationClickCount: 0,
      confirmed: false,
      noNewTransferCreated: true
    });

    await business.step(
      {
        action: '1. 执行Sandbox、双端认证和续跑安全门禁',
        expected: 'Admin和Client真实业务路由有效，两个开关开启，未进入Client提交表单'
      },
      async ({ setActual }) => {
        await adminPage.goto(
          new URL('/zh-CN/operation/fiatAssets', env.admin.baseUrl!).toString(),
          { waitUntil: 'domcontentloaded' }
        );
        if (/\/login|\/signin|\/sign-in/i.test(adminPage.url())) {
          throw new Error('Admin storageState is expired. Run npm run auth:admin.');
        }
        await adminList.goto(env.admin.baseUrl!);

        await homePage.gotoDashboard(env.client.baseUrl!);
        await homePage.expectNoLoginRedirect();
        await homePage.expectDashboardLoaded();
        await homePage.expectNoObviousError();
        guard.markAuthenticationReady(true, true);
        setActual('Sandbox及双端认证有效；本用例仅续跑现有申请，不进入Client提交表单');
      }
    );

    const clientRecord = await business.step(
      {
        action: '2. 唯一定位Client原TRF并读取审核前余额',
        expected: '按方向、币种、三项金额和处理中状态找到唯一原TRF，且读取香港账户USD当前余额'
      },
      async ({ setActual, setBusinessData }) => {
        await transferPage.gotoBrokerageDetail(
          env.client.baseUrl!,
          config.brokerName,
          config.brokerAccountId
        );
        const candidates = (await transferPage.readHistoryRecords()).filter(record =>
          record.direction === existing.recordType &&
          transferAccountsMatch(record.sourceAccountType, existing.sourceAccount) &&
          transferAccountsMatch(record.targetAccountType, existing.targetAccount) &&
          record.currency === existing.currency &&
          decimalFromText(record.transferAmount, 'existing Client Transfer amount').equals(amount) &&
          decimalFromText(record.fee, 'existing Client Transfer fee').equals(fee) &&
          decimalFromText(record.receivedAmount, 'existing Client Transfer net amount').equals(netAmount) &&
          /处理中|待审核/.test(record.status)
        );
        expect(candidates).toHaveLength(1);
        const record = candidates[0];
        guard.recordExistingClientSubmission(record.clientTransferId);

        await accountPage.goto(env.client.baseUrl!);
        const currentBalance = await accountPage.readAvailableBalance(
          existing.sourceAccount,
          existing.currency
        );
        setBusinessData({
          clientTransferId: record.clientTransferId,
          clientRecordCandidateCount: candidates.length,
          submittedStatus: record.status,
          jurisdictionBalanceCurrent: currentBalance.availableBalance.toString()
        });
        setActual('原TRF候选数为1，审核前状态为处理中；已读取香港账户USD当前余额');
        return record;
      }
    );
    const transferIdsBefore = new Set(
      (await transferPage.gotoBrokerageDetail(
        env.client.baseUrl!,
        config.brokerName,
        config.brokerAccountId
      ).then(() => transferPage.readHistoryRecords())).map(record => record.clientTransferId)
    );

    const adminRecord = await business.step(
      {
        action: '3. 唯一定位Admin候选并二次核对详情',
        expected: 'candidateCount=1，TXN、测试用户、方向、USD、80.02、40.00、40.02和待审核全部一致'
      },
      async ({ setActual, setBusinessData }) => {
        await adminPage.goto(
          new URL('/zh-CN/operation/fiatAssets', env.admin.baseUrl!).toString(),
          { waitUntil: 'domcontentloaded' }
        );
        await adminList.goto(env.admin.baseUrl!);
        const diagnostics = diagnoseAdminTransferCandidates(
          await adminList.readAllFilteredRecords(),
          {
            recordType: existing.recordType,
            userIdentity: config.adminUserIdentity,
            sourceAccountType: existing.sourceAccount,
            targetAccountType: existing.targetAccount,
            currency: existing.currency,
            requestedAmount: existing.requestedAmount,
            status: existing.status
          }
        );
        const unique = requireUniqueAdminTransferCandidate(diagnostics.candidates);
        guard.recordUniqueAdminCandidate(diagnostics.candidates.length);
        expect(new Decimal(unique.feeAmount).equals(fee)).toBe(true);
        expect(new Decimal(unique.netAmount).equals(netAmount)).toBe(true);

        await adminDetail.openFromList(adminList, unique.adminTransactionId);
        const detail = await adminDetail.readDetail();
        expect(detail.adminTransactionId).toBe(unique.adminTransactionId);
        expect(detail.recordType).toBe(existing.recordType);
        expect(matchesAdminCustomerIdentity(detail.userIdentity, config.adminUserIdentity)).toBe(true);
        expect(transferAccountsMatch(detail.sourceAccountType, existing.sourceAccount)).toBe(true);
        expect(transferAccountsMatch(detail.targetAccountType, existing.targetAccount)).toBe(true);
        expect(detail.currency).toBe(existing.currency);
        expect(new Decimal(detail.amount).equals(amount)).toBe(true);
        expect(detail.fee && new Decimal(detail.fee).equals(fee)).toBe(true);
        expect(detail.receivedAmount && new Decimal(detail.receivedAmount).equals(netAmount)).toBe(true);
        expect(detail.status).toBe(existing.status);
        expect(adminTransferIdPattern.test(detail.adminTransactionId)).toBe(true);

        await approvalReview.open(adminDetail);
        setBusinessData({
          candidateCount: diagnostics.candidates.length,
          candidateStageCounts: diagnostics.counts,
          adminTransactionId: detail.adminTransactionId,
          adminStatusBefore: detail.status,
          detailVerified: true
        });
        setActual('Admin候选数严格为1，详情全部匹配，批准入口已就绪但尚未点击');
        return detail;
      }
    );

    try {
      await business.step(
        {
          action: '4. 单次批准现有Admin TXN',
          expected: '最终批准最多点击一次；如存在二次确认则只确认一次'
        },
        async context => {
          guard.assertAdminReviewAllowed();
          await approvalReview.fillRemark(approvalRemark);
          expect(await approvalReview.readRemarkValue()).toBe(approvalRemark);
          context.markPotentiallySubmitted();
          context.disallowSafeRerun();
          await approvalReview.confirmApproveOnce(
            env.exchange.allowMoneyTests,
            env.allowAdminMutationTests
          );
          expect(approvalReview.approvalClickCount()).toBe(1);
          expect(approvalReview.secondaryConfirmationClickCount()).toBeLessThanOrEqual(1);
          context.setBusinessData({
            approvalClickCount: approvalReview.approvalClickCount(),
            secondaryConfirmationClickCount:
              approvalReview.secondaryConfirmationClickCount()
          });
          context.setActual('现有Admin TXN已执行一次批准；未创建或重新提交Client Transfer');
        }
      );

      const approvedAdminRecord = await business.step(
        {
          action: '5. 等待Admin原TXN进入成功终态',
          expected: '不重复点击批准，原Admin TXN进入已批准或已完成'
        },
        async ({ setActual, setBusinessData }) => {
          const record = await adminList.waitForRecordStatus(
            adminRecord.adminTransactionId,
            /已批准|已完成/
          );
          setBusinessData({ adminStatusAfter: record.status, adminFinalStatus: record.status });
          setActual(`原Admin TXN最终状态为${record.status}`);
          return record;
        }
      );

      const completedClientRecord = await business.step(
        {
          action: '6. 根据原TRF等待Client成功终态',
          expected: '原TRF编号不变，方向、USD和80.02不变，状态进入已完成'
        },
        async ({ setActual, setBusinessData }) => {
          await transferPage.gotoBrokerageDetail(
            env.client.baseUrl!,
            config.brokerName,
            config.brokerAccountId
          );
          const record = await transferPage.waitForHistoryStatus(
            clientRecord.clientTransferId,
            /已完成|完成/
          );
          expect(record.clientTransferId).toBe(clientRecord.clientTransferId);
          expect(record.direction).toBe(existing.recordType);
          expect(transferAccountsMatch(record.sourceAccountType, existing.sourceAccount)).toBe(true);
          expect(transferAccountsMatch(record.targetAccountType, existing.targetAccount)).toBe(true);
          expect(record.currency).toBe(existing.currency);
          expect(decimalFromText(record.transferAmount, 'completed Transfer amount').equals(amount)).toBe(true);
          setBusinessData({ clientFinalStatus: record.status, terminalState: true });
          setActual(`Client原TRF最终状态为${record.status}`);
          return record;
        }
      );

      const afterBalance = await business.step(
        {
          action: '7. 使用原始baseline验证香港账户USD最终余额',
          expected: `最终余额等于原始操作前余额减去${amount.toString()} USD`
        },
        async ({ setActual, setBusinessData }) => {
          await accountPage.goto(env.client.baseUrl!);
          const balance = await accountPage.readAvailableBalance(
            existing.sourceAccount,
            existing.currency
          );
          expect(balance.availableBalance.equals(expectedFinalBalance)).toBe(true);
          setBusinessData({
            jurisdictionBalanceAfter: balance.availableBalance.toString(),
            actualSourceBalanceDecrease:
              baselineBalance.minus(balance.availableBalance).toString()
          });
          setActual('香港账户USD最终余额符合“转账金额为总扣减金额”的已确认规则');
          return balance.availableBalance;
        }
      );

      const ledgerRecord = await business.step(
        {
          action: '8. 唯一定位Client资金流水并读取TXN',
          expected: '按原TRF或方向、日期、USD、金额和成功状态定位唯一转账流水'
        },
        async ({ setActual, setBusinessData }) => {
          const occurredOn = clientRecord.dateText.match(/\d{4}-\d{2}-\d{2}/)?.[0];
          let matches: TransferLedgerRecord[] = [];

          await expect
            .poll(async () => {
              await transactionsPage.goto(env.client.baseUrl!);
              await transactionsPage.selectTransferType();
              await transactionsPage.searchByBusinessId(clientRecord.clientTransferId);
              const byTrf = (await transactionsPage.readVisibleTransferRecords()).filter(
                record => record.clientTransferId === clientRecord.clientTransferId
              );
              if (byTrf.length > 0) {
                matches = byTrf;
                return matches.length;
              }

              await transactionsPage.searchByBusinessId('');
              matches = await transactionsPage.findTransferRecords({
                currency: existing.currency,
                transferAmount: amount.toString(),
                receivedAmount: completedClientRecord.receivedAmount,
                status: /已完成|成功|已批准/,
                occurredOn,
                sourceAccountType: existing.sourceAccount,
                targetAccountType: existing.targetAccount
              });
              return matches.length;
            }, {
              message: '等待Client交易流水出现本次唯一Transfer TXN',
              timeout: 30_000
            })
            .toBe(1);

          const record = matches[0];
          expect(record.ledgerTransactionId).toMatch(/^TXN-/);
          expect(record.currencies).toContain(existing.currency);
          expect(record.status ?? record.rowText).toMatch(/已完成|成功|已批准/);
          expect(normalized(record.rowText)).toContain(normalized(existing.sourceAccount));
          expect(normalized(record.rowText)).toContain(normalized(existing.targetAccount));
          setBusinessData({
            clientGlobalLedgerRecordCount: matches.length,
            clientLedgerTransactionId: record.ledgerTransactionId,
            clientLedgerStatus: record.status ?? '成功终态',
            clientGlobalLedgerTransactionIds: [record.ledgerTransactionId]
          });
          setActual('已唯一定位Client转账流水并读取TXN，方向、币种、金额和状态正确');
          return record;
        }
      );

      await business.step(
        {
          action: '9. 确认未创建第二条Transfer并完成闭环',
          expected: 'Client历史TRF集合不变，审批点击一次，业务Oracle全部通过'
        },
        async ({ setActual, setBusinessData }) => {
          await transferPage.gotoBrokerageDetail(
            env.client.baseUrl!,
            config.brokerName,
            config.brokerAccountId
          );
          const transferIdsAfter = new Set(
            (await transferPage.readHistoryRecords()).map(record => record.clientTransferId)
          );
          expect([...transferIdsAfter].sort()).toEqual([...transferIdsBefore].sort());
          expect(transferPage.wasSubmissionClicked()).toBe(false);
          expect(transferPage.wasSecurityVerificationClicked()).toBe(false);
          expect(approvalReview.approvalClickCount()).toBe(1);
          expect(afterBalance.equals(expectedFinalBalance)).toBe(true);
          expect(ledgerRecord.ledgerTransactionId).toMatch(/^TXN-/);
          setBusinessData({
            noNewTransferCreated: true,
            confirmed: true,
            finalStatus: completedClientRecord.status,
            adminFinalStatus: approvedAdminRecord.status
          });
          setActual('未创建第二条Transfer；现有TRF、Admin TXN、余额和Client流水闭环全部确认');
        }
      );
    } catch (error) {
      if (approvalReview.wasApproved()) {
        business.requireManualReview('现有TRF、Admin TXN、香港账户余额和Client交易流水');
        business.disallowSafeRerun();
        await business.step(
          {
            action: '异常后只读复核现有TR-003',
            expected: '不再次批准、不新建Transfer，只查询Admin、Client、余额和流水'
          },
          async ({ setActual, setBusinessData }) => {
            const observations: string[] = [];
            try {
              await adminPage.goto(
                new URL('/zh-CN/operation/fiatAssets', env.admin.baseUrl!).toString(),
                { waitUntil: 'domcontentloaded' }
              );
              await adminList.goto(env.admin.baseUrl!);
              const record = await adminList.readRecordByAdminTransactionId(
                adminRecord.adminTransactionId
              );
              setBusinessData({ adminStatusAfter: record.status });
              observations.push(`Admin状态=${record.status}`);
            } catch (recoveryError) {
              observations.push(
                `Admin状态查询失败=${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`
              );
            }

            try {
              await transferPage.gotoBrokerageDetail(
                env.client.baseUrl!,
                config.brokerName,
                config.brokerAccountId
              );
              const record = await transferPage.readHistoryRecord(clientRecord.clientTransferId);
              setBusinessData({ clientFinalStatus: record.status });
              observations.push(`Client状态=${record.status}`);
            } catch (recoveryError) {
              observations.push(
                `Client状态查询失败=${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`
              );
            }

            try {
              await accountPage.goto(env.client.baseUrl!);
              const balance = await accountPage.readAvailableBalance(
                existing.sourceAccount,
                existing.currency
              );
              setBusinessData({ jurisdictionBalanceAfter: balance.availableBalance.toString() });
              observations.push('香港账户余额已只读查询');
            } catch (recoveryError) {
              observations.push(
                `余额查询失败=${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`
              );
            }

            setBusinessData({
              approvalClickCount: approvalReview.approvalClickCount(),
              secondaryConfirmationClickCount:
                approvalReview.secondaryConfirmationClickCount(),
              noNewTransferCreated: true,
              confirmed: false
            });
            setActual(`${observations.join('；')}；未再次批准，未创建新Transfer`);
          }
        );
      }
      throw error;
    }
  }
);
