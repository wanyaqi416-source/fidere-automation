import { AccountOpeningReviewPage } from '../../../pages/admin/AccountOpeningReviewPage';
import { BahrainAccountOpeningPage } from '../../../pages/client/BahrainAccountOpeningPage';
import { JurisdictionAccountChooserPage } from '../../../pages/client/JurisdictionAccountChooserPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'OPEN-BH-DRY 巴林账户开户双端Dry Run',
  {
    tag: ['@e2e', '@account-opening', '@bahrain', '@readonly', '@dry-run', '@L3'],
    annotation: [
      { type: 'caseId', description: 'OPEN-BH-DRY' },
      { type: 'flowId', description: 'account-opening-bahrain-dry-run' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ clientPage, adminPage, business }) => {
    test.setTimeout(120_000);
    if (!env.client.baseUrl || !env.admin.baseUrl || !env.accountOpening.testEmail) {
      throw new Error('Client/Admin URLs and OPENING_TEST_EMAIL are required for OPEN-BH-DRY.');
    }
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);
    business.flow('account-opening-bahrain-dry-run', {
      preconditions: ['专用Sandbox开户账号与Admin认证有效', '两个Mutation开关均关闭'],
      target: '验证巴林开户双端入口和最终提交门禁。'
    });

    const chooser = new JurisdictionAccountChooserPage(clientPage);
    const application = new BahrainAccountOpeningPage(clientPage);
    const admin = new AccountOpeningReviewPage(adminPage);

    await business.step(
      { action: '进入巴林账户开户表单', expected: '巴林账户可申请，表单显示USD 100且无上传资料' },
      async ({ setActual, setBusinessData }) => {
        await chooser.goto(env.client.baseUrl!);
        await chooser.openChooser();
        const option = await chooser.readOption('巴林账户');
        expect(option).toMatchObject({ status: '可申请', actionAvailable: true });
        await chooser.openApplication('巴林账户');
        await application.expectLoaded();
        const openingFee = await application.readOpeningFee();
        const fileInputCount = await application.fileInputCount();
        expect(openingFee).toBe('USD 100');
        expect(fileInputCount).toBe(0);
        setBusinessData({ openingFee, openingFileInputCount: fileInputCount });
        setActual('巴林开户表单已打开，开户费USD 100，无资料上传控件');
      }
    );

    await business.step(
      { action: '验证Admin开户审核入口', expected: '个人开户审核页和专用客户搜索可用，审核动作0次' },
      async ({ setActual, setBusinessData }) => {
        await admin.goto(env.admin.baseUrl!);
        await admin.searchCustomer(env.accountOpening.testEmail!);
        const records = await admin.readRecords(env.accountOpening.testEmail!);
        setBusinessData({
          adminOpeningRowCount: await admin.tableRowCount(),
          adminOpeningMatchedHistoryCount: records.filter(record => record.customerMatched).length
        });
        expect(admin.reviewClickCount()).toBe(0);
        setActual('Admin开户审核入口和搜索已验证；未执行通过或拒绝');
      }
    );

    await business.step(
      { action: '确认巴林Dry Run零写操作', expected: 'Client最终提交0次、Admin审核0次' },
      async ({ setActual, setBusinessData, recordPrimaryOracle }) => {
        expect(application.submissionClickCount()).toBe(0);
        expect(admin.reviewClickCount()).toBe(0);
        setBusinessData({ finalSubmissionClicks: 0, adminReviewClicks: 0, mutationPerformed: false });
        recordPrimaryOracle({
          id: 'open-bh-dry-run-no-mutation',
          name: '巴林开户Dry Run零写操作',
          expected: 'Client/Admin最终动作均为0次',
          actual: 'Client提交0次，Admin审核0次',
          status: 'passed'
        });
        setActual('未创建巴林开户申请，未执行Admin审核');
      }
    );
  }
);
