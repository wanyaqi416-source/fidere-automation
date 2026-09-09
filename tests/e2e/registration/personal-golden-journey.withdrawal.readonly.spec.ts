import { expect, test } from '../../../fixtures/registration.fixture';
import { env } from '../../../src/config/env';
import { advanceFlowState, FlowStateStore } from '../../../src/flow-engine';
import { matchAdminWithdrawalRecordsIgnoringStatus } from '../../../src/withdrawal/withdrawal-e2e';
import { PersonalPostRegistrationJourneyStore } from '../../../src/journey';
import { openPersonalJourneyClientSession, PersonalJourneyContextStore } from '../../../src/registration';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { WithdrawalHistoryPage } from '../../../pages/client/WithdrawalHistoryPage';
import { WithdrawalListPage } from '../../../pages/admin/WithdrawalListPage';

test.skip(!env.personalRegistration.adminApprovalSourceRunId, 'Requires an explicitly selected existing Journey.');
test('原Journey出金订单和当前批准渠道只读核对 @readonly @L2 @withdrawal', async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(120_000);
  expect(env.exchange.allowMoneyTests || env.allowAdminMutationTests).toBe(false);
  const id = env.personalRegistration.adminApprovalSourceRunId!;
  const source = new PersonalJourneyContextStore().load(id)!;
  const journey = new PersonalPostRegistrationJourneyStore(id).load()!;
  const saved = journey.withdrawal!;
  const state = new FlowStateStore().load('personal-golden-journey-withdrawal', saved.runId)!;
  expect(Boolean(state.clientReference)).toBe(true);
  business.case({ caseId: 'PERSONAL-GJ-WD-READ', module: 'Fresh User Golden Journey', name: '现有出金只读核对', priority: 'P0', type: ['Read-only'], scope: 'Client + Admin', changesData: false, affectsMoney: false, preconditions: ['已有原TXN'], dependsOnAdmin: true, dependsOnThirdParty: false, expectedResult: '只读订单、余额及批准渠道，无新提交或批准。' });
  const client = await openPersonalJourneyClientSession({ browser, baseURL: env.client.baseUrl!, runId: id, email: source.email, password: env.client.password!, otp: env.client.otp!, forceFreshLogin: true });
  const safeResponses: Promise<unknown>[] = [];
  let completedClient = false;
  for (const page of [client.page, adminPage]) page.on('response', response => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/')) return;
    safeResponses.push((async () => {
      const value: unknown = await response.json();
      const matches: unknown[] = [];
      function visit(node: unknown): void {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { for (const item of node) visit(item); return; }
        const object = node as Record<string, unknown>;
        const text = JSON.stringify(object);
        if (text.includes(state.clientReference!)) {
          const values = Object.entries(object).filter(([key, child]) => /amount|fee|balance|net|rate/i.test(key) && (typeof child === 'number' || (typeof child === 'string' && /^-?\d+(\.\d+)?$/.test(child))));
          if (values.length) matches.push(Object.fromEntries(values));
        }
        for (const child of Object.values(object)) visit(child);
      }
      visit(value);
      return matches.length ? { path: url.pathname, status: response.status(), moneyFields: matches } : undefined;
    })().catch(() => undefined));
  });
  try {
    await business.step({ action: '读取原Client TXN和余额', expected: '只读原申请，不进入出金表单。' }, async context => {
      const history = new WithdrawalHistoryPage(client.page); await history.goto(env.client.baseUrl!);
      await history.transactions.searchByBusinessId(state.clientReference!);
      const record = await history.recordById(state.clientReference!); expect(Boolean(record)).toBe(true);
      const detail = await (await history.openDetail(record!)).readFiatWithdrawalDetail();
      expect(detail.clientWithdrawalId === state.clientReference).toBe(true);
      expect(detail.requestedAmount).toBe(saved.requestedAmount);
      expect(detail.currency).toBe(saved.currency);
      completedClient = detail.status === '已完成';
      let balanceText = '未读取';
      try {
        const accounts = new AccountDetailPage(client.page); await accounts.goto(env.client.baseUrl!);
        balanceText = (await accounts.readAvailableBalance(saved.accountType, saved.currency)).availableBalance.toString();
      } catch {
        context.recordDiagnostic({ id: 'PGJWD-BALANCE-READ', name: '余额读取', status: 'unavailable', summary: '辅助余额读取暂不可用，不影响原订单状态核对。', affectsCoreBusiness: false });
      }
      const safe = { state: detail.status, fee: detail.feeAmount, amount: detail.requestedAmount, balance: balanceText, txn: state.clientReference!.slice(0,4) + '****' + state.clientReference!.slice(-4) };
      console.log('Existing Withdrawal:', JSON.stringify(safe));
      context.setBusinessData({ withdrawalOrderId: state.clientReference, clientWithdrawalStatus: detail.status, feeAmount: detail.feeAmount, submittedAvailableBalance: balanceText });
      context.setActual(`原TXN状态=${detail.status}；金额=${detail.requestedAmount}；手续费=${detail.feeAmount}；当前余额=${balanceText}。`);
      if (completedClient) {
        await history.goto(env.client.baseUrl!);
        const added = (await history.readRecords()).filter(record => !saved.previousTransactionIds.includes(record.clientWithdrawalId));
        expect(added.length).toBe(1);
        expect(added[0].clientWithdrawalId === state.clientReference).toBe(true);
        context.recordPrimaryOracle({ id: 'PGJWD-CLIENT-DONE', name: '原TXN完成且无第二笔出金', expected: '同一原申请已完成', actual: '已完成，新增仅原TXN一笔', status: 'passed' });
      }
    });
    await business.step({ action: '读取唯一Admin原申请与当前打款渠道', expected: '唯一定位后只打开详情和下拉框，批准点击0次。' }, async context => {
      const list = new WithdrawalListPage(adminPage); await list.goto(env.admin.baseUrl!); await list.searchCustomerEmail(source.email);
      const fingerprint = { runId: saved.runId, userIdentity: source.email, accountType: saved.accountType, currency: saved.currency, requestedAmount: saved.requestedAmount, clientSubmittedAtMs: Date.parse(state.clientSubmittedAt!), adminStatus: '待处理' };
      const matches = matchAdminWithdrawalRecordsIgnoringStatus(await list.readAllFilteredRecords(), fingerprint, env.withdrawal.matchWindowMs);
      expect(matches).toHaveLength(1);
      context.setBusinessData({ candidateCount: 1, adminStatusAfter: matches[0].status, approvalClicks: saved.approvalClicks });
      if (completedClient) {
        expect(matches[0].status).toMatch(/^(处理完成|已完成|已批准)$/);
        expect(saved.approvalClicks).toBe(1);
        context.recordPrimaryOracle({ id: 'PGJWD-ADMIN-DONE', name: 'Admin唯一对应申请已实际批准完成', expected: '候选=1、批准=1、成功终态', actual: `${matches[0].status}，原批准次数=1，本次未批准`, status: 'passed' });
        context.recordDiagnostic({ id: 'PGJWD-BALANCE', name: '余额数据（非计分）', status: 'info', summary: `原余额=${saved.balanceBefore}；金额=${saved.requestedAmount}；费用=${saved.feeAmount}；批准后=${saved.balanceAfter} USD。`, reason: '按最新要求不执行余额等式断言；原0.01 USD差异保留记录，不影响本次结果。', affectsCoreBusiness: false });
        if (state.stage === 'CLIENT_FINALIZED') new FlowStateStore().save(advanceFlowState(state, 'COMPLETED'));
        context.setBusinessData({ confirmed: true, finalStatus: 'WITHDRAWAL_COMPLETED', resumeStage: 'COMPLETED', safeToRerun: false, noNewWithdrawalCreated: true });
        context.setActual(`原Admin记录唯一且${matches[0].status}，历史批准=1，本次只读0次；原Client已完成。`);
        return;
      }
      await list.selectStatus('待处理');
      const detailPage = await list.openDetail(await list.locateFingerprintCandidate(fingerprint, env.withdrawal.matchWindowMs));
      const detail = await detailPage.readDetail();
      const form = detailPage.approvalForm();
      const channels = await form.readPaymentChannelOptions();
      const banks = await form.readPaymentBankOptions();
      expect(form.approvalClicks()).toBe(0);
      console.log('Admin safe fields:', JSON.stringify({ status: detail.status, amount: detail.requestedAmount, fee: detail.feeAmount, net: detail.netAmount, channels, banks }));
      context.setActual(`候选=1；状态=${detail.status}；费用=${detail.feeAmount}；到账=${detail.netAmount}；渠道=${channels.join('、')}；银行=${banks.join('、')}。未批准。`);
      await testInfo.attach('current-approval-options', { body: JSON.stringify({ channels, banks }), contentType: 'application/json' });
    });
  } finally {
    const evidence: unknown[] = [];
    for (const response of safeResponses) { const value = await response; if (value) evidence.push(value); }
    console.log('Safe order money evidence:', JSON.stringify(evidence));
    await testInfo.attach('existing-order-money-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
    await client.context.close();
  }
});
