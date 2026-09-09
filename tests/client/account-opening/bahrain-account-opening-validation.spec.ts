import { BahrainAccountOpeningPage } from '../../../pages/client/BahrainAccountOpeningPage';
import { JurisdictionAccountChooserPage } from '../../../pages/client/JurisdictionAccountChooserPage';
import { expect, test } from '../../../fixtures/client.fixture';
import { env } from '../../../src/config/env';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'OPEN-BH-001 巴林账户开户Validation',
  {
    tag: ['@client', '@account-opening', '@bahrain', '@validation', '@readonly', '@L1'],
    annotation: [
      { type: 'caseId', description: 'OPEN-BH-001' },
      { type: 'flowId', description: 'account-opening-bahrain-validation' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ baseURL, page, business }) => {
    if (!baseURL || !env.accountOpening.testEmail) {
      throw new Error('CLIENT_BASE_URL and OPENING_TEST_EMAIL are required for OPEN-BH-001.');
    }
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);
    business.flow('account-opening-bahrain-validation', {
      preconditions: ['专用Sandbox开户账号自动认证成功', '两个Mutation开关均关闭'],
      target: '确认巴林账户尚未开通并验证无资料上传的真实表单。'
    });

    const chooser = new JurisdictionAccountChooserPage(page);
    const application = new BahrainAccountOpeningPage(page);

    await business.step(
      { action: '确认巴林账户当前开户状态', expected: '开设其他账户弹窗显示巴林账户可申请' },
      async ({ setActual, setBusinessData }) => {
        await chooser.goto(baseURL);
        await chooser.openChooser();
        const option = await chooser.readOption('巴林账户');
        expect(option).toMatchObject({ status: '可申请', actionAvailable: true });
        setBusinessData({ bahrainOpeningStatus: option.status });
        setActual('当前账号尚未开通巴林账户，弹窗提供真实申请入口');
      }
    );

    await business.step(
      { action: '打开巴林开户表单并读取业务要求', expected: '开户费可读、上传控件为0、最终提交可定位' },
      async ({ setActual, setBusinessData }) => {
        await chooser.openApplication('巴林账户');
        await application.expectLoaded();
        const openingFee = await application.readOpeningFee();
        const fileInputCount = await application.fileInputCount();
        expect(openingFee).toBe('USD 100');
        expect(fileInputCount).toBe(0);
        setBusinessData({ openingFee, openingFileInputCount: fileInputCount });
        setActual('巴林开户费为USD 100，页面无资料上传字段');
      }
    );

    await business.step(
      { action: '在巴林开户最终提交前停止', expected: '确认并提交申请点击0次且没有Mutation' },
      async ({ setActual, setBusinessData, recordPrimaryOracle }) => {
        expect(application.submissionClickCount()).toBe(0);
        setBusinessData({ finalSubmissionClicks: 0, mutationPerformed: false });
        recordPrimaryOracle({
          id: 'open-bh-validation-no-mutation',
          name: '巴林开户Validation零写操作',
          expected: '最终提交点击0次',
          actual: '最终提交点击0次',
          status: 'passed'
        });
        setActual('未点击确认并提交申请');
      }
    );
  }
);
