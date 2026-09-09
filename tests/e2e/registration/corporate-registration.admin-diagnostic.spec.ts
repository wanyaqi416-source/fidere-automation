import { RegistrationReviewDashboardPage } from '../../../pages/admin/RegistrationReviewDashboardPage';
import { expect, test } from '../../../fixtures/registration.fixture';
import { env } from '../../../src/config/env';
import { CorporateRegistrationJourneyStore } from '../../../src/registration';

test('REG-C-002 案件工作台企业用户只读复核', async ({ adminPage, business }) => {
  const adminBaseUrl = env.admin.baseUrl;
  if (!adminBaseUrl) throw new Error('ADMIN_BASE_URL is required for Corporate Admin diagnostic.');
  const journey = new CorporateRegistrationJourneyStore().load();
  if (!journey || journey.stage !== 'COMPLETED') {
    throw new Error('A completed Corporate Registration Journey is required.');
  }

  business.flow('corporate-registration', {
    caseId: 'REG-C-002-ADMIN-DIAGNOSTIC',
    name: '案件工作台企业用户只读复核',
    level: 'L2',
    type: ['Readonly', 'Diagnostic']
  });
  const dashboard = new RegistrationReviewDashboardPage(adminPage);
  await dashboard.goto(adminBaseUrl);
  const result = await dashboard.locateUniquePendingCandidate({
    accountType: 'corporate',
    email: journey.email,
    displayName: journey.displayName
  });
  expect(result.candidateCount).toBe(1);
  expect(result.candidates[0].accountType).toBe('corporate');
  expect(result.candidates[0].status).toBe('待审核');
  business.recordDiagnostic({
    id: 'corporate-admin-post-registration',
    name: 'Admin Post-Registration Verification',
    status: 'available',
    summary: '案件工作台企业用户Tab唯一定位本次企业注册',
    reason: 'candidateCount=1; status=待审核',
    affectsCoreBusiness: false
  });
  business.setBusinessData({
    adminRoute: '/zh-CN/kyc/dashboard',
    adminTab: '企业用户',
    candidateCount: result.candidateCount,
    clientFinalState: journey.clientFinalState
  });
});
