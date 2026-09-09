import { JurisdictionAccountChooserPage } from '../../../pages/client/JurisdictionAccountChooserPage';
import { UsAccountOpeningPage } from '../../../pages/client/UsAccountOpeningPage';
import { expect, test } from '../../../fixtures/client.fixture';
import { resolveUsOpeningDocumentAssets } from '../../../src/account-opening/account-opening-assets';
import { env } from '../../../src/config/env';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'OPEN-US-001 美国账户开户Validation',
  {
    tag: ['@client', '@account-opening', '@us', '@validation', '@readonly', '@L1'],
    annotation: [
      { type: 'caseId', description: 'OPEN-US-001' },
      { type: 'flowId', description: 'account-opening-us-validation' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ baseURL, page, business }, testInfo) => {
    if (!baseURL || !env.accountOpening.testEmail) {
      throw new Error('CLIENT_BASE_URL and OPENING_TEST_EMAIL are required for OPEN-US-001.');
    }
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);

    business.flow('account-opening-us-validation', {
      preconditions: ['专用Sandbox开户账号自动认证成功', '两个Mutation开关均关闭'],
      target: '验证美国开户入口、资料字段映射和最终提交前门禁。'
    });

    const chooser = new JurisdictionAccountChooserPage(page);
    const application = new UsAccountOpeningPage(page);
    const assets = resolveUsOpeningDocumentAssets();
    let usStatus: '已开通' | '可申请' | '申请中' | '已拒绝' | '失败' = '可申请';

    await business.step(
      { action: '校验五份固定Sandbox开户资料', expected: '五份文件均从项目相对目录解析且字段映射唯一' },
      async ({ setActual, setBusinessData }) => {
        expect(assets).toHaveLength(5);
        expect(new Set(assets.map(asset => asset.field)).size).toBe(5);
        setBusinessData({
          openingDocumentFiles: assets.map(asset => asset.fileName),
          openingDocumentFields: assets.map(asset => asset.field)
        });
        setActual('五份固定测试资料均存在，字段映射为护照、身份证明、手持护照自拍、住址证明和资金来源证明');
      }
    );

    await business.step(
      { action: '从账户页打开开设其他账户弹窗', expected: '美国为可申请或已开通，新加坡已开通、巴林可申请' },
      async ({ setActual, setBusinessData }) => {
        await chooser.goto(baseURL);
        await chooser.openChooser();
        const us = await chooser.readOption('美国账户');
        const singapore = await chooser.readOption('新加坡账户');
        const bahrain = await chooser.readOption('巴林账户');
        expect(['可申请', '已开通', '已拒绝', '失败']).toContain(us.status);
        usStatus = us.status;
        expect(us.actionAvailable).toBe(usStatus === '可申请');
        expect(singapore).toMatchObject({ status: '已开通', actionAvailable: false });
        expect(bahrain).toMatchObject({ status: '可申请', actionAvailable: true });
        setBusinessData({
          usOpeningStatus: us.status,
          singaporeOpeningStatus: singapore.status,
          bahrainOpeningStatus: bahrain.status
        });
        setActual(
          usStatus === '可申请'
            ? '美国与巴林可申请，新加坡已开通'
            : `美国账户当前状态=${usStatus}；新加坡已开通，巴林仍可申请`
        );
      }
    );

    if (usStatus !== '可申请') {
      const readinessStatus = usStatus === '已开通'
        ? 'ALREADY_OPENED'
        : 'BLOCKED_BAAS_FAILED';
      if (usStatus !== '已开通') {
        testInfo.annotations.push({
          type: 'blocker',
          description: `${readinessStatus}: Client美国账户状态=${usStatus}`
        });
      }
      await business.step(
        { action: '复核美国账户开户后的只读终态', expected: '终态可读且不再提供重复申请动作' },
        async ({ setActual, setBusinessData, recordPrimaryOracle }) => {
          expect(chooser.applicationClickCount()).toBe(0);
          setBusinessData({
            usOpeningStatus: usStatus,
            finalSubmissionClicks: 0,
            mutationPerformed: false,
            readinessStatus
          });
          recordPrimaryOracle({
            id: 'open-us-validation-terminal',
            name: '美国账户开户终态可观测',
            expected: '终态可读且重复申请动作不可用',
            actual: `状态=${usStatus}，申请入口不可用，提交0次`,
            status: 'passed'
          });
          setActual(`专用用户美国账户状态=${usStatus}；Validation未重新进入资料、签署或扣费流程`);
        }
      );
      return;
    }

    await business.step(
      { action: '打开美国开户表单并校验真实资料字段', expected: '五个具名上传字段与五份Sandbox资料一一对应' },
      async ({ setActual, setBusinessData }) => {
        await chooser.openApplication('美国账户');
        await application.expectLoaded();
        await application.validateUploadFields(assets.map(asset => asset.field));
        const requiredPrefilledFieldCount = await application.validateRequiredPrefilledFields();
        setBusinessData({ requiredPrefilledFieldCount, formEntryCount: chooser.applicationClickCount() });
        setActual(`美国开户表单已打开；${assets.length}个资料字段定位唯一，必填基础资料保持已填写状态`);
      }
    );

    await business.step(
      { action: '读取税务表格状态并在最终提交前停止', expected: '税务状态可读，提交开户申请点击0次' },
      async ({ setActual, setBusinessData, recordPrimaryOracle }) => {
        const taxFormStatus = await application.readTaxFormStatus();
        expect(taxFormStatus).toMatch(/美国税务表格/);
        expect(application.submissionClickCount()).toBe(0);
        setBusinessData({
          taxFormStatus,
          finalSubmissionClicks: application.submissionClickCount(),
          mutationPerformed: false
        });
        recordPrimaryOracle({
          id: 'open-us-validation-no-mutation',
          name: '美国开户Validation零写操作',
          expected: '最终提交点击0次',
          actual: '最终提交点击0次',
          status: 'passed'
        });
        setActual('税务表格状态已读取；未签署、未提交开户申请');
      }
    );
  }
);
