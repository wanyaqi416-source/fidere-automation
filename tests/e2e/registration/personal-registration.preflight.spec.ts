import { AdminClientUsersPage } from '../../../pages/admin/AdminClientUsersPage';
import { PersonalRegistrationPage } from '../../../pages/client/PersonalRegistrationPage';
import { expect, test } from '../../../fixtures/registration.fixture';
import { authStatePaths, requireExistingAuthState } from '../../../src/config/auth';
import { env } from '../../../src/config/env';
import {
  maskRegistrationEmail,
  maskRegistrationPhone,
  loadPersonalRegistrationProfile,
  TestUserFactory
} from '../../../src/registration';
import { assertSandboxEnvironment } from '../../../src/flow-engine/mutation-guard';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'REG-P-002 Fresh Personal User提交前Preflight',
  {
    tag: ['@registration', '@personal', '@dry-run', '@L3'],
    annotation: [
      { type: 'caseId', description: 'REG-P-002-PREFLIGHT' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ adminPage, browser, business, registrationPage }) => {
    test.setTimeout(90_000);
    business.flow('personal-registration', {
      caseId: 'REG-P-002-PREFLIGHT',
      name: '个人用户注册提交前安全检查',
      level: 'L3',
      type: ['Dry Run', 'Read-only'],
      expectedResult: '真实注册页与Admin查询可用，且所有唯一测试数据准备项可明确判定。',
      changesData: false,
      affectsMoney: false
    });

    const clientBaseUrl = env.client.baseUrl;
    const adminBaseUrl = env.admin.baseUrl;
    expect(clientBaseUrl).toBeTruthy();
    expect(adminBaseUrl).toBeTruthy();
    assertSandboxEnvironment(clientBaseUrl);
    assertSandboxEnvironment(adminBaseUrl);
    expect(env.allowClientMutationTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);

    const blockers: string[] = [];
    const factory = new TestUserFactory(env.personalRegistration.dataPoolPath);
    const poolReadiness = factory.readiness();
    if (!poolReadiness.ready) blockers.push(...poolReadiness.blockers);
    if (!env.personalRegistration.otp) {
      blockers.push('CLIENT_REGISTER_OTP is not configured.');
    }
    if (!env.client.password) {
      blockers.push('CLIENT_PASSWORD is not configured.');
    }

    let profileConfigured = false;
    try {
      loadPersonalRegistrationProfile(env.personalRegistration.profilePath);
      profileConfigured = true;
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }

    await business.step(
      { action: '验证真实Client注册入口', expected: '邮箱和邮箱验证码字段可见，且未加载旧Client登录状态。' },
      async context => {
        const page = new PersonalRegistrationPage(registrationPage);
        await page.goto(clientBaseUrl!);
        context.setActual('注册入口正常；当前为干净BrowserContext。');
      }
    );

    const adminUsers = new AdminClientUsersPage(adminPage);
    await business.step(
      { action: '验证Admin认证及用户搜索页面', expected: 'Admin会话有效且用户列表可搜索。' },
      async context => {
        await adminUsers.goto(adminBaseUrl!);
        context.setActual('Admin认证有效，用户搜索入口正常。');
      }
    );

    let candidate: ReturnType<TestUserFactory['previewFreshIdentity']>;
    try {
      candidate = factory.previewFreshIdentity(env.personalRegistration.email);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
    let loginIdentityCandidateCount: number | undefined;
    let contactIdentityCandidateCount: number | undefined;
    if (candidate) {
      await business.step(
        { action: '检查邮箱与手机号在Admin中未被占用', expected: '两个候选值的现有用户数均为0。' },
        async context => {
          loginIdentityCandidateCount = await adminUsers.exactCandidateCount(candidate.email);
          const phoneSearchContext = await browser.newContext({
            baseURL: adminBaseUrl!,
            storageState: requireExistingAuthState(authStatePaths.admin, {
              systemName: 'Admin',
              refreshCommand: 'npm run auth:admin'
            })
          });
          try {
            const phoneSearchPage = await phoneSearchContext.newPage();
            const phoneSearch = new AdminClientUsersPage(phoneSearchPage);
            await phoneSearch.goto(adminBaseUrl!);
            contactIdentityCandidateCount = await phoneSearch.exactCandidateCount(candidate.phone);
          } finally {
            await phoneSearchContext.close();
          }
          if (loginIdentityCandidateCount !== 0) blockers.push('The next Sandbox email is already used.');
          if (contactIdentityCandidateCount !== 0) blockers.push('The next Sandbox phone is already used.');
          context.setActual(
            `邮箱候选=${loginIdentityCandidateCount}；手机号候选=${contactIdentityCandidateCount}。`
          );
        }
      );
    }

    if (blockers.length > 0) {
      business.warn(`REG-P-002 BLOCKED_TEST_DATA: ${blockers.join(' ')}`);
    }
    business.setBusinessData({
      readinessStatus: blockers.length === 0 ? 'MUTATION_READY' : 'BLOCKED_TEST_DATA',
      blockerReason: blockers.join(' '),
      registrationLoginIdentity: candidate ? maskRegistrationEmail(candidate.email) : '未分配',
      registrationContactIdentity: candidate ? maskRegistrationPhone(candidate.phone) : '未分配',
      registrationCodeConfigured: Boolean(env.personalRegistration.otp),
      credentialSource: 'CLIENT_PASSWORD',
      credentialConfigured: Boolean(env.client.password),
      registrationDataPoolAvailableCount: poolReadiness.availableCount,
      registrationProfileConfigured: profileConfigured,
      loginIdentityUnique: loginIdentityCandidateCount === 0,
      contactIdentityUnique: contactIdentityCandidateCount === 0,
      mutationPerformed: false,
      noSecondUserCreated: true
    });
  }
);
