import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { test, expect } from '../../../fixtures/registration.fixture';
import { AdminShellPage } from '../../../pages/admin/AdminShellPage';
import { BrokerOpeningReviewPage, type BrokerOpeningRow } from '../../../pages/admin/BrokerOpeningReviewPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { RegistrationKycStatusPage } from '../../../pages/client/RegistrationKycStatusPage';
import { SecuritiesTradingPage } from '../../../pages/client/SecuritiesTradingPage';
import { WebullDocumentSigner } from '../../../pages/client/WebullDocumentSigner';
import { WebullOpeningPage } from '../../../pages/client/WebullOpeningPage';
import { resolveTigerOpeningUser } from '../../../src/broker-opening/tiger-runtime-user';
import { env } from '../../../src/config/env';
import {
  advanceFlowState,
  createPreparedFlowState,
  FlowStateStore,
  MoneyMutationGuard,
  requireExactlyOneCandidate
} from '../../../src/flow-engine';
import { matchWebullOpening } from '../../../src/journey/tiger-opening';
import { assessWebullFunding, WEBULL_BROKER_NAME, WEBULL_DOCUMENTS } from '../../../src/journey/webull-opening';
import { maskRegistrationEmail } from '../../../src/registration';
import { Decimal } from '../../../src/utils/money';
import { getClientSecurityKey } from '../../../src/utils/security-key';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });

