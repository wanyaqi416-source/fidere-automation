import { expect, test, type TestInfo } from '@playwright/test';
import type { BusinessReportApi, BusinessStepContext, BusinessOracleInput } from '../../src/reporting/business-report.types';
import { sanitizeBusinessData } from '../../src/reporting/sensitive-data-mask';
import { RegistrationAdminApprovalJourneyStore } from '../../src/registration/registration-admin-approval-journey';
import { completeRegistrationKyc, type RegistrationKycDriver } from '../../src/registration/registration-kyc-approval';
import { assertRegistrationCaseIdentity, decodeClientKycStatus, decodeRegistrationKycCase, REGISTRATION_KYC,
  type RegistrationAccountType, type RegistrationKycCase, type RegistrationKycSource } from '../../src/registration/registration-kyc-contract';
import { RegistrationReviewDashboardPage } from '../../pages/admin/RegistrationReviewDashboardPage';

function fixture(info: TestInfo, accountType: RegistrationAccountType = 'PERSONAL') {
  const source: RegistrationKycSource = { accountType, runId: 'REG-KYC-LOCAL', email: 'case@sandbox.test',
    displayName: 'TEST SANDBOX AC', userId: '100', clientSubmittedAt: '2026-09-07T00:00:00Z' };
  const store = new RegistrationAdminApprovalJourneyStore(REGISTRATION_KYC[accountType].storageType, source.runId, info.outputPath('state'));
  let current: RegistrationKycCase = { ...source, userId: '100', reviewId: '200',
    processPath: `/zh-CN/kyc/processingReviews/100/${accountType === 'BUSINESS' ? 'enterprise' : 'personal'}/process?reviewId=200`,
    step: accountType === 'BUSINESS' ? 'application_review' : 'info_review', status: '待审核',
    approved: false, rejected: false, signed: true, completedSteps: ['await_info', 'submit_info'] };
  const clicks: string[] = [];
  const oracles: BusinessOracleInput[] = [];
  let manualReview = false;
  let cleanLogins = 0;
  const business: BusinessReportApi = {
    flow() {}, case() {}, plan() {}, setBusinessData() {}, setCurrentUrl() {}, setResumeState() {},
    setDocumentProgress() {}, markMutationPerformed() {}, markPotentiallySubmitted() {},
    markDuplicateSubmissionRisk() {}, disallowSafeRerun() {}, warn() {}, recordDiagnostic() {},
    requireManualReview() { manualReview = true; },
    recordPrimaryOracle(oracle) { oracles.push(oracle); }, recordSecondaryOracle() {},
    async step(_, body) { return body({ ...business, setActual() {}, setCurrentAction() {} } as BusinessStepContext); }
  };
  const driver: RegistrationKycDriver = {
    async preflight() {},
    async locate() { return { candidateCount: 1, candidate: current, stages: [{ field: 'email/type', count: 1 }] }; },
    async readOriginal() { return current; },
    async prepareApproval() {},
    async approveOnce() {
      expect(store.load()?.approvalAttempts?.some(item => item.step === current.step)).toBe(true);
      clicks.push(current.step);
      current = { ...current, completedSteps: [...current.completedSteps, current.step],
        step: accountType === 'PERSONAL' ? 'doc_review' : 'application_review',
        approved: current.step !== 'info_review', status: current.step !== 'info_review' ? '审核通过' : '待审核' };
      return { requestPath: '/admin-api/member/review', httpStatus: 200 };
    },
    async waitForAdvance() { return current; },
    async verifyClientWithCleanLogin() { cleanLogins++; return { approved: true, status: '1', observedAt: new Date().toISOString() }; }
  };
  const runtime = { baseURL: 'https://admin.sandbox.test', workers: 1, retries: 0, repeatEach: 1,
    safetySwitches: { ALLOW_ADMIN_MUTATION_TESTS: true } };
  return { source, store, business, driver, runtime, clicks, oracles,
    setCase(value: Partial<RegistrationKycCase>) { current = { ...current, ...value }; },
    getCase: () => current, isManual: () => manualReview, cleanLogins: () => cleanLogins,
    run: (allowedSteps?: string[]) => completeRegistrationKyc({ source, store, driver, business, runtime, allowedSteps }) };
}

