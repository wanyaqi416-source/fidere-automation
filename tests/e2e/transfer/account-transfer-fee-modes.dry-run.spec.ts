import { test, expect } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment } from '../../../src/flow-engine';
import { AccountTypeConfigurationPage } from '../../../pages/admin/AccountTypeConfigurationPage';
import { TRANSFER_FEE_LABELS, usdTransferFeeRule, sameAccountTypeConfiguration, snapshotUsdFeeRule } from '../../../src/transfer/account-transfer-fee';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
for (const [type, value] of [['none', '0'], ['fixed', '0.37'], ['percent', '1.25']] as const) {
  test(`巴林USD ${TRANSFER_FEE_LABELS[type]}下拉联动及取消验证 @dry-run @L3`, async ({ adminPage, business }, testInfo) => {
    test.setTimeout(90_000);
    business.flow(`account-transfer-fee-${type}-dry-run`);
    assertSandboxEnvironment(env.admin.baseUrl);
    expect(env.allowAdminMutationTests || env.allowClientMutationTests || env.exchange.allowMoneyTests).toBe(false);
    expect(testInfo.config.workers).toBe(1); expect(testInfo.project.retries).toBe(0); expect(testInfo.project.repeatEach).toBe(1);
    const blocked: string[] = [];
    const protect: Parameters<typeof adminPage.route>[1] = async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) &&
        !['/admin-api/operation/account-domain/list', '/admin-api/operation/account-domain/detail'].includes(path)) {
        blocked.push(path); await route.abort('blockedbyclient');
      } else await route.continue();
    };
    await adminPage.route('**/*', protect);
    const admin = new AccountTypeConfigurationPage(adminPage);
    try {
      await admin.goto(env.admin.baseUrl!); await admin.openBahrainEditor();
      const original = await admin.readFeeConfiguration();
      const originalRule = snapshotUsdFeeRule(original);
      business.setBusinessData({ transferFeeType: TRANSFER_FEE_LABELS[type], originalTransferFee: originalRule.type === 'percent' ? `${originalRule.value}%` : originalRule.value,
        configuredTransferFee: type === 'percent' ? `${value}%` : value, sourceAccountType: '巴林账户', fromCurrency: 'USD',
        configurationSaveClicks: 0, configurationRestoreClicks: 0, finalSubmissionClicks: 0, securityVerificationClicks: 0 });
      await business.step({ action: `1. ${TRANSFER_FEE_LABELS[type]}下拉、单位及输入状态`, expected: '三个实际选项齐全；仅USD费用类型/值变化，其他配置不变' }, async step => {
        expect((await admin.readUsdFeeOptions()).sort()).toEqual(Object.values(TRANSFER_FEE_LABELS).sort());
        await admin.fillUsdTransferFeeRule(usdTransferFeeRule(type, value), original);
        step.recordPrimaryOracle({ id: 'ATF-MODE-FIELDS', name: '费用模式联动', expected: '字段、单位、开关和配置隔离正确', actual: '通过', status: 'passed' });
        step.setActual(type === 'none' ? '自动置零，输入禁用，显示免手续费。' : type === 'percent' ? '显示%，min=0，max=100，step=0.01，1.25可输入。' : '显示USD，min=0，step=0.01，0.37可输入。');
      });
      if (type !== 'none') await business.step({ action: '2. 输入范围及精度验证，不保存', expected: '零值合法；负值/超出两位小数无效，百分比超过100无效' }, async step => {
        expect((await admin.checkUsdFeeInputValidity('0')).valid).toBe(true);
        expect((await admin.checkUsdFeeInputValidity('-1')).underflow).toBe(true);
        expect((await admin.checkUsdFeeInputValidity('0.001')).stepMismatch).toBe(true);
        if (type === 'percent') {
          expect((await admin.checkUsdFeeInputValidity('100')).valid).toBe(true);
          expect((await admin.checkUsdFeeInputValidity('100.01')).overflow).toBe(true);
        }
        expect((await admin.checkUsdFeeInputValidity(value)).valid).toBe(true);
        step.setActual('真实input原生范围/步长约束已验证；未点击保存，不代表服务端非法配置校验已测试。');
      });
      await business.step({ action: '3. 取消并重新读取原配置', expected: '原类型/费值及全部其他字段不变；零业务写操作' }, async step => {
        await admin.cancelFeeEdit();
        await admin.goto(env.admin.baseUrl!); await admin.openBahrainEditor();
        expect(sameAccountTypeConfiguration(await admin.readFeeConfiguration(), original)).toBe(true);
        await admin.cancelFeeEdit(); expect(blocked).toEqual([]);
        business.setBusinessData({ configurationRestored: true, accountTransferFeeEvidence: JSON.stringify({ originalRule, editedRule: usdTransferFeeRule(type, value), cancelled: true }) });
        step.recordPrimaryOracle({ id: 'ATF-MODE-CANCEL', name: '取消无副作用', expected: '配置不变且零写操作', actual: '通过', status: 'passed' });
        step.setActual('类型和值均未保存。保存后Client生效及真实互转需另行具名授权，不用未保存配置推断Client结果。');
      });
    } finally { await adminPage.unroute('**/*', protect); }
  });
}
