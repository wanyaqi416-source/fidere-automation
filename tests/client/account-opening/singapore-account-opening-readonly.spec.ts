import { JurisdictionAccountChooserPage } from '../../../pages/client/JurisdictionAccountChooserPage';
import { expect, test } from '../../../fixtures/client.fixture';
import { env } from '../../../src/config/env';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'OPEN-SG-001 新加坡账户已开户Readonly',
  {
    tag: ['@client', '@account-opening', '@singapore', '@readonly', '@L2'],
    annotation: [
      { type: 'caseId', description: 'OPEN-SG-001' },
      { type: 'flowId', description: 'account-opening-singapore-readonly' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ baseURL, page, business }) => {
    if (!baseURL || !env.accountOpening.testEmail) {
      throw new Error('CLIENT_BASE_URL and OPENING_TEST_EMAIL are required for OPEN-SG-001.');
    }
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);
    business.flow('account-opening-singapore-readonly', {
      preconditions: ['专用Sandbox开户账号自动认证成功'],
      target: '只读确认当前新加坡账户已开通且不存在重复申请动作。'
    });

    const chooser = new JurisdictionAccountChooserPage(page);

    await business.step(
      { action: '读取账户页新加坡账户状态', expected: '账户页显示新加坡账户' },
      async ({ setActual }) => {
        await chooser.goto(baseURL);
        await chooser.expectAccountSection('新加坡账户');
        setActual('账户页已显示新加坡账户区域');
      }
    );

    await business.step(
      { action: '核对开设其他账户弹窗', expected: '新加坡账户标记已开通且没有重复开户动作' },
      async ({ setActual, setBusinessData, recordPrimaryOracle }) => {
        await chooser.openChooser();
        const option = await chooser.readOption('新加坡账户');
        expect(option.status).toBe('已开通');
        expect(option.actionAvailable).toBe(false);
        expect(chooser.applicationClickCount()).toBe(0);
        setBusinessData({
          singaporeOpeningStatus: option.status,
          firstOpeningReadiness: 'BLOCKED_TEST_DATA_FOR_FIRST_OPENING',
          finalSubmissionClicks: 0,
          mutationPerformed: false
        });
        recordPrimaryOracle({
          id: 'open-sg-existing-account',
          name: '新加坡账户已开户状态',
          expected: '已开通且不可重复申请',
          actual: '已开通且无申请动作',
          status: 'passed'
        });
        setActual('当前账号已开通新加坡账户；首次开户E2E仅缺少未开户专用测试用户');
      }
    );
  }
);