test.describe('Registration shared KYC tail @readonly @L2', () => {
  for (const accountType of ['PERSONAL', 'BUSINESS'] as const) {
    test(`${accountType} uses its tab, pins one case, approves actual stages and cleanly logs in`, async ({}, info) => {
      const f = fixture(info, accountType);
      const result = await f.run();
      expect(f.clicks).toEqual([...REGISTRATION_KYC[accountType].approvalSteps]);
      expect(result.reviewId).toBe('200');
      expect(result.stage).toBe('COMPLETED');
      expect(result.kycStage).toBe('CLIENT_KYC_APPROVED');
      expect(result.kycVerifiedAt).toBeTruthy();
      expect(f.cleanLogins()).toBe(1);
      expect(f.isManual()).toBe(false);
      const before = f.clicks.length;
      await f.run();
      expect(f.clicks).toHaveLength(before);
      expect(f.cleanLogins()).toBe(2);
    });
    test(`${accountType} dashboard access with KYC pending cannot pass`, async ({}, info) => {
      const f = fixture(info, accountType);
      f.driver.verifyClientWithCleanLogin = async () => ({ approved: false, status: '3', observedAt: '' });
      await expect(f.run()).rejects.toThrow('CLIENT_KYC_NOT_APPROVED');
      expect(f.store.load()?.kycStage).toBe('KYC_APPROVED');
      expect(f.store.load()?.kycVerifiedAt).toBeUndefined();
      expect(f.isManual()).toBe(false);
    });
  }

  for (const count of [0, 2]) {
    test(`candidateCount=${count} cannot approve or substitute another user`, async ({}, info) => {
      const f = fixture(info);
      f.driver.locate = async () => ({ candidateCount: count, stages: [{ field: 'email', count }] });
      await expect(f.run()).rejects.toThrow('KYC_CANDIDATE_NOT_UNIQUE');
      expect(f.clicks).toHaveLength(0);
      expect(f.store.load()?.sourceRunId).toBe(f.source.runId);
    });
  }

  test('same email with a different pinned reviewId cannot approve', async ({}, info) => {
    const f = fixture(info);
    f.source.reviewId = '201';
    await expect(f.run()).rejects.toThrow('KYC_CASE_IDENTITY_MISMATCH');
    expect(f.clicks).toHaveLength(0);
  });

  test('identity or accountType mismatch cannot open a mutation', async ({}, info) => {
    const f = fixture(info);
    f.setCase({ accountType: 'BUSINESS' });
    await expect(f.run()).rejects.toThrow('KYC_CASE_IDENTITY_MISMATCH');
    expect(f.clicks).toHaveLength(0);
  });

  test('second stage can require separate authorization without repeating the first', async ({}, info) => {
    const f = fixture(info);
    await expect(f.run(['info_review'])).rejects.toThrow('KYC_NEW_STAGE_REQUIRES_AUTHORIZATION');
    expect(f.clicks).toEqual(['info_review']);
    expect(f.store.load()?.approvalAttempts?.[0].confirmedAt).toBeTruthy();
    expect(f.isManual()).toBe(false);
    await f.run(['doc_review']);
    expect(f.clicks).toEqual(['info_review', 'doc_review']);
  });

  test('unknown review stages never get an automatic approval', async ({}, info) => {
    const f = fixture(info);
    f.setCase({ step: 'new_compliance_review' });
    await expect(f.run()).rejects.toThrow('KYC_NEW_STAGE_REQUIRES_AUTHORIZATION');
    expect(f.clicks).toHaveLength(0);
  });

  test('uncertain approval is persisted and cannot be clicked again on Resume', async ({}, info) => {
    const f = fixture(info);
    f.driver.approveOnce = async () => { f.clicks.push('info_review'); throw new Error('UI timeout'); };
    f.driver.waitForAdvance = async () => { throw new Error('state unavailable'); };
    await expect(f.run()).rejects.toThrow('state unavailable');
    expect(f.isManual()).toBe(true);
    expect(f.store.load()?.approvalAttempts).toHaveLength(1);
    await expect(f.run()).rejects.toThrow('KYC_APPROVAL_ALREADY_ATTEMPTED');
    expect(f.clicks).toEqual(['info_review']);
  });

  test('legacy aggregate initial approval never authorizes another initial click', async ({}, info) => {
    const f = fixture(info);
    let state = f.store.initialize({ flowId: 'personal-registration-admin-approval', sourceRunId: f.source.runId,
      displayName: f.source.displayName, email: f.source.email });
    state = f.store.advance(state, 'ADMIN_LOCATED', { reviewId: '200' });
    f.store.recordApproveAttempt(state);
    await expect(f.run()).rejects.toThrow('LEGACY_KYC_APPROVAL_UNCONFIRMED');
    expect(f.clicks).toHaveLength(0);
  });

  test('legacy Dashboard-only COMPLETED is not treated as Client KYC evidence', async ({}, info) => {
    const f = fixture(info);
    const state = f.store.initialize({ flowId: 'personal-registration-admin-approval', sourceRunId: f.source.runId,
      displayName: f.source.displayName, email: f.source.email });
    f.store.advance(state, 'COMPLETED', { clientFinalState: 'Dashboard' });
    f.setCase({ approved: true, status: '审核通过' });
    await f.run();
    expect(f.cleanLogins()).toBe(1);
    expect(f.store.load()?.kycVerifiedAt).toBeTruthy();
    expect(f.clicks).toHaveLength(0);
  });

  for (const change of ['switch', 'workers', 'retries', 'repeatEach', 'host', 'auth'] as const) {
    test(`preflight rejects unsafe ${change} before any Admin action`, async ({}, info) => {
      const f = fixture(info);
      if (change === 'switch') f.runtime.safetySwitches.ALLOW_ADMIN_MUTATION_TESTS = false;
      if (change === 'workers') f.runtime.workers = 2;
      if (change === 'retries') f.runtime.retries = 1;
      if (change === 'repeatEach') f.runtime.repeatEach = 2;
      if (change === 'host') f.runtime.baseURL = 'https://production.example.com';
      if (change === 'auth') f.driver.preflight = async () => { throw new Error('Admin expired'); };
      await expect(f.run()).rejects.toThrow();
      expect(f.clicks).toHaveLength(0);
    });
  }

  test('state cannot discard an attempted step or switch user/reviewId', async ({}, info) => {
    const f = fixture(info);
    await f.run();
    const state = f.store.load()!;
    expect(() => f.store.updateKyc(state, { approvalAttempts: [] })).toThrow('journal cannot be reset');
    expect(() => f.store.updateKyc(state, { reviewId: '201' })).toThrow('cannot switch');
    expect(() => f.store.updateKyc(state, { userId: '999' })).toThrow('cannot switch');
  });

  test('Client status is type-specific and never exposes session secrets', () => {
    const body = { user: { email: 'case@sandbox.test' }, entityType: '2', kyc_status: '0', kyb_status: '1', accessToken: 'secret-value' };
    const status = decodeClientKycStatus(body, { accountType: 'BUSINESS', email: 'case@sandbox.test' });
    expect(status.approved).toBe(true);
    expect(JSON.stringify(status)).not.toContain('secret-value');
    expect(() => decodeClientKycStatus(body, { accountType: 'PERSONAL', email: 'case@sandbox.test' })).toThrow();
  });

  test('KYB uses application state, not the unrelated module display flags', () => {
    const path = '/zh-CN/kyc/processingReviews/100/enterprise/process?reviewId=200';
    const data = { application: { id: 300, userId: 100, email: 'case@sandbox.test', companyNameEn: 'TEST SANDBOX AC', statusText: '待审核' },
      eSignature: { status: 1 }, flowModules: [{ filled: 0, validated: 0, approved: 0 }] };
    expect(decodeRegistrationKycCase('BUSINESS', { data }, path).approved).toBe(false);
    data.application.statusText = '审核通过';
    expect(decodeRegistrationKycCase('BUSINESS', { data }, path).approved).toBe(true);
  });

  test('Personal info approval alone is not completion while doc_review is pending', () => {
    const path = '/zh-CN/kyc/processingReviews/100/personal/process?reviewId=200';
    const data = { userId: 100, reviewId: 200, reviewStep: 'doc_review',
      member: { email: 'case@sandbox.test', fullName: 'TEST SANDBOX AC', kycStatus: 3 },
      kyc: { clientAuthorizationStatus: 1 },
      stages: [{ stage: 'info_review', status: 'approved', statusLabel: '审核通过' },
        { stage: 'doc_review', status: 'pending', statusLabel: '待审核' }] };
    expect(decodeRegistrationKycCase('PERSONAL', { data }, path).approved).toBe(false);
    data.stages[1].status = 'approved';
    expect(decodeRegistrationKycCase('PERSONAL', { data }, path).approved).toBe(false);
    data.member.kycStatus = 1;
    expect(decodeRegistrationKycCase('PERSONAL', { data }, path).approved).toBe(true);
    data.userId = 999;
    expect(() => decodeRegistrationKycCase('PERSONAL', { data }, path)).toThrow('USER_ID_MISMATCH');
  });

  test('a different Corporate application under the same user cannot replace the original', async ({}, info) => {
    const f = fixture(info, 'BUSINESS');
    expect(() => assertRegistrationCaseIdentity(f.source, { ...f.getCase(), applicationId: '301' },
      { applicationId: '300' })).toThrow('Corporate application changed');
  });

  test('legal name formatting is accepted but a different name is not', async ({}, info) => {
    const f = fixture(info);
    expect(() => assertRegistrationCaseIdentity(f.source, { ...f.getCase(), displayName: 'test  sandbox AC' })).not.toThrow();
    expect(() => assertRegistrationCaseIdentity(f.source, { ...f.getCase(), displayName: 'TEST SANDBOX AB' })).toThrow();
  });

  test('KYC report includes masked references and stage attempts without secrets', () => {
    const safe = sanitizeBusinessData({ registrationLoginIdentity: 'ca***@sandbox.test', registrationReviewId: '****00',
      registrationKycApprovalAttempts: [{ step: 'doc_review', attempts: 1, confirmed: true }],
      adminKycTab: '个人用户', password: 'do-not-include', cookie: 'do-not-include' });
    expect(safe.registrationReviewId).toBe('****00');
    expect(safe.registrationKycApprovalAttempts).toHaveLength(1);
    expect(JSON.stringify(safe)).not.toContain('do-not-include');
  });

  test('workbench scopes pending vs rejected tables and chooses BUSINESS tab', async ({ page }) => {
    await page.setContent(`<button role="tab" aria-selected="false">个人用户</button><button role="tab" aria-selected="false">企业用户</button>
      <div><input placeholder="搜索客户名称、审核类型..."><table><thead><tr><th>客户信息</th><th>提交日期</th></tr></thead>
      <tbody><tr><td>TEST SANDBOX AC case@sandbox.test 待审核</td><td>2026-09-07 12:00:00
      <a href="https://admin.sandbox.test/detail">查看详情</a>
      <a href="https://admin.sandbox.test/zh-CN/kyc/processingReviews/100/enterprise/process?reviewId=200">开始处理</a></td></tr></tbody></table>
      <button aria-label="Go to previous page" disabled></button><button aria-label="Go to next page" disabled></button></div>
      <div><input placeholder="搜索客户名称、审核类型..."><table><thead><tr><th>拒绝原因</th></tr></thead><tbody><tr><td>ignored</td></tr></tbody></table>
      <button aria-label="Go to next page" disabled></button></div>
      <script>for(const button of document.querySelectorAll('[role=tab]'))button.onclick=()=>button.setAttribute('aria-selected','true')</script>`);
    const result = await new RegistrationReviewDashboardPage(page).locateUniquePendingCandidate({
      accountType: 'corporate', email: 'case@sandbox.test', displayName: 'TEST SANDBOX AC', reviewId: '200'
    });
    expect(result.candidateCount).toBe(1);
    expect(result.candidates[0].reviewId).toBe('200');
    await expect(page.getByRole('tab', { name: '企业用户', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: '个人用户', exact: true })).toHaveAttribute('aria-selected', 'false');
  });

  test('pagination scans past an empty filtered slice and finds duplicate cases', async ({ page }) => {
    await page.setContent(`<button role="tab" aria-selected="false">个人用户</button><button role="tab" aria-selected="false">企业用户</button>
      <div><input placeholder="搜索客户名称、审核类型..."><table><thead><tr><th>客户信息</th><th>提交日期</th></tr></thead><tbody id="rows"></tbody></table>
      <p class="MuiTablePagination-displayedRows" id="range"></p>
      <button id="previous" aria-label="Go to previous page"></button><button id="next" aria-label="Go to next page"></button></div>
      <div><input placeholder="搜索客户名称、审核类型..."><table><thead><tr><th>拒绝原因</th></tr></thead></table></div>
      <script>
      let index=0;
      function render(){
        document.getElementById('range').textContent=(index+1)+' of 3';
        document.getElementById('previous').disabled=index===0;
        document.getElementById('next').disabled=index===2;
        document.getElementById('rows').innerHTML=index===1?'<tr><td colspan="2">No data available</td></tr>':
          '<tr><td>TEST SANDBOX AC case@sandbox.test 待审核</td><td>2026-09-07 12:00:00 '+
          '<a href="https://admin.sandbox.test/detail">查看详情</a> '+
          '<a href="https://admin.sandbox.test/zh-CN/kyc/processingReviews/100/enterprise/process?reviewId='+(200+index)+'">开始处理</a></td></tr>';
      }
      document.getElementById('previous').onclick=()=>{index--;render()};
      document.getElementById('next').onclick=()=>{index++;render()};
      for(const button of document.querySelectorAll('[role=tab]'))button.onclick=()=>button.setAttribute('aria-selected','true');
      render();</script>`);
    const result = await new RegistrationReviewDashboardPage(page).locateUniquePendingCandidate({
      accountType: 'corporate', email: 'case@sandbox.test', displayName: 'TEST SANDBOX AC'
    });
    expect(result.candidateCount).toBe(2);
    expect(result.candidates.map(candidate => candidate.reviewId)).toEqual(['200', '202']);
  });
});