test('OPEN-WEBULL-004 standalone fresh Webull opening and approval @money @mutation @L4', async ({ browser, adminPage, business }, testInfo) => {
  test.setTimeout(420_000);
  const sourceRunId = process.env.BROKER_SOURCE_RUN_ID;
  const runtimeEmail = process.env.WEBULL_TEST_EMAIL?.trim().toLowerCase();
  const runId = process.env.BROKER_OPENING_RUN_ID;
  const authorizedFee = process.env.BROKER_AUTHORIZED_FEE;
  const brokerAccountNumber = process.env.BROKER_OPENING_ACCOUNT_NUMBER;
  const openingDate = process.env.BROKER_OPENING_DATE;
  if (!sourceRunId || !runtimeEmail || !runId || !authorizedFee || !brokerAccountNumber || !openingDate) {
    throw new Error('WEBULL_OPENING_RUNTIME_CONFIG_REQUIRED');
  }
  const flowId = 'webull-broker-opening';
  const resumeAdmin = process.env.BROKER_OPENING_MODE === 'resume-admin';
  const resumeSecuritySetup = process.env.BROKER_OPENING_MODE === 'resume-security-setup';
  const switches: Record<string, boolean> = resumeAdmin
    ? { ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests }
    : {
        ALLOW_MONEY_TESTS: env.exchange.allowMoneyTests,
        ALLOW_CLIENT_MUTATION_TESTS: process.env.ALLOW_CLIENT_MUTATION_TESTS === 'true',
        ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests
      };
  const guard = new MoneyMutationGuard(flowId, true, true);
  for (const baseURL of [env.client.baseUrl, env.admin.baseUrl]) {
    guard.validateRuntime({
      baseURL,
      workers: testInfo.config.workers,
      retries: testInfo.project.retries,
      repeatEach: testInfo.project.repeatEach,
      safetySwitches: switches
    });
  }
  expect(testInfo.retry + testInfo.repeatEachIndex).toBe(0);
  getClientSecurityKey();

  const shell = new AdminShellPage(adminPage);
  await shell.goto(env.admin.baseUrl!);
  await shell.expectSessionActive();
  const source = await resolveTigerOpeningUser({
    adminPage,
    adminBaseUrl: env.admin.baseUrl!,
    sourceRunId,
    runtimeEmail
  });
  const root = resolve('.flow-state', 'broker-journeys', sourceRunId);
  const store = new FlowStateStore(root);
  let state = store.load(flowId, runId) ?? createPreparedFlowState({ runId, flowId });
  if (resumeAdmin && (!['ADMIN_LOCATED', 'ADMIN_APPROVAL_CONFIRMATION_REQUIRED'].includes(state.stage)
    || !state.adminReference || !state.clientSubmittedAt)) {
    throw new Error('WEBULL_ADMIN_RESUME_STATE_INVALID');
  }
  if (resumeSecuritySetup && state.stage !== 'SECURITY_KEY_VERIFICATION_ATTEMPTED') {
    throw new Error('WEBULL_SECURITY_SETUP_RESUME_STATE_INVALID');
  }
  if (!resumeAdmin && !resumeSecuritySetup && !['PREPARED', 'DOCUMENT_SIGNED'].includes(state.stage)) {
    throw new Error('WEBULL_OPENING_RECONCILIATION_REQUIRED');
  }
  store.save(state);
  const attempts = resolve(root, flowId, runId);
  const markAttempt = (action: string) => {
    mkdirSync(attempts, { recursive: true });
    writeFileSync(resolve(attempts, `${action}.attempt`), new Date().toISOString(), { flag: 'wx' });
  };

  business.flow(flowId, { caseId: 'OPEN-WEBULL-004', name: '微牛证券双文档开户与管理端审核' });
  business.setBusinessData({
    runId,
    sourceRunId,
    registrationTestName: source.displayName,
    maskedLogin: maskRegistrationEmail(source.email),
    accountType: '香港账户',
    currency: 'USD',
    openingFeeAmount: authorizedFee,
    confirmationClicks: 0,
    securityVerificationClicks: 0,
    approvalClicks: 0
  });

  const admin = new BrokerOpeningReviewPage(adminPage);
  await admin.goto(env.admin.baseUrl!);
  await admin.searchEmail(source.email);
  const existing = matchWebullOpening(await admin.collectRows(), {
    ...source,
    reference: resumeAdmin ? state.adminReference : undefined,
    submittedFrom: resumeAdmin ? state.clientSubmittedAt : undefined,
    submittedTo: resumeAdmin ? state.clientSubmittedAt : undefined
  });
  expect(existing.candidates).toHaveLength(resumeAdmin ? 1 : 0);

  const client = await RegistrationKycStatusPage.cleanLogin({
    browser,
    baseURL: env.client.baseUrl!,
    email: source.email,
    password: env.client.password!,
    otp: env.client.otp!
  });
  const page = client.statusPage.page;
  page.setDefaultTimeout(25_000);
  const opening = new WebullOpeningPage(page);
  const accounts = new AccountDetailPage(page);
  const securities = new SecuritiesTradingPage(page);
  let candidate: BrokerOpeningRow | undefined;
  let beforeBalance = '';
  let adminStatus = '';
  let clientSubmissionNetwork: Array<{ method: string; path: string; status: number }> = [];
  let latestAdminCandidateCount = 0;
  try {
    await new RegistrationKycStatusPage(page).expectApproved({ ...source, runId: sourceRunId }, env.client.baseUrl!);
    guard.markAuthenticationReady(true, true);
    await accounts.goto(env.client.baseUrl!);
    const before = await accounts.readSnapshot('香港账户', 'USD');
    beforeBalance = before.available;

    if (resumeAdmin) {
      candidate = requireExactlyOneCandidate(existing.candidates, 'Original Webull Resume');
      guard.recordClientMoneyConfirmation();
      guard.recordSecurityKeyVerification();
      guard.recordClientSubmission();
      guard.recordUniqueAdminCandidate(1);
    } else {
      await business.step({
        action: '1. 检查微牛开户状态、实际费用和香港美元余额',
        expected: '当前用户尚未开通微牛，页面费用与授权一致，余额足够且没有历史申请。'
      }, async step => {
        const { card, fee } = await opening.open(env.client.baseUrl!);
        expect(card.status).toBe('待开户');
        expect(fee.currency).toBe('USD');
        expect(new Decimal(fee.amount).equals(authorizedFee)).toBe(true);
        expect(assessWebullFunding({ available: before.available, fee: fee.amount, currency: fee.currency }).status)
          .toBe('BALANCE_READY');
        state = { ...state, amount: fee.amount, currency: fee.currency };
        store.save(state);
        await opening.opening.continueWebullToDocuments();
        step.setActual(`微牛状态为待开户；开户费 ${fee.amount} USD；香港账户可用余额 ${before.available} USD。`);
      });

      for (const definition of WEBULL_DOCUMENTS) {
        await business.step({
          action: `签署 ${definition.label}`,
          expected: '使用微牛独立签署器完成 TEST 签名、Complete、Sign，并等待 Fidere 确认该文档已完成。'
        }, async step => {
          const documentFlow = `webull-document-${definition.id}`;
          const saved = store.load(documentFlow, runId);
          if (saved?.stage === 'DOCUMENT_SIGNED') {
            const result = await opening.restoreExistingSignedDocument(definition.id);
            step.setActual(`${definition.label} 已由原 Run 完成，本次仅恢复并确认签署状态。`);
            step.setBusinessData({ safeRequestEvidence: JSON.stringify(result) });
            return;
          }
          const prefix = definition.id === 'w8ben' ? 'w8' : 'crs';
          if (existsSync(resolve(attempts, `${prefix}-final-sign.attempt`))) {
            const result = await opening.restoreExistingSignedDocument(definition.id);
            let recovered = createPreparedFlowState({ runId, flowId: documentFlow });
            recovered = advanceFlowState(recovered, 'DOCUMENT_SIGNED', {
              clientReference: result.documentReference
            });
            store.save(recovered);
            step.setActual(`${definition.label} 的原 Sign 已执行；本次只读确认 signed=true 并恢复状态，未重复签署。`);
            step.setBusinessData({ safeRequestEvidence: JSON.stringify(result) });
            return;
          }
          if (existsSync(resolve(attempts, `${prefix}-complete.attempt`))) {
            throw new Error(`WEBULL_SIGNING_RESULT_UNCERTAIN: ${definition.id}; duplicate signing forbidden.`);
          }
          const entry = await opening.signingEntry(definition.id);
          await entry.click();
          const signer = new WebullDocumentSigner(page, definition.id);
          const attached = await signer.attach(source.displayName);
          expect(attached.alreadySigned).toBe(false);
          const prepared = await signer.prepare();
          markAttempt(`${prefix}-complete`);
          await signer.complete();
          markAttempt(`${prefix}-final-sign`);
          step.disallowSafeRerun();
          const completed = await signer.confirm();
          business.markMutationPerformed(`${definition.label} final Sign completed`);
          await opening.finishNewSignedDocument(definition.id);
          let documentState = createPreparedFlowState({ runId, flowId: documentFlow });
          documentState = advanceFlowState(documentState, 'DOCUMENT_SIGNED', {
            clientReference: attached.documentReference
          });
          store.save(documentState);
          const counts = signer.counts();
          expect(counts).toEqual({ fieldSign: 1, complete: 1, sign: 1 });
          step.setActual(`${definition.label} 已真实签署；剩余字段 ${prepared.requiredFieldsAfter}；Complete 1 次；Sign 1 次；Fidere 已确认。`);
          step.setBusinessData({
            documentReference: attached.documentReference,
            remainingFields: prepared.requiredFieldsAfter,
            signatureMethod: prepared.signatureMethod,
            completionEvidence: JSON.stringify(completed)
          });
        });
      }
      if (state.stage === 'PREPARED') {
        state = advanceFlowState(state, 'DOCUMENT_SIGNED');
        store.save(state);
      }

      const submittedFrom = new Date().toISOString();
      await business.step({
        action: '4. 核对双文档并提交微牛开户申请',
        expected: '两份文档均已完成，开户提交和安全密钥验证各执行一次。'
      }, async step => {
        await opening.prepareReview();
        guard.assertClientMoneyConfirmationAllowed(switches);
        if (!resumeSecuritySetup) {
          markAttempt('fee-confirmation');
          state = advanceFlowState(state, 'FEE_CONFIRMATION_ATTEMPTED');
          store.save(state);
        }
        guard.recordClientMoneyConfirmation();
        await opening.confirmSubmissionOnce();
        const securityKey = getClientSecurityKey();
        const setup = await opening.opening.securityKey.configureIfRequired(securityKey);
        if (setup.required) {
          if (setup.dialogClosed) {
            await opening.opening.confirmFeeAfterSecuritySetupOnce();
          } else if (!setup.verificationReady) {
            throw new Error('Webull Security Key setup did not reach verification or completion.');
          }
        }
        await opening.opening.securityKey.fill(securityKey);
        guard.assertSecurityKeyVerificationAllowed(switches);
        if (!resumeSecuritySetup) {
          markAttempt('security-verification');
          state = advanceFlowState(state, 'SECURITY_KEY_VERIFICATION_ATTEMPTED', {
            clientSubmittedAt: new Date().toISOString()
          });
          store.save(state);
        }
        step.markPotentiallySubmitted();
        guard.recordSecurityKeyVerification();
        clientSubmissionNetwork = await opening.verifySecurityKeyOnce();
        step.setActual(`两份签署文档均已确认；安全密钥设置动作 ${setup.actionClickCount} 次；安全密钥验证 1 次。`);
        step.setBusinessData({
          securityKeySetupActions: setup.actionClickCount,
          postSetupConfirmationClicks: opening.opening.postSetupConfirmationClickCount(),
          clientSubmissionNetwork: JSON.stringify(clientSubmissionNetwork)
        });
      });
      const submittedTo = new Date().toISOString();
      await business.step({
        action: '5. 在管理端唯一定位本次微牛开户申请',
        expected: '根据用户、券商、账户类型和提交时间唯一找到一条本次申请。'
      }, async step => {
        try {
          await expect.poll(async () => {
            await admin.goto(env.admin.baseUrl!);
            await admin.searchEmail(source.email);
            const matched = matchWebullOpening(await admin.collectRows(), {
              ...source,
              submittedFrom,
              submittedTo
            });
            latestAdminCandidateCount = matched.candidates.length;
            step.setBusinessData({ candidateStages: JSON.stringify(matched.stages), candidateCount: latestAdminCandidateCount });
            if (latestAdminCandidateCount > 1) throw new Error('Multiple Webull candidates; approval forbidden.');
            candidate = matched.candidates[0];
            return latestAdminCandidateCount;
          }, { timeout: 45_000, intervals: [1000, 2000, 5000] }).toBe(1);
        } catch (error) {
          await securities.goto(env.client.baseUrl!);
          const clientStatus = await securities.readBrokerStatus(WEBULL_BROKER_NAME);
          throw new Error(
            `WEBULL_SUBMISSION_UNCONFIRMED: Client status=${clientStatus}; Admin candidateCount=${latestAdminCandidateCount}; `
            + `observed mutation responses=${JSON.stringify(clientSubmissionNetwork)}. No repeat submission is allowed.`,
            { cause: error }
          );
        }
        if (!candidate?.reference) throw new Error('WEBULL_SUBMISSION_UNCONFIRMED');
        guard.assertClientSubmissionAllowed(switches);
        guard.recordClientSubmission();
        state = advanceFlowState(state, 'CLIENT_CREATED', {
          clientReference: candidate.reference,
          adminReference: candidate.reference,
          clientSubmittedAt: submittedTo
        });
        store.save(state);
        guard.recordUniqueAdminCandidate(1);
        state = advanceFlowState(state, 'ADMIN_LOCATED');
        store.save(state);
        step.setActual(`唯一找到本次微牛开户申请，申请编号 ${candidate.reference}。`);
      });
    }

    await business.step({
      action: '6. 管理端核对并审核通过微牛开户申请',
      expected: '申请详情与当前用户一致，审核通过只执行一次。'
    }, async step => {
      if (!candidate) throw new Error('No unique Webull candidate.');
      await admin.verifyDetail(candidate, source, 'WEBULL');
      await admin.fillApprovalForm(candidate, `AUTO_WEBULL_APPROVE_${runId}`);
      await admin.openApprovalConfirmationOnce();
      if (state.stage !== 'ADMIN_APPROVAL_CONFIRMATION_REQUIRED') {
        state = advanceFlowState(state, 'ADMIN_APPROVAL_CONFIRMATION_REQUIRED');
        store.save(state);
      }
      await admin.fillApprovalConfirmation({
        accountName: source.displayName,
        accountNumber: brokerAccountNumber,
        openingDate
      });
      guard.assertAdminActionAllowed(switches);
      markAttempt('admin-approval');
      state = advanceFlowState(state, 'ADMIN_APPROVAL_SUBMISSION_ATTEMPTED');
      store.save(state);
      guard.recordAdminAction();
      await admin.approveOnce();
      await expect.poll(async () => {
        await admin.goto(env.admin.baseUrl!);
        await admin.searchEmail(source.email);
        const matched = matchWebullOpening(await admin.collectRows(), { ...source, reference: candidate!.reference });
        if (matched.candidates.length !== 1) return '';
        adminStatus = requireExactlyOneCandidate(matched.candidates, 'Approved Webull application').status;
        return adminStatus;
      }, { timeout: 45_000, intervals: [1000, 2000, 5000] }).toMatch(/^(已开户|审核通过|已通过|已批准)$/);
      state = advanceFlowState(state, 'ADMIN_ACTION_DONE');
      store.save(state);
      step.setActual(`管理端状态已更新为 ${adminStatus}；审核通过 1 次。`);
    });

    await business.step({
      action: '7. 返回客户端验证微牛最终开户状态',
      expected: '同一用户的微牛证券状态更新为已开通，不产生重复申请。'
    }, async step => {
      let clientStatus = '';
      await expect.poll(async () => {
        await securities.goto(env.client.baseUrl!);
        clientStatus = await securities.readBrokerStatus(WEBULL_BROKER_NAME);
        return clientStatus;
      }, { timeout: 45_000, intervals: [1000, 2000, 5000] }).toMatch(/^(已开通|已开户)$/);
      state = advanceFlowState(state, 'CLIENT_FINALIZED');
      store.save(state);
      state = advanceFlowState(state, 'COMPLETED');
      store.save(state);
      step.setActual(`客户端微牛证券状态为 ${clientStatus}；管理端状态为 ${adminStatus}。`);
      step.recordPrimaryOracle({
        id: 'webull-opening-completed',
        name: '微牛开户审核闭环',
        expected: '双文档签署、单次提交、唯一申请、Admin 通过、Client 已开通',
        actual: `Admin=${adminStatus}; Client=${clientStatus}`,
        status: 'passed'
      });
    });

    try {
      await accounts.goto(env.client.baseUrl!);
      const after = await accounts.readSnapshot('香港账户', 'USD');
      business.recordDiagnostic({
        id: 'webull-fee-observation',
        name: '微牛开户费余额观察',
        status: 'available',
        summary: `香港 USD ${beforeBalance} -> ${after.available}；变化 ${new Decimal(beforeBalance).minus(after.available).toFixed(2)}。`,
        affectsCoreBusiness: false
      });
    } catch {
      business.recordDiagnostic({
        id: 'webull-fee-observation',
        name: '微牛开户费余额观察',
        status: 'unavailable',
        summary: '开户双端终态已确认，余额展示未作为核心结论。',
        affectsCoreBusiness: false
      });
    }
  } catch (error) {
    if (['SECURITY_KEY_VERIFICATION_ATTEMPTED', 'ADMIN_APPROVAL_SUBMISSION_ATTEMPTED'].includes(state.stage)) {
      business.requireManualReview('仅核对当前微牛申请；禁止重复签署、提交、安全验证或审批。');
    }
    throw error;
  } finally {
    business.setResumeState(state.stage);
    business.setBusinessData({
      confirmationClicks: opening.confirmationClickCount(),
      securityVerificationClicks: opening.opening.securityKey.verificationClickCount(),
      approvalClicks: admin.approvalClickCount(),
      adminReference: state.adminReference
    });
    await client.context.close();
  }
});
