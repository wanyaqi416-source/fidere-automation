import { WithdrawalListPage } from '../../../pages/admin/WithdrawalListPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import {
  buildWithdrawalApprovalNote,
  type WithdrawalFingerprint
} from '../../../src/withdrawal/withdrawal-e2e';
import { validateWithdrawalProofAsset } from '../../../src/withdrawal/withdrawal-proof';
import {
  getWithdrawalApprovalConfig,
  getWithdrawalApprovalDryRunFixture
} from '../../client/withdrawal/withdrawalTestSupport';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'WD-003 出金Admin批准表单Dry Run',
  {
    tag: ['@admin', '@withdrawal', '@readonly', '@dry-run'],
    annotation: [
      { type: 'caseId', description: 'WD-003-DRY' },
      { type: 'module', description: 'Withdrawal' },
      { type: 'priority', description: 'P0' },
      { type: 'type', description: 'Admin / Readonly' }
    ]
  },
  async ({ adminPage, business }, testInfo) => {
    test.setTimeout(120_000);
    if (!env.admin.baseUrl) throw new Error('ADMIN_BASE_URL is required.');
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);
    expect(testInfo.config.workers).toBe(1);
    expect(testInfo.project.retries).toBe(0);
    expect(testInfo.project.repeatEach).toBe(1);

    const config = getWithdrawalApprovalConfig();
    const fixture = getWithdrawalApprovalDryRunFixture();
    const approvalNote = buildWithdrawalApprovalNote(
      testInfo.testId,
      config.approvalNotePrefix
    );
    const adminList = new WithdrawalListPage(adminPage);

    business.case({
      caseId: 'WD-003-DRY',
      module: 'Withdrawal',
      name: '出金Admin批准表单Dry Run',
      description: '验证真实Admin出金批准表单、固定Sandbox凭证上传和必填状态，不执行最终批准或拒绝。',
      priority: 'P0',
      type: ['Admin', 'Readonly'],
      scope: 'Admin / Readonly',
      preconditions: ['Admin认证有效', '存在唯一待处理出金记录', '两个Mutation开关均关闭'],
      target: '跑通批准表单能力并停在最终批准前。',
      expectedResult: '渠道、银行、凭证和审批备注均满足，批准按钮可用，Mutation Performed为No。',
      changesData: false,
      affectsMoney: false,
      dependsOnAdmin: true,
      dependsOnThirdParty: false,
      safetySwitches: ['ALLOW_MONEY_TESTS=false', 'ALLOW_ADMIN_MUTATION_TESTS=false']
    });
    business.setBusinessData({
      approvalClicks: 0,
      rejectConfirmationClicks: 0,
      mutationPerformed: false,
      dryRun: true
    });

    const proof = await business.step(
      {
        action: '检查固定Sandbox打款凭证',
        expected: '精确相对路径存在，是小于10MB的合法PNG'
      },
      async ({ setActual, setBusinessData }) => {
        const asset = await validateWithdrawalProofAsset();
        setBusinessData({
          paymentProofFileName: asset.fileName,
          paymentProofType: 'Sandbox自动化测试凭证',
          paymentProofSizeBytes: asset.sizeBytes,
          paymentProofUploaded: false
        });
        setActual(`已验证${asset.relativePath}，PNG签名和文件大小合法`);
        return asset;
      }
    );

    const candidate = await business.step(
      {
        action: '预检Admin认证并唯一定位待处理出金',
        expected: 'Admin业务页可访问，待处理且可审批的候选严格等于1'
      },
      async ({ setActual, setBusinessData }) => {
        await adminList.goto(env.admin.baseUrl!);
        await adminList.selectStatus('待处理');
        const fingerprint: WithdrawalFingerprint = {
          runId: testInfo.testId,
          userIdentity: fixture.userIdentity,
          accountType: fixture.accountType,
          currency: fixture.currency,
          requestedAmount: fixture.requestedAmount,
          clientSubmittedAtMs: fixture.submittedAtMs,
          adminStatus: '待处理'
        };
        const diagnostics = await adminList.diagnoseCandidates(
          fingerprint,
          fixture.matchWindowMs,
          { maxPages: 20 }
        );
        expect(diagnostics.candidates.length).toBe(1);
        const candidate = await adminList.locateFingerprintCandidate(
          fingerprint,
          fixture.matchWindowMs,
          20
        );
        expect(candidate.purpose).toBe(fixture.purpose);
        expect(
          await candidate.row.getByRole('button', { name: '审批', exact: true }).count()
        ).toBe(1);
        setBusinessData({
          candidateCount: diagnostics.candidates.length,
          candidateStageCounts: diagnostics.counts,
          adminStatusBefore: '待处理',
          fingerprintFields: ['测试用户', '账户类型', '币种', '精确金额', '收款人', '状态', '申请时间']
        });
        setActual('Admin认证有效；跨分页业务指纹候选数严格等于1');
        return candidate;
      }
    );

    const approval = await business.step(
      {
        action: '打开唯一候选详情与批准表单',
        expected: '列表和详情关键字段一致，四个批准必填项及最终按钮可见'
      },
      async ({ setActual, setBusinessData }) => {
        const detailPage = await adminList.openDetail(candidate);
        const detail = await detailPage.readDetail();
        expect(detail.status).toBe('待处理');
        expect(detail.accountType).toBe(candidate.accountType);
        expect(detail.requestedAmount).toBe(candidate.requestedAmount);
        expect(detail.feeAmount).toBe(candidate.feeAmount);
        expect(detail.beneficiaryText).toContain(candidate.beneficiaryText);
        const form = detailPage.approvalForm();
        await form.waitForOpen();
        expect(await detailPage.readRequiredApprovalFields()).toEqual([
          '打款渠道',
          '打款银行',
          '打款凭证',
          '审批备注'
        ]);
        expect(await detailPage.availableFinalActions()).toEqual(['拒绝', '批准']);
        const initial = await form.readFormState();
        expect(initial.proofFileName).toBe('');
        expect(initial.approvalNote).toBe('');
        setBusinessData({
          detailVerified: true,
          approvalRequiredFields: ['打款渠道', '打款银行', '打款凭证', '审批备注']
        });
        setActual('唯一候选详情二次核对通过；批准表单已打开，初始凭证和备注为空');
        return form;
      }
    );

    await business.step(
      {
        action: '读取并选择打款渠道',
        expected: '读取真实Sandbox选项并精确选择.env配置值'
      },
      async ({ setActual, setBusinessData }) => {
        const options = await approval.readPaymentChannelOptions();
        expect(options).toContain(config.paymentChannel);
        await approval.selectPaymentChannel(config.paymentChannel);
        setBusinessData({
          availablePaymentChannels: options,
          selectedPaymentChannel: config.paymentChannel
        });
        setActual(`可用渠道：${options.join('、')}；已选择配置渠道${config.paymentChannel}`);
      }
    );

    await business.step(
      {
        action: '读取并选择打款银行',
        expected: '读取真实Sandbox选项并精确选择.env配置值'
      },
      async ({ setActual, setBusinessData }) => {
        const options = await approval.readPaymentBankOptions();
        expect(options).toContain(config.paymentBank);
        await approval.selectPaymentBank(config.paymentBank);
        setBusinessData({
          availablePaymentBanks: options,
          selectedPaymentBank: config.paymentBank
        });
        setActual(`可用银行：${options.join('、')}；已选择配置银行${config.paymentBank}`);
      }
    );

    await business.step(
      {
        action: '上传固定Sandbox打款凭证',
        expected: '通过input[type=file]接受bank-payment-proof.png且无类型/大小错误'
      },
      async ({ setActual, setBusinessData }) => {
        await approval.uploadPaymentProof(proof);
        setBusinessData({
          paymentProofFileName: proof.fileName,
          paymentProofType: 'Sandbox自动化测试凭证',
          paymentProofUploaded: true
        });
        setActual(`已上传Sandbox测试凭证；文件名：${proof.fileName}`);
      }
    );

    await business.step(
      {
        action: '填写审批备注',
        expected: '动态AUTO_WITHDRAW_APPROVE_<runId>备注已填写并回读一致'
      },
      async ({ setActual, setBusinessData }) => {
        await approval.fillApprovalNote(approvalNote);
        setBusinessData({ approvalNoteFilled: true });
        setActual('自动化审批备注已填写并回读一致');
      }
    );

    await business.step(
      {
        action: '验证必填项与批准按钮并停止',
        expected: '四个必填项满足，批准按钮正常可用，最终批准和拒绝均未点击'
      },
      async ({ setActual, setBusinessData }) => {
        await approval.assertRequiredFieldsSatisfied({
          paymentChannel: config.paymentChannel,
          paymentBank: config.paymentBank,
          proofFileName: proof.fileName,
          approvalNote
        });
        expect(approval.approvalClicks()).toBe(0);
        setBusinessData({
          requiredApprovalFieldsSatisfied: true,
          approvalButtonEnabled: true,
          approvalClicks: 0,
          rejectConfirmationClicks: 0,
          mutationPerformed: false,
          finalStatus: 'PASS；批准表单完成，未执行最终批准或拒绝'
        });
        setActual('四个必填项均满足，批准按钮可用；批准0次，拒绝0次，Mutation Performed：No');
      }
    );
  }
);
