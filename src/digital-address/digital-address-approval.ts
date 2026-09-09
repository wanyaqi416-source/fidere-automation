import { expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { env } from '../config/env';
import { MoneyMutationGuard, assertSandboxEnvironment, requireExactlyOneCandidate, stageIndex } from '../flow-engine';
import { PersonalPostRegistrationJourneyStore } from '../journey';
import { openPersonalJourneyClientSession } from '../registration';
import type { BusinessReportApi } from '../reporting/business-report.types';
import { AdminShellPage } from '../../pages/admin/AdminShellPage';
import { AdminWhitelistReviewPage, type WhitelistDetail } from '../../pages/admin/AdminWhitelistReviewPage';
import { DigitalAddressPage } from '../../pages/client/DigitalAddressPage';
import { RegistrationKycStatusPage } from '../../pages/client/RegistrationKycStatusPage';
import { DIGITAL_ADDRESS_FLOW, DIGITAL_ASSETS, DigitalAddressRun, maskWalletAddress, matchDigitalAddresses,
  validateDigitalAddressInput, type DigitalAddressCandidate, type DigitalAddressFingerprint, type DigitalAssetKey } from './digital-address';

export async function executeDigitalAddressApproval(input: { browser: Browser; adminPage: Page; business: BusinessReportApi; testInfo: TestInfo }): Promise<void> {
  const { browser, adminPage, business, testInfo } = input;
  business.flow(DIGITAL_ADDRESS_FLOW);
  const runId = process.env.DIGITAL_ADDRESS_RUN_ID;
  const sourceRunId = process.env.DIGITAL_ADDRESS_SOURCE_RUN_ID;
  if (!runId || !sourceRunId || process.env.DIGITAL_ADDRESS_AUTHORIZED_RUN_ID !== runId) throw new Error('One named DIGITAL_ADDRESS_AUTHORIZED_RUN_ID is required.');
  if (process.env.DIGITAL_ADDRESS_SANDBOX_CONFIRMED !== 'true') throw new Error('A controlled Sandbox wallet must be explicitly configured; never invent a receiving address.');
  const source = new PersonalPostRegistrationJourneyStore(sourceRunId).load();
  if (!source || source.stage !== 'COMPLETED') throw new Error('Existing approved Journey required; no registration or funding.');
  const fingerprint: DigitalAddressFingerprint = { email: source.email, userId: '',
    address: process.env.DIGITAL_ADDRESS_VALUE ?? '', label: `AUTO DA ${runId}`,
    assetKey: (process.env.DIGITAL_ADDRESS_ASSET_KEY ?? '') as DigitalAssetKey };
  validateDigitalAddressInput(fingerprint);
  const key = env.client.securityKey;
  if (!key || !/^\d{6}$/.test(key)) throw new Error('CLIENT_SECURITY_KEY must be configured with six digits.');
  const switches = { ALLOW_CLIENT_MUTATION_TESTS: env.allowClientMutationTests, ALLOW_ADMIN_MUTATION_TESTS: env.allowAdminMutationTests };
  const guard = new MoneyMutationGuard(DIGITAL_ADDRESS_FLOW, true, true);
  guard.validateRuntime({ baseURL: env.client.baseUrl, workers: testInfo.config.workers, retries: testInfo.project.retries, repeatEach: testInfo.project.repeatEach, safetySwitches: switches });
  assertSandboxEnvironment(env.admin.baseUrl);
  const shell = new AdminShellPage(adminPage);
  await shell.goto(env.admin.baseUrl!);
  await shell.expectSessionActive();
  const admin = new AdminWhitelistReviewPage(adminPage);
  await admin.goto(env.admin.baseUrl!);
  const session = await openPersonalJourneyClientSession({ browser, baseURL: env.client.baseUrl!, runId: sourceRunId,
    email: source.email, password: env.client.password!, otp: env.client.otp!, forceFreshLogin: true });
  let run: DigitalAddressRun;
  try {
    await new RegistrationKycStatusPage(session.page).expectApproved({ ...source, runId: sourceRunId }, env.client.baseUrl!);
    run = new DigitalAddressRun(runId, { ...fingerprint, sourceRunId });
    if (run.state().stage === 'COMPLETED') throw new Error('This address Run is already completed; do not repeat.');
  } catch (error) { await session.context.close(); throw error; }
  let adminApproved = false;
  const client = new DigitalAddressPage(session.page);
  const advance = (stage: Parameters<DigitalAddressRun['advance']>[0], updates?: Parameters<DigitalAddressRun['advance']>[1]) => {
    if (stageIndex(run.state().stage) < stageIndex(stage)) run.advance(stage, updates);
    business.setBusinessData({ resumeStage: run.state().stage });
  };
  const detailMatches = (detail: WhitelistDetail) => {
    const asset = DIGITAL_ASSETS[fingerprint.assetKey];
    return Boolean(detail.userId) && detail.ownerEmail.toLowerCase() === fingerprint.email.toLowerCase() &&
      (!fingerprint.userId || detail.userId === fingerprint.userId) && detail.address === fingerprint.address && detail.asset === asset.asset && detail.network === asset.network && detail.label === fingerprint.label;
  };
  const collect = async (matchLabel = true) => {
    const rows: DigitalAddressCandidate[] = [];
    for (const status of ['待审核', '已通过', '已拒绝'] as const) {
      await admin.goto(env.admin.baseUrl!, status);
      rows.push(...await admin.collectCandidates(fingerprint.address));
    }
    const result = matchDigitalAddresses(rows, fingerprint, undefined, matchLabel);
    business.setBusinessData({ candidateStages: result.stages, digitalAddressCandidateCount: result.candidates.length });
    return result.candidates;
  };
  business.setBusinessData({ sourceRunId, digitalAddressName: fingerprint.label,
    digitalAddressAsset: fingerprint.assetKey, digitalAddressNetwork: DIGITAL_ASSETS[fingerprint.assetKey].network,
    digitalWalletMasked: maskWalletAddress(fingerprint.address), resumeStage: run.state().stage });
  try {
    await business.step({ action: '1. 原用户认证与地址去重', expected: 'Client KYC与Admin认证有效，保持原Journey；没有相同钱包/网络的历史申请。' }, async step => {
      guard.markAuthenticationReady(true, true);
      fingerprint.reference = run.state().adminReference ?? run.state().clientReference;
      if (!run.attempted('client')) expect((await collect(false)).length, 'An address already exists; never create a replacement').toBe(0);
      step.setActual(`原用户和Sandbox已核对；Resume起点 ${run.state().stage}。`);
    });
    await business.step({ action: '2. 新增地址与安全密钥一次验证', expected: '表单提交后复用SecurityKeyDialog；已尝试过的新增/验证不再次执行。' }, async step => {
      if (!run.attempted('client')) {
        await client.goto(env.client.baseUrl!);
        await client.openAddForm();
        await client.fill(fingerprint);
        await client.submitForSecurityOnce(() => {
          guard.assertClientMoneyConfirmationAllowed(switches);
          run.attempt('client');
          advance('CLIENT_SUBMIT_ATTEMPTED');
          guard.recordClientMoneyConfirmation();
          business.disallowSafeRerun();
        });
        const receipt = await client.verifyAndObserveCreation(key, () => {
          guard.assertSecurityKeyVerificationAllowed(switches);
          run.attempt('security');
          advance('SECURITY_KEY_VERIFICATION_ATTEMPTED', { clientSubmittedAt: new Date().toISOString() });
          guard.recordSecurityKeyVerification();
          business.markPotentiallySubmitted();
        });
        fingerprint.reference = receipt.reference;
        step.setActual('仅提交一次、验证一次；新增接口业务响应成功，继续读取真实白名单记录。');
      } else {
        step.setActual('Resume原地址：跳过新增和安全密钥验证，仅查找已提交记录。');
      }
    });
    await business.step({ action: '3. 唯一定位真实申请并复核详情', expected: '用户、完整地址、币种、网络、Run标签及原ID一致；候选严格等于1。' }, async step => {
      let candidates: DigitalAddressCandidate[] = [];
      await expect.poll(async () => {
        candidates = await collect();
        if (candidates.length > 1) throw new Error('Multiple whitelist candidates; no approval allowed.');
        return candidates.length;
      }, { timeout: 60_000, intervals: [1_000, 2_000, 5_000], message: 'DIGITAL_ADDRESS_CREATION_UNCONFIRMED: no replacement address allowed.' }).toBe(1);
      const candidate = requireExactlyOneCandidate(candidates, 'Digital address');
      const detail = await admin.openDetail(env.admin.baseUrl!, candidate.id);
      expect(detailMatches(detail), 'Whitelist detail fingerprint').toBe(true);
      fingerprint.userId = detail.userId;
      expect(['待审核', '已通过'].includes(detail.status), 'Original address must not be rejected').toBe(true);
      if (fingerprint.reference) expect(candidate.id === fingerprint.reference, 'Original reference unchanged').toBe(true);
      fingerprint.reference = candidate.id;
      advance('CLIENT_CREATED', { clientReference: candidate.id });
      advance('ADMIN_LOCATED', { adminReference: candidate.id });
      // On Resume, the immutable verification marker and observed original record restore the guard's evidence.
      if (!guard.snapshot().securityKeyVerifications) {
        if (!run.attempted('security')) throw new Error('No Security Key submission marker for this Run; do not claim another record.');
        guard.recordClientMoneyConfirmation();
        guard.recordSecurityKeyVerification();
      }
      guard.recordClientSubmission();
      guard.recordUniqueAdminCandidate(1);
      adminApproved = detail.status === '已通过';
      business.setBusinessData({ digitalWhitelistReference: `WHITELIST-****${candidate.id.slice(-4)}`, digitalAddressAdminBefore: detail.status });
      step.setActual('真实白名单记录唯一，用户/地址/资产/网络/标签详情复核通过。');
    });
    await business.step({ action: '4. Admin通过与确认通过', expected: '仅对原白名单审核一次；已通过或已尝试过的审核绝不重复。' }, async step => {
      if (!adminApproved && !run.attempted('admin')) {
        const detail = await admin.openDetail(env.admin.baseUrl!, fingerprint.reference!);
        expect(detailMatches(detail) && detail.status === '待审核', 'Final approval detail recheck').toBe(true);
        await admin.openApprovalConfirmation(fingerprint.address);
        await admin.confirmApproveOnce(() => {
          guard.assertAdminActionAllowed(switches);
          run.attempt('admin');
          advance('ADMIN_APPROVAL_SUBMISSION_ATTEMPTED');
          guard.recordAdminAction();
          business.markPotentiallySubmitted();
        });
      }
      await expect.poll(async () => {
        const detail = await admin.openDetail(env.admin.baseUrl!, fingerprint.reference!);
        if (!detailMatches(detail)) throw new Error('Original whitelist detail changed after approval.');
        return detail.status;
      }, { timeout: 60_000, intervals: [1_000, 2_000, 5_000], message: 'Original whitelist final approval state not confirmed; no repeated approval.' }).toBe('已通过');
      adminApproved = true;
      advance('ADMIN_ACTION_DONE');
      step.setActual('原地址Admin状态已通过；不会再次审核。');
    });
    await business.step({ action: '5. Client读取同一启用地址', expected: '重新加载地址管理后，同一Run标签、钱包、网络显示且启用。' }, async step => {
      await client.goto(env.client.baseUrl!);
      await client.expectApprovedAddress(fingerprint);
      advance('CLIENT_FINALIZED');
      advance('COMPLETED');
      business.recordPrimaryOracle({ id: 'digital-address-closed-loop', name: '数字资产地址审核闭环', expected: '原地址唯一、审核已通过、Client同一地址启用', actual: '创建与审核证据一致，Client同一地址已显示并启用', status: 'passed' });
      business.setBusinessData({ digitalAddressAdminAfter: '已通过', digitalAddressClientStatus: '可见且启用' });
      step.setActual('数字资产地址审核闭环完成；未执行任何数字资产转出。');
    });
  } catch (error) {
    business.setBusinessData({ resumeStage: run.state().stage });
    if (run.attempted('client')) business.disallowSafeRerun();
    if ((run.attempted('security') && !run.state().clientReference) || (run.attempted('admin') && !adminApproved)) business.requireManualReview('Only read the original whitelist state; never resubmit or repeat approval.');
    throw error;
  } finally {
    business.setBusinessData({ digitalAddressSubmissionCount: Number(run.attempted('client')),
      digitalAddressVerificationCount: Number(run.attempted('security')), digitalAddressApprovalCount: Number(run.attempted('admin')) });
    await session.context.close();
  }
}
