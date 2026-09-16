import { expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { AdminShellPage } from '../../pages/admin/AdminShellPage';
import { TransferListPage } from '../../pages/admin/TransferListPage';
import { AccountInternalTransferPage } from '../../pages/client/AccountInternalTransferPage';
import { UserToUserTransferPage } from '../../pages/client/UserToUserTransferPage';
import { env } from '../config/env';
import { MoneyMutationGuard, assertSandboxEnvironment } from '../flow-engine/mutation-guard';
import { FlowStateStore, advanceFlowState, createPreparedFlowState } from '../flow-engine/resume-state';
import type { BusinessReportApi } from '../reporting/business-report.types';
import { Decimal } from '../utils/money';
import { getClientSecurityKey } from '../utils/security-key';
import { loginU2uParticipant, readU2uBalance } from './u2u-participant';
import { assertU2uFreshAllowedForParticipants, loadU2uEvidence, participantHash, saveU2uEvidence, U2U_FLOW_ID, type U2uEvidence } from './u2u-evidence';
import { existingU2uConfig, assertExistingU2uResume, matchExistingU2uOrders, U2U_EXISTING_FLOW_ID } from './u2u-existing-contract';
import { openOriginalU2uReview, readOriginalU2uApproval } from './u2u-admin-review';

export async function runExistingU2u(input: {
  browser: Browser; adminPage: Page; business: BusinessReportApi; testInfo: TestInfo;
}) {
  const { browser, adminPage, business, testInfo } = input;
  business.flow(U2U_EXISTING_FLOW_ID);
  const config = existingU2uConfig({ ...process.env, CLIENT_USERNAME: env.client.username });
  const { sender, recipient, runId, account, targetAccount, currency, amount } = config;
  const switches = { ALLOW_MONEY_TESTS: env.exchange.allowMoneyTests,
    ALLOW_CLIENT_MUTATION_TESTS: env.allowClientMutationTests, ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests };
  const guard = new MoneyMutationGuard(U2U_EXISTING_FLOW_ID, true, true);
  guard.validateRuntime({ baseURL: env.client.baseUrl, workers: testInfo.config.workers,
    retries: testInfo.project.retries, repeatEach: testInfo.project.repeatEach, safetySwitches: switches });
  assertSandboxEnvironment(env.admin.baseUrl);
  expect(testInfo.retry + testInfo.repeatEachIndex).toBe(0);
  const baseURL = env.client.baseUrl!, adminURL = env.admin.baseUrl!;
  const key = getClientSecurityKey();
  const store = new FlowStateStore();
  let state = store.load(U2U_FLOW_ID, runId);
  let evidence: U2uEvidence | undefined;
  if (state) {
    evidence = loadU2uEvidence(runId);
    assertExistingU2uResume(state, evidence, config);
    if (state.stage === 'CLIENT_SUBMIT_ATTEMPTED') {
      throw new Error('Original confirmation already attempted; inspect original security state, never confirm again.');
    }
  } else assertU2uFreshAllowedForParticipants(store.list(U2U_FLOW_ID), runId, sender, recipient);
  const report = () => {
    if (state) business.setResumeState(state.stage);
    if (!evidence) return;
    business.setBusinessData({ runId, senderIdentity: sender, recipientIdentity: recipient,
      transferAmount: amount, transferCurrency: currency, sourceAccountType: account, targetAccountType: targetAccount,
      transferOrderId: evidence.orderId, adminTransactionId: evidence.senderLedgerId,
      fee: evidence.fee, expectedReceivedAmount: evidence.expectedCredit, sourceBalanceBefore: evidence.senderBefore,
      confirmationClicks: evidence.confirmationClicks,
      securityVerificationClicks: evidence.verificationClicks, adminMutationClicks: evidence.adminApprovalClicks ?? 0,
      createdOrderCount: evidence.orderId ? 1 : 0 });
  };
  const persist = () => { store.save(state!); saveU2uEvidence(evidence!); report(); };
  const advance = (stage: Parameters<typeof advanceFlowState>[1]) => {
    state = advanceFlowState(state!, stage); persist();
  };
  const attempt = (action: string, stage: Parameters<typeof advanceFlowState>[1]) => {
    writeFileSync(`${store.pathFor(U2U_FLOW_ID, runId)}.${action}-attempt`, new Date().toISOString(), { flag: 'wx' });
    advance(stage);
  };
  const diagnostic = (id: string) => business.recordDiagnostic({ id, name: '单次操作后只读查询', status: 'info',
    summary: '操作已尝试，UI结果暂未确认；只查询原业务，不重复点击。', affectsCoreBusiness: false });
  let client: Awaited<ReturnType<typeof loginU2uParticipant>> | undefined;
  const observeRequest = (request: import('@playwright/test').Request) => {
    const url = new URL(request.url());
    if (evidence && url.origin === new URL(baseURL).origin && url.pathname === '/api/transfer/p2p' && request.method() === 'POST') {
      evidence.requestCount += 1; saveU2uEvidence(evidence);
    }
  };
  try {
    await business.step({ action: '发送方账号及管理端认证预检', expected: '发送方KYC通过、指定资产账户可读且管理端认证有效；不登录收款账号' }, async step => {
      expect(await new AdminShellPage(adminPage).inspectAuthentication(adminURL), 'Admin protected page authentication').toBe('valid');
      client = await loginU2uParticipant(browser, baseURL, sender);
      if (!state || state.stage === 'PREPARED') {
        const senderBefore = await readU2uBalance(client.page, baseURL, account, currency);
        expect(new Decimal(senderBefore).gt(amount), 'Leave a positive balance; verify fee from the live quote').toBe(true);
        evidence = { runId, senderHash: participantHash(sender), recipientHash: participantHash(recipient),
          sourceAccountType: account, targetAccountType: targetAccount, currency, amount,
          fee: '', expectedCredit: '', senderBefore,
          senderLedgerIdsBefore: [],
          orderIdsBefore: (await new AccountInternalTransferPage(client.page).readRecords(baseURL)).map(row => row.orderNo),
          confirmationClicks: 0, verificationClicks: 0, requestCount: 0, network: [] };
        state ??= createPreparedFlowState({ flowId: U2U_FLOW_ID, runId, amount, currency });
        persist();
      }
      guard.markAuthenticationReady(true, true);
      step.setActual('发送方独立登录、KYC及余额可读；管理端认证有效；收款账号将在Client提交时按邮箱校验。');
    });
    const history = new AccountInternalTransferPage(client!.page);
    if (state!.stage === 'PREPARED') {
      const transfer = new UserToUserTransferPage(client!.page);
      await business.step({ action: '填写本次收款邮箱并核对转账报价', expected: '资产唯一且可转，余额足够，手续费与预计到账符合真实页面规则' }, async step => {
        await transfer.goto(baseURL); await transfer.fillRecipient(sender, recipient);
        const summary = await transfer.previewUniqueAsset(currency, amount, account);
        expect(summary.submitEnabled && summary.quote.transferable).toBe(true);
        expect(new Decimal(summary.sourceBalanceBefore.replace(/,/g, '')).eq(evidence!.senderBefore)).toBe(true);
        evidence!.fee = summary.quote.fee; evidence!.expectedCredit = summary.quote.expectedCredit;
        await transfer.fillRunNote(runId); persist();
        step.setActual(`金额${amount}，手续费${evidence!.fee}，预计到账${evidence!.expectedCredit} ${currency}；收款资格仍接受服务端最终校验。`);
      });
      await business.step({ action: '单次提交并完成安全验证', expected: '确认和安全验证各一次；未确认真实创建不得重新提交' }, async step => {
        guard.assertClientMoneyConfirmationAllowed(switches);
        await transfer.confirmOnce(() => {
          evidence!.confirmationClicks = 1; attempt('confirm', 'CLIENT_SUBMIT_ATTEMPTED');
          guard.recordClientMoneyConfirmation(); business.disallowSafeRerun();
        });
        await transfer.security.fill(key); guard.assertSecurityKeyVerificationAllowed(switches);
        evidence!.verificationClicks = 1; evidence!.submittedAt = new Date().toISOString();
        attempt('security', 'SECURITY_KEY_VERIFICATION_ATTEMPTED'); guard.recordSecurityKeyVerification();
        business.markPotentiallySubmitted();
        client!.page.on('request', observeRequest);
        try { await transfer.security.verifyOnce(); }
        catch { diagnostic('security-ui'); }
        step.setActual('安全验证尝试一次；下一步只读确认本Run实际生成的订单。');
      });
    }
    if (['SECURITY_KEY_VERIFICATION_ATTEMPTED', 'CLIENT_CREATED', 'ADMIN_LOCATED'].includes(state!.stage)) {
      await business.step({ action: '确认原用户转账真实创建及唯一编号', expected: '完整历史中存在唯一新用户转账；TRF、TXN、方向、金额、费用、到账及时间匹配' }, async step => {
        let matches: ReturnType<typeof matchExistingU2uOrders> = [];
        await expect.poll(async () => {
          matches = matchExistingU2uOrders(await history.readRecords(baseURL), evidence!);
          business.setBusinessData({ candidateCount: matches.length });
          return matches.length;
        }, { timeout: 75_000, message: 'U2U_TRANSFER_SUBMISSION_UNCONFIRMED' }).not.toBe(0);
        expect(matches.length, 'U2U duplicate records; no approval permitted').toBe(1);
        const [order] = matches;
        step.setBusinessData({ observedOrderFee: order.fee, observedOrderActualAmount: order.actualAmount,
          quotedFee: evidence!.fee, quotedExpectedCredit: evidence!.expectedCredit });
        await testInfo.attach('u2u-created-order-summary', { body: JSON.stringify({
          orderId: order.orderNo, transactionId: order.txNo, amount: order.amount,
          fee: order.fee, actualAmount: order.actualAmount, status: order.status
        }), contentType: 'application/json' });
        expect(evidence!.requestCount, 'No duplicate U2U submission requests').toBeLessThanOrEqual(1);
        expect(order.orderNo).toMatch(/^TRF-[A-Z0-9-]+$/i); expect(order.txNo).toMatch(/^TXN-[A-Z0-9-]+$/i);
        expect(new Decimal(order.fee).eq(evidence!.fee),
          `Created order fee ${order.fee} must equal quoted fee ${evidence!.fee}`).toBe(true);
        // Client transfer history's actualAmount is the submitted transfer amount for P2P.
        // The recipient credit is verified against Admin netAmount and the recipient ledger later.
        expect(new Decimal(order.actualAmount).eq(evidence!.amount),
          `Created P2P order actual amount ${order.actualAmount} must equal transfer amount ${evidence!.amount}`).toBe(true);
        if (evidence!.orderId) expect(order.orderNo).toBe(evidence!.orderId);
        if (evidence!.senderLedgerId) expect(order.txNo).toBe(evidence!.senderLedgerId);
        evidence!.orderId = order.orderNo; evidence!.senderLedgerId = order.txNo;
        if (state!.stage === 'SECURITY_KEY_VERIFICATION_ATTEMPTED') state = advanceFlowState(state!, 'CLIENT_CREATED', {
          clientReference: order.orderNo, adminReference: order.txNo, clientSubmittedAt: evidence!.submittedAt });
        persist(); business.markMutationPerformed('本Run唯一用户转账真实创建已确认');
        step.recordPrimaryOracle({ id: 'single-order', name: '唯一原订单', expected: '真实TRF/TXN且数据匹配', actual: '候选1，数据一致', status: 'passed' });
        step.setActual('本Run唯一新TRF/TXN已确认，原订单与报价一致。');
      });
    }
    if (state!.stage === 'CLIENT_CREATED' || state!.stage === 'ADMIN_LOCATED') {
      await business.step({ action: '唯一定位原订单并由管理端批准', expected: '候选恰好1条，详情二次匹配，仅批准本Run原订单一次' }, async step => {
        if (evidence!.adminApprovalClicks) throw new Error('Approval already attempted; query original status only.');
        const original = await openOriginalU2uReview({ page: adminPage, baseURL: adminURL, sender, recipient, evidence: evidence!, business });
        if (state!.stage === 'CLIENT_CREATED') advance('ADMIN_LOCATED');
        // Restore persisted creation into an Admin-only guard, not a new Client submission.
        const approvalGuard = new MoneyMutationGuard(U2U_EXISTING_FLOW_ID, true, false);
        approvalGuard.markAuthenticationReady(true, true); approvalGuard.recordClientSubmission();
        approvalGuard.recordUniqueAdminCandidate(1); approvalGuard.assertAdminActionAllowed(switches);
        await original.review.fillRemark(`AUTO_U2U_APPROVE_${runId}`);
        expect(await original.review.readRemarkValue()).toBe(`AUTO_U2U_APPROVE_${runId}`);
        attempt('approve', 'FIDERE_APPROVAL_ATTEMPTED'); approvalGuard.recordAdminAction();
        business.markMutationPerformed('Admin批准本Run原用户转账一次');
        try { await original.review.confirmApproveOnce(switches.ALLOW_MONEY_TESTS, switches.ALLOW_ADMIN_MUTATION_TESTS); }
        catch (error) { if (!original.review.wasApproved()) throw error; diagnostic('approval-ui'); }
        finally {
          evidence!.adminApprovalClicks = original.review.approvalClickCount();
          evidence!.adminConfirmationClicks = original.review.secondaryConfirmationClickCount(); persist();
        }
        step.setActual('批准已尝试一次，继续只读确认原订单审批状态。');
      });
    }
    if (state!.stage === 'FIDERE_APPROVAL_ATTEMPTED' || state!.stage === 'ADMIN_ACTION_DONE') {
      await business.step({ action: '确认原订单审核通过', expected: '原TXN真实状态已批准，不因弹窗关闭就判成功' }, async step => {
        const approved = await readOriginalU2uApproval(new TransferListPage(adminPage), adminURL, sender, evidence!.senderLedgerId!);
        evidence!.adminStatus = approved.status;
        if (state!.stage === 'FIDERE_APPROVAL_ATTEMPTED') advance('ADMIN_ACTION_DONE'); else persist();
        step.recordPrimaryOracle({ id: 'approved', name: '原订单批准', expected: '原TXN已批准', actual: approved.status, status: 'passed' });
        step.setActual('原TXN已批准；按当前业务规则，Admin审核提交成功即完成。');
      });
    }
    if (state!.stage !== 'ADMIN_ACTION_DONE' && state!.stage !== 'CLIENT_FINALIZED') {
      throw new Error('Unsupported U2U Resume stage; no replacement transfer or repeated approval.');
    }
    advance('COMPLETED');
    business.recordPrimaryOracle({ id: 'admin-approval-completed', name: '原用户转账审核提交成功',
      expected: '唯一原订单仅批准一次并提交成功', actual: evidence!.adminStatus ?? '已批准', status: 'passed' });
    business.setBusinessData({ confirmed: true, finalStatus: 'Admin审核提交成功', manualCheckRequired: false });
  } catch (error) {
    if (state && ['SECURITY_KEY_VERIFICATION_ATTEMPTED', 'FIDERE_APPROVAL_ATTEMPTED'].includes(state.stage)) {
      business.requireManualReview('单次资金或审批操作结果未确认；仅Resume查询原订单，禁止重复提交或审批。');
    }
    throw error;
  } finally {
    report();
    if (client) { client.page.off('request', observeRequest); await client.context.close(); }
  }
}
