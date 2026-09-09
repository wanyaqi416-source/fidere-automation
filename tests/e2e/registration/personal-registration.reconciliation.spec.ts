import { AdminClientUsersPage } from '../../../pages/admin/AdminClientUsersPage';
import { expect, test } from '../../../fixtures/registration.fixture';
import { env } from '../../../src/config/env';
import {
  maskRegistrationEmail,
  PersonalJourneyContextStore,
  registrationTestNameForSequence
} from '../../../src/registration';

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for REG-P reconciliation.`);
  return value;
}

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'REG-P-002 existing personal registration Admin reconciliation',
  {
    tag: ['@registration', '@personal', '@readonly', '@reconciliation', '@L2'],
    annotation: [
      { type: 'caseId', description: 'REG-P-002-RECONCILIATION' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ adminPage, business }) => {
    test.setTimeout(90_000);
    business.flow('personal-registration', {
      caseId: 'REG-P-002-RECONCILIATION',
      name: '个人注册Admin KYC案件只读复核',
      level: 'L2',
      type: ['Readonly', 'Reconciliation'],
      changesData: false,
      affectsMoney: false
    });

    expect(env.allowClientMutationTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);
    const journey = new PersonalJourneyContextStore().list()
      .find(item => item.sequence === 3);
    expect(journey).toBeTruthy();
    const expectedName = registrationTestNameForSequence(3).displayName;
    expect(journey!.displayName).toBe(expectedName);

    const users = new AdminClientUsersPage(adminPage);
    const located = await users.openUniqueRegistrationByEmail(
      required('ADMIN_BASE_URL', env.admin.baseUrl),
      journey!.email
    );
    expect(located.candidateCount).toBe(1);
    await users.expectDetailMatchesEmail(journey!.email);
    await users.expectDetailMatchesTestName(expectedName);
    const userId = await users.readUserId();
    const status = await users.readStatus();

    business.setBusinessData({
      registrationLoginIdentity: maskRegistrationEmail(journey!.email),
      registrationTestName: expectedName,
      adminUserCandidateCount: located.candidateCount,
      adminRegistrationRoute: located.route,
      adminRegistrationUserIdPresent: Boolean(userId),
      registrationFinalStatus: status,
      mutationPerformed: false,
      noSecondUserCreated: true
    });
    business.recordPrimaryOracle({
      id: 'admin-kyc-case-created',
      name: 'Admin KYC案件已创建',
      expected: 'candidateCount=1且姓名匹配',
      actual: `candidateCount=${located.candidateCount}；姓名=${expectedName}；状态=${status}`,
      status: 'passed'
    });
    console.log(
      `REG-P reconciliation: candidateCount=${located.candidateCount}; ` +
      `displayName=${expectedName}; status=${status}; userIdPresent=${Boolean(userId)}`
    );
  }
);
