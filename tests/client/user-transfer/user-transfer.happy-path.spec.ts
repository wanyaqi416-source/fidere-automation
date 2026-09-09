import type { Request } from '@playwright/test';
import { test, expect } from '../../../fixtures/client.fixture';
import { UserToUserTransferPage } from '../../../pages/client/UserToUserTransferPage';
import { TransactionsPage } from '../../../pages/client/TransactionsPage';
import { env } from '../../../src/config/env';
import { MoneyMutationGuard } from '../../../src/flow-engine/mutation-guard';
import { advanceFlowState, createPreparedFlowState, FlowStateStore } from '../../../src/flow-engine/resume-state';
import { Decimal } from '../../../src/utils/money';
import { getClientSecurityKey } from '../../../src/utils/security-key';
import { formatU2uBalance } from '../../../src/user-transfer/u2u-summary';
import { loginU2uParticipant, readU2uBalance, verifyU2uIdentity } from '../../../src/user-transfer/u2u-participant';
import { assertU2uFreshAllowed, participantHash, saveU2uEvidence, U2U_FLOW_ID, type U2uEvidence } from '../../../src/user-transfer/u2u-evidence';
import { getFlowDefinition } from '../../../config/flow-registry';

test.describe.configure({ mode: 'serial', retries: 0 });
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.skip(!env.exchange.allowMoneyTests || !env.allowClientMutationTests, 'U2U requires explicit one-run Client and Money authorization.');

