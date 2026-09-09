import { AccountOpeningReviewPage } from '../../../pages/admin/AccountOpeningReviewPage';
import { AccountTypeConfigurationPage } from '../../../pages/admin/AccountTypeConfigurationPage';
import { JurisdictionAccountChooserPage } from '../../../pages/client/JurisdictionAccountChooserPage';
import { UsAccountOpeningPage } from '../../../pages/client/UsAccountOpeningPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { resolveUsOpeningDocumentAssets } from '../../../src/account-opening/account-opening-assets';
import {
  US_ACCOUNT_OPENING_FLOW_ID,
  UsAccountOpeningExecutionGuard,
  activeUsAccountOpeningStates
} from '../../../src/account-opening/account-opening-e2e';
import { runUsAccountOpeningFeePreflight } from '../../../src/account-opening/us-account-opening-fee-preflight';
import { env } from '../../../src/config/env';
import { FlowStateStore, assertSandboxEnvironment } from '../../../src/flow-engine';
import { getClientSecurityKey } from '../../../src/utils/security-key';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'OPEN-US-003 开户费Resume只读Preflight',
  {
    tag: ['@e2e', '@account-opening', '@us', '@resume', '@readonly', '@preflight', '@L2'],
    annotation: [
      { type: 'caseId', description: 'OPEN-US-003-FEE-RESUME-PREFLIGHT' },
      { type: 'flowId', description: US_ACCOUNT_OPENING_FLOW_ID },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ clientPage, adminPage, business }) => {
    test.setTimeout(3 * 60 * 1000);
    if (!env.client.baseUrl || !env.admin.baseUrl || !env.accountOpening.testEmail) {
      throw new Error('OPEN-US-003 Fee Resume Preflight requires Client/Admin URLs and OPENING_TEST_EMAIL.');
    }
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);
    assertSandboxEnvironment(env.client.baseUrl);
    assertSandboxEnvironment(env.admin.baseUrl);
    getClientSecurityKey();

    const store = new FlowStateStore();
    const states = activeUsAccountOpeningStates(store);
    expect(states).toHaveLength(1);
    const state = states[0];
    expect(state.stage).toBe('CLIENT_FEE_CONFIRMATION_REQUIRED');

    const guard = new UsAccountOpeningExecutionGuard();
    const chooser = new JurisdictionAccountChooserPage(clientPage);
    const application = new UsAccountOpeningPage(clientPage);
    const reviews = new AccountOpeningReviewPage(adminPage);
    const accountTypes = new AccountTypeConfigurationPage(adminPage);

    business.flow(US_ACCOUNT_OPENING_FLOW_ID, {
      caseId: 'OPEN-US-003-FEE-RESUME-PREFLIGHT',
      name: 'OPEN-US-003 开户费Resume只读Preflight',
      description: '读取原草稿开户费、付款账户和USD余额；关闭弹窗，不确认扣费、不验证安全密钥、不创建申请。',
      level: 'L2',
      type: ['Readonly', 'Preflight'],
      changesData: false,
      affectsMoney: false,
      safetySwitches: []
    });

    await business.step(
      {
        action: '读取原OPEN-US-003草稿的开户费确认信息与付款账户余额',
        expected: 'Documenso仍完成、开户费弹窗可读、余额充足、Admin认证及Interlace配置有效，资金动作均为0次'
      },
      async context => {
        const result = await runUsAccountOpeningFeePreflight({
          clientPage,
          adminPage,
          clientBaseUrl: env.client.baseUrl!,
          adminBaseUrl: env.admin.baseUrl!,
          customerIdentity: env.accountOpening.testEmail!,
          assets: resolveUsOpeningDocumentAssets(),
          guard,
          chooser,
          application,
          reviews,
          accountTypes,
          keepFeeDialogOpen: false
        });

        expect(result.persistedDocumentCount).toBe(5);
        expect(result.existingUsApplicationCount).toBe(0);
        expect(result.balanceSufficient).toBe(true);
        expect(result.fee.openingFeeAmount.isPositive()).toBe(true);
        expect(application.openFeeConfirmationClickCount()).toBe(1);
        expect(application.feeConfirmationClickCount()).toBe(0);
        expect(application.securityKey.verificationClickCount()).toBe(0);
        expect(application.applicationCreateCount()).toBe(0);
        expect(guard.snapshot()).toMatchObject({
          openFeeConfirmationClicks: 1,
          clientMoneyConfirmations: 0,
          securityKeyVerifications: 0,
          clientSubmissions: 0,
          adminActions: 0
        });

        expect(result.feeDialogOpen).toBe(false);
        expect(store.load(state.flowId, state.runId)?.stage).toBe(
          'CLIENT_FEE_CONFIRMATION_REQUIRED'
        );

        context.recordPrimaryOracle({
          id: 'OPEN-US-003-FEE-PREFLIGHT-P1',
          name: '开户费与付款余额可读',
          expected: '页面费用为正数，付款账户USD余额不少于开户费',
          actual: `${result.fee.currency} ${result.fee.openingFeeAmount.toString()}；${result.feeBalanceAccountType}余额充足`,
          status: 'passed'
        });
        context.setBusinessData({
          resumeMode: 'OPEN-US-003 Fee Resume Preflight',
          resumeStartStage: state.stage,
          resumeStage: state.stage,
          documentsUploaded: true,
          documensoCompleted: true,
          openingFeeCurrency: result.fee.currency,
          openingFeeAmount: result.fee.openingFeeAmount.toString(),
          openingFeePaymentAccount: result.fee.paymentAccount,
          openingFeeBalanceAccountType: result.feeBalanceAccountType,
          feeBalanceBefore: result.feeBalanceBefore,
          feeBalanceSufficient: result.balanceSufficient,
          feeConfirmationButtonText: result.fee.confirmButtonText,
          openingFeeDescription: result.fee.feeDescription,
          openFeeConfirmationCount: application.openFeeConfirmationClickCount(),
          feeConfirmationClickCount: application.feeConfirmationClickCount(),
          securityVerificationClicks: application.securityKey.verificationClickCount(),
          securityVerificationStatus: 'Not Run',
          applicationCreateCount: application.applicationCreateCount(),
          applicationCreatedAfterFee: false,
          existingUsOpeningApplicationCount: result.existingUsApplicationCount,
          usOpeningChannel: result.channel,
          usOpeningChannelEnabled: result.channelEnabled,
          nextClientState: 'SecurityKeyDialog -> Fee Confirmed -> Client Application Created',
          mutationPerformed: false,
          confirmed: true
        });
        context.setActual('开户费弹窗、付款账户与USD余额均已从真实页面读取；已取消弹窗，扣费确认、安全密钥验证和申请创建均为0次。');
      }
    );
  }
);
