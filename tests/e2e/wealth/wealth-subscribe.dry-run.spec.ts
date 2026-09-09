import { WealthOrderListPage, type WealthAdminCandidate } from '../../../pages/admin/WealthOrderListPage';
import { FundSubscribePage } from '../../../pages/client/FundSubscribePage';
import { FundTradingPage, type WealthHistoryRecord } from '../../../pages/client/FundTradingPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { Decimal } from '../../../src/utils/money';
import { prepareWealthResume } from '../../../src/wealth/wealth-e2e';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'WS-002/003 理财认购双端Readiness Dry Run',
  {
    tag: ['@e2e', '@wealth', '@subscribe', '@readonly', '@dry-run', '@L3'],
    annotation: [
      { type: 'caseId', description: 'WS-DRY' },
      { type: 'flowId', description: 'wealth-subscribe-dry-run' },
      { type: 'module', description: 'Client + Admin理财认购' },
      { type: 'priority', description: 'P1' },
      { type: 'type', description: 'Dry Run / Readonly' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ clientPage, adminPage, business }, testInfo) => {
    test.setTimeout(180_000);
    if (!env.client.baseUrl || !env.admin.baseUrl) {
      throw new Error('Client/Admin URLs are required for Wealth Subscribe Dry Run.');
    }
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);
    expect(testInfo.project.retries).toBe(0);

    const funds = new FundTradingPage(clientPage);
    const subscribe = new FundSubscribePage(clientPage);
    const admin = new WealthOrderListPage(adminPage);

    business.case({
      flowId: 'wealth-subscribe-dry-run',
      caseId: 'WS-DRY',
      module: 'Client + Admin理财认购',
      name: 'WS-002/003 理财认购双端Readiness Dry Run',
      description: '形成未提交认购摘要，并使用Client真实INV历史精确核对Admin认购管理与详情入口。',
      priority: 'P1',
      level: 'L3',
      type: ['Dry Run', 'Readonly', 'Non-mutation'],
      scope: 'Client + Admin',
      owner: 'QA',
      requirement: 'WS-002 Reject / WS-003 Approve readiness',
      preconditions: ['Client/Admin认证有效', '两个Mutation开关均关闭'],
      target: '验证认购表单、INV精确定位、Admin详情和Resume结构，不创建订单。',
      expectedResult: 'Client提交0次、Admin处理0次；如存在历史INV则候选严格唯一。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: true,
      safetySwitches: ['ALLOW_MONEY_TESTS=false', 'ALLOW_ADMIN_MUTATION_TESTS=false']
    });

    let selectedProduct = '';
    let selectedAmount = '';
    let selectedProductLockPeriod = '';
    let selectedPaymentBalance = '';
    await business.step(
      { action: '形成合法但未提交的Client认购摘要', expected: '产品、余额、最低金额和0手续费可读，确认并提交保持0次点击' },
      async ({ setActual, setBusinessData }) => {
        await funds.goto(env.client.baseUrl!);
        await funds.openCatalog();
        const products = await funds.readProducts();
        const product = products
          .filter(item => item.currency === 'USD' && new Decimal(item.minimumInvestment).greaterThan(0))
          .sort((left, right) => new Decimal(left.minimumInvestment).comparedTo(right.minimumInvestment))[0];
        expect(product).toBeDefined();
        selectedProduct = product.name;
        selectedAmount = product.minimumInvestment;
        selectedProductLockPeriod = product.lockPeriod;
        await funds.openSubscription(product.name);
        await subscribe.expectLoaded();
        const accounts = await subscribe.readPaymentAccounts();
        const account = accounts.find(item =>
          item.currency === product.currency && new Decimal(item.balance).greaterThanOrEqualTo(product.minimumInvestment)
        );
        expect(account).toBeDefined();
        selectedPaymentBalance = account!.balance;
        await subscribe.selectPaymentAccount(account!.accountType);
        await subscribe.acceptTerms();
        await subscribe.fillAmount(product.minimumInvestment);
        expect(await subscribe.submitEnabled()).toBe(true);
        const snapshot = await subscribe.readSnapshot();
        expect(new Decimal(snapshot.amount).equals(product.minimumInvestment)).toBe(true);
        expect(new Decimal(snapshot.feeAmount).isZero()).toBe(true);
        expect(subscribe.submissionClickCount()).toBe(0);
        const prepared = prepareWealthResume(
          `WS-DRY-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
          'subscription',
          product.minimumInvestment,
          product.currency
        );
        expect(prepared.stage).toBe('PREPARED');
        setBusinessData({
          selectedProduct,
          requestedAmount: `${selectedAmount} ${product.currency}`,
          paymentAccount: account!.accountType,
          paymentBalance: `${selectedPaymentBalance} ${product.currency}`,
          feeAmount: `${snapshot.feeAmount} ${snapshot.currency}`,
          feeRate: snapshot.feeRate,
          productLockPeriod: selectedProductLockPeriod,
          securityKeyRequiredForMutation: true,
          securityKeyVerificationClicks: 0,
          readinessStatus: 'IN_PROGRESS',
          mutationPerformed: false
        });
        setActual('已形成有效认购摘要；未点击确认并提交，未触发安全密钥，未创建INV订单');
      }
    );

    let matchedRecord: WealthHistoryRecord | undefined;
    let matchedCandidate: WealthAdminCandidate | undefined;
    let positionRecordCount = 0;
    let redeemablePositionCount = 0;
    await business.step(
      { action: '以Client真实INV历史精确查询Admin认购管理', expected: '按真实INV编号搜索，候选最多一条且不依赖列表第一条' },
      async ({ setActual, setBusinessData }) => {
        await funds.goto(env.client.baseUrl!);
        const positions = await funds.openPositions();
        positionRecordCount = positions.renderedPositionRows;
        redeemablePositionCount = positions.redeemActionCount;
        const history = await funds.readHistory('申购', 1);
        expect(history.length).toBeGreaterThan(0);
        await admin.goto(env.admin.baseUrl!, 'subscription');
        const headers = await admin.tableHeaders();
        expect(headers).toEqual(expect.arrayContaining(['客户 / 订单', '产品 / 风险', '认购金额', '审批状态']));

        for (const record of history) {
          const candidates = await admin.findExactOrder(record.orderId, 'subscription');
          if (candidates.length > 1) {
            throw new Error(`Admin exact INV search returned ${candidates.length} candidates.`);
          }
          if (candidates.length === 1) {
            matchedRecord = record;
            matchedCandidate = candidates[0];
            break;
          }
        }
        if (!matchedRecord || !matchedCandidate) {
          testInfo.annotations.push({
            type: 'blocker',
            description: 'BLOCKED_PRODUCT: Client历史INV在Admin认购管理三个状态Tab均无候选'
          });
          setBusinessData({
            wealthHistoryCount: history.length,
            positionRecordCount,
            redeemablePositionCount,
            candidateCount: 0,
            readinessStatus: 'BLOCKED_PRODUCT',
            blockerReason: 'Client历史INV无法在Admin认购管理按订单号关联'
          });
          setActual(`Client可读取${history.length}条INV历史；Admin三个状态Tab候选均为0，Mutation保持阻塞`);
          return;
        }
        setBusinessData({
          investmentOrderId: matchedRecord!.orderId,
          wealthHistoryCount: history.length,
          positionRecordCount,
          redeemablePositionCount,
          candidateCount: 1,
          adminMatchedStatus: matchedCandidate.status
        });
        setActual('已使用Client页面真实INV编号在Admin三个状态Tab中取得唯一候选');
      }
    );

    if (!matchedRecord || !matchedCandidate) {
      await business.step(
        { action: '以产品阻塞状态安全停止', expected: 'Client提交0次、Admin处理0次，不伪造跨端候选' },
        async ({ setActual, setBusinessData }) => {
          expect(subscribe.submissionClickCount()).toBe(0);
          expect(admin.mutationClickCount()).toBe(0);
          setBusinessData({ mutationPerformed: false });
          setActual('历史INV跨端不可见；已在任何Client提交和Admin详情/处理前停止');
        }
      );
      return;
    }

    await business.step(
      { action: '打开唯一Admin认购详情并停在最终处理前', expected: '详情包含原INV与产品；批准/拒绝动作仅定位，不点击' },
      async ({ setActual, setBusinessData, recordPrimaryOracle }) => {
        const detail = await admin.openDetails(matchedCandidate!);
        expect(detail.text).toContain(matchedRecord!.orderId);
        if (matchedRecord!.productName) expect(detail.text).toContain(matchedRecord!.productName);
        expect(admin.mutationClickCount()).toBe(0);
        expect(subscribe.submissionClickCount()).toBe(0);
        const ws002ReadinessStatus = detail.rejectActionVisible
          ? 'ADMIN_REJECT_ACTION_VISIBLE'
          : 'BLOCKED_ADMIN_REJECT_FORM';
        const ws003ReadinessStatus = detail.approveActionVisible && positionRecordCount > 0
          ? 'ADMIN_APPROVE_AND_POSITION_VISIBLE'
          : 'BLOCKED_ADMIN_APPROVE_FORM_OR_POSITION_ORACLE';
        if (!detail.rejectActionVisible) {
          testInfo.annotations.push({
            type: 'blocker',
            description: 'WS-002: 历史终态详情没有可用拒绝入口，拒绝表单与余额恢复规则仍未验证'
          });
        }
        if (!detail.approveActionVisible || positionRecordCount === 0) {
          testInfo.annotations.push({
            type: 'blocker',
            description: 'WS-003: 历史终态详情没有可用批准入口或Client持仓不可观测'
          });
        }
        setBusinessData({
          adminMatchedStatus: matchedCandidate!.status,
          approveActionAvailable: detail.approveActionVisible,
          rejectActionAvailable: detail.rejectActionVisible,
          ws002ReadinessStatus,
          ws003ReadinessStatus,
          mutationPerformed: false
        });
        recordPrimaryOracle({
          id: 'ws-dry-exact-inv',
          name: 'Client/Admin INV精确关联',
          expected: '候选数=1，详情包含同一INV，写操作0次',
          actual: '候选数=1，详情INV一致，Client/Admin写操作均为0次',
          status: 'passed'
        });
        setActual(`唯一认购详情已打开；Admin状态=${matchedCandidate!.status}，批准入口=${detail.approveActionVisible ? '可见' : '不可见'}，拒绝入口=${detail.rejectActionVisible ? '可见' : '不可见'}，写操作0次`);
      }
    );
  }
);