test('U2U-002 用户间转账完整闭环', { tag: ['@client', '@u2u', '@money', '@mutation'] }, async ({ page, browser, baseURL, business }, testInfo) => {
  test.setTimeout(300_000);
  business.flow(U2U_FLOW_ID);
  if (getFlowDefinition(U2U_FLOW_ID).requiresAdmin) {
    throw new Error('U2U requires Admin approval. Resume the existing TRF via Admin; this former direct-completion fresh command is disabled.');
  }
  const sender = env.client.username!;
  const recipient = process.env.U2U_RECIPIENT_EMAIL!;
  const runId = process.env.U2U_RUN_ID!;
  const currency = process.env.U2U_CURRENCY!;
  const account = process.env.U2U_SOURCE_ACCOUNT_TYPE!;
  const amount = process.env.U2U_TEST_AMOUNT!;
  if (!baseURL || !sender || !recipient || !runId || !currency || !account || !amount) throw new Error('U2U one-run identity, account, currency, amount and runId must be configured.');
  expect(sender.toLowerCase() === recipient.toLowerCase(), 'Sender and Recipient differ').toBe(false);
  const flags = { ALLOW_MONEY_TESTS: env.exchange.allowMoneyTests, ALLOW_CLIENT_MUTATION_TESTS: env.allowClientMutationTests };
  const guard = new MoneyMutationGuard(U2U_FLOW_ID, false, true);
  guard.validateRuntime({ baseURL, workers: testInfo.config.workers, retries: testInfo.project.retries,
    repeatEach: testInfo.project.repeatEach, safetySwitches: flags });
  expect(env.allowAdminMutationTests, 'No Admin mutation authorization is needed or used').toBe(false);
  const securityKey = getClientSecurityKey();
  const store = new FlowStateStore();
  assertU2uFreshAllowed(store.list(U2U_FLOW_ID), runId);
  let state = createPreparedFlowState({ runId, flowId: U2U_FLOW_ID, amount, currency });
  store.save(state);
  business.setResumeState(state.stage);
  const transfer = new UserToUserTransferPage(page);
  let evidence: U2uEvidence | undefined;
  let definiteRejection = false;
  const requests = new WeakMap<Request, string>();
  const observeRequest = (request: Request) => {
    if (new URL(request.url()).pathname !== '/api/transfer/p2p' || request.method() !== 'POST' || !evidence) return;
    evidence.requestCount += 1;
    requests.set(request, new Date().toISOString());
    saveU2uEvidence(evidence);
  };
  page.on('request', observeRequest);
  try {
    await business.step({ action: '双端认证和香港账户USD余额预检', expected: 'ENV指定Sender与指定Recipient独立认证、KYC/KYB通过、账户可读，不使用Admin' }, async ({ setActual }) => {
      const senderType = await verifyU2uIdentity(page, baseURL, sender);
      const senderBefore = await readU2uBalance(page, baseURL, account, currency);
      const senderTransactions = new TransactionsPage(page);
      await senderTransactions.gotoUserTransferHistory(baseURL);
      const senderIds = (await senderTransactions.readVisibleUserTransferRecords()).map(record => record.ledgerTransactionId);
      const receiver = await loginU2uParticipant(browser, baseURL, recipient);
      try {
        const recipientBefore = await readU2uBalance(receiver.page, baseURL, account, currency);
        const recipientTransactions = new TransactionsPage(receiver.page);
        await recipientTransactions.gotoUserTransferHistory(baseURL);
        const recipientIds = (await recipientTransactions.readVisibleUserTransferRecords()).map(record => record.ledgerTransactionId);
        evidence = { runId, senderHash: participantHash(sender), recipientHash: participantHash(recipient),
          sourceAccountType: account, targetAccountType: account, currency, amount, fee: '', expectedCredit: '',
          senderBefore, recipientBefore, senderLedgerIdsBefore: senderIds, recipientLedgerIdsBefore: recipientIds,
          confirmationClicks: 0, verificationClicks: 0, requestCount: 0, network: [] };
        saveU2uEvidence(evidence);
        setActual(`Sender=${senderType}；Recipient=${receiver.accountType}；两端审核状态通过；转出前=${formatU2uBalance(senderBefore)}；转入前=${formatU2uBalance(recipientBefore)} ${currency}。`);
        business.setBusinessData({ runId, senderIdentity: sender, recipientIdentity: recipient,
          sourceAccountType: account, targetAccountType: account, transferCurrency: currency,
          sourceBalanceBefore: formatU2uBalance(senderBefore), targetBalanceBefore: formatU2uBalance(recipientBefore) });
      } finally { await receiver.context.close(); }
      guard.markAuthenticationReady(true, false);
    });
    await business.step({ action: '收款邮箱与转账摘要确认', expected: '选择唯一香港USD资产，金额不使用全部余额，读取实际手续费及到账，不进入Admin' }, async ({ setActual }) => {
      await transfer.goto(baseURL);
      await transfer.fillRecipient(sender, recipient);
      const summary = await transfer.previewUniqueAsset(currency, amount, account);
      expect(summary.quote.transferable, 'Amount must exceed the actual fee and yield a positive net credit').toBe(true);
      expect(summary.submitEnabled).toBe(true);
      expect(new Decimal(summary.sourceBalanceBefore.replace(/,/g, '')).eq(evidence!.senderBefore), 'Sender balance has not changed during preflight').toBe(true);
      evidence!.fee = summary.quote.fee;
      evidence!.expectedCredit = summary.quote.expectedCredit;
      saveU2uEvidence(evidence!);
      business.setBusinessData({ transferAmount: amount, fee: summary.quote.fee, expectedReceivedAmount: summary.quote.expectedCredit });
      setActual(`香港账户/${currency}；转账=${amount}；手续费内扣=${summary.quote.fee}；预计到账=${summary.quote.expectedCredit}。收款用户已独立登录确认账户；服务端收款资格校验随本次唯一提交执行。`);
    });
    await business.step({ action: '单次确认并完成共享安全密钥验证', expected: '确认及安全密钥验证各最多一次；立即保存真实U2U接口证据，不以check-operate或Toast作为成功' }, async ({ setActual }) => {
      guard.assertClientMoneyConfirmationAllowed(flags);
      state = advanceFlowState(state, 'CLIENT_SUBMIT_ATTEMPTED');
      store.save(state);
      business.setResumeState(state.stage);
      guard.recordClientMoneyConfirmation();
      evidence!.confirmationClicks = 1;
      saveU2uEvidence(evidence!);
      await transfer.confirmOnce();
      await transfer.security.fill(securityKey);
      guard.assertSecurityKeyVerificationAllowed(flags);
      state = advanceFlowState(state, 'SECURITY_KEY_VERIFICATION_ATTEMPTED');
      store.save(state);
      business.setResumeState(state.stage);
      evidence!.submittedAt = new Date().toISOString();
      evidence!.verificationClicks = 1;
      saveU2uEvidence(evidence!);
      guard.recordSecurityKeyVerification();
      business.markPotentiallySubmitted();
      business.disallowSafeRerun();
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/transfer/p2p' && response.request().method() === 'POST', { timeout: 40_000 })
        .then(async response => {
          evidence!.network.push({ path: '/api/transfer/p2p', method: 'POST', status: response.status(), requestedAt: requests.get(response.request()) ?? evidence!.submittedAt! });
          saveU2uEvidence(evidence!);
          business.setBusinessData({ networkObservations: evidence!.network });
          const body = await response.json();
          const payload = body.data?.data ?? body.data;
          return { ok: response.ok() && body.code === 0, orderId: typeof payload?.orderNo === 'string' ? payload.orderNo as string : undefined };
        }).catch(() => undefined);
      try { await transfer.security.verifyOnce(); }
      catch { business.recordDiagnostic({ id: 'verification-ui', name: '安全验证后UI等待', status: 'unavailable', summary: 'UI等待未确认，继续查询本次唯一请求及原订单；不再次点击。', affectsCoreBusiness: false }); }
      const response = await responsePromise;
      if (response && !response.ok) definiteRejection = true;
      if (!response?.ok || !response.orderId || !/^TRF-[A-Z0-9-]+$/i.test(response.orderId)) {
        throw new Error('U2U_TRANSFER_SUBMISSION_UNCONFIRMED: no successful unique TRF response; no second submission allowed.');
      }
      evidence!.orderId = response.orderId;
      saveU2uEvidence(evidence!);
      state = advanceFlowState(state, 'CLIENT_CREATED', { clientReference: response.orderId, clientSubmittedAt: evidence!.submittedAt });
      store.save(state);
      business.setResumeState(state.stage);
      guard.assertClientSubmissionAllowed(flags);
      guard.recordClientSubmission();
      business.markMutationPerformed('用户间转账唯一TRF创建');
      expect(evidence!.requestCount, 'Exactly one real U2U submission request').toBe(1);
      const displayedId = await transfer.readCreatedOrderId();
      expect(displayedId === response.orderId, 'UI and response refer to the same new TRF').toBe(true);
      business.setBusinessData({ transferOrderId: response.orderId, confirmationClicks: 1, securityVerificationClicks: 1, createdOrderCount: 1, adminMutationClicks: 0 });
      business.recordPrimaryOracle({ id: 'single-submission', name: '单次安全验证及真实订单', expected: '一次请求、真实TRF且提交页相同编号', actual: '确认1次，验证1次，真实请求1次，TRF一致；后续必须处理原订单Admin审核', status: 'passed' });
      setActual('确认1次、验证1次、真实U2U请求1次，接口和页面TRF一致。保留原订单进入Admin审核，不检查余额和双方流水。');
    });
    throw new Error('Original Client order created; Admin approval Resume is required. Never submit another transfer.');
  } catch (error) {
    if (evidence?.verificationClicks && !definiteRejection) {
      if (!evidence.orderId) business.requireManualReview('原U2U订单创建结果未确认；仅允许只读查询，不允许重新提交。');
    }
    throw error;
  } finally {
    page.off('request', observeRequest);
    business.setResumeState(state.stage);
    if (evidence) {
      saveU2uEvidence(evidence);
      business.setBusinessData({ confirmationClicks: evidence.confirmationClicks, securityVerificationClicks: evidence.verificationClicks,
        adminMutationClicks: 0, networkObservations: evidence.network, transferOrderId: evidence.orderId });
      await testInfo.attach('u2u-safe-execution-evidence', { body: Buffer.from(JSON.stringify({ runId,
        amount, currency, fee: evidence.fee, expectedCredit: evidence.expectedCredit,
        senderBefore: formatU2uBalance(evidence.senderBefore), recipientBefore: formatU2uBalance(evidence.recipientBefore),
        confirmationClicks: evidence.confirmationClicks, verificationClicks: evidence.verificationClicks,
        requestCount: evidence.requestCount, network: evidence.network, resumeStage: state.stage })), contentType: 'application/json' });
    }
  }
});
