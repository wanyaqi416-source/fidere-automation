import { AccountOpeningReviewPage } from '../../../pages/admin/AccountOpeningReviewPage';
import { JurisdictionAccountChooserPage } from '../../../pages/client/JurisdictionAccountChooserPage';
import { UsAccountOpeningPage } from '../../../pages/client/UsAccountOpeningPage';
import { DocumentSigningPage } from '../../../pages/third-party/DocumentSigningPage';
import { expect, test } from '../../../fixtures/workflow.fixture';
import { resolveUsOpeningDocumentAssets } from '../../../src/account-opening/account-opening-assets';
import { US_ACCOUNT_OPENING_FLOW_ID } from '../../../src/account-opening/account-opening-e2e';
import { env } from '../../../src/config/env';
import { FlowStateStore } from '../../../src/flow-engine';

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'OPEN-US-DRY 美国账户开户资料上传Dry Run',
  {
    tag: ['@e2e', '@account-opening', '@us', '@readonly', '@dry-run', '@L3'],
    annotation: [
      { type: 'caseId', description: 'OPEN-US-DRY' },
      { type: 'flowId', description: 'account-opening-us-dry-run' },
      { type: 'changesData', description: 'false' },
      { type: 'affectsMoney', description: 'false' }
    ]
  },
  async ({ clientPage, adminPage, business }, testInfo) => {
    test.setTimeout(150_000);
    if (
      !env.client.baseUrl ||
      !env.admin.baseUrl ||
      !env.accountOpening.testEmail ||
      !env.accountOpening.signatureText ||
      !env.accountOpening.initials
    ) {
      throw new Error(
        'Client/Admin URLs and all OPENING_* Sandbox identity settings are required for OPEN-US-DRY.'
      );
    }
    expect(env.exchange.allowMoneyTests).toBe(false);
    expect(env.allowAdminMutationTests).toBe(false);

    business.flow('account-opening-us-dry-run', {
      preconditions: ['专用Sandbox开户账号与Admin认证有效', '两个Mutation开关均关闭'],
      target: '上传五份固定Sandbox资料并验证双端入口，停在税表签署和最终提交前。'
    });

    const chooser = new JurisdictionAccountChooserPage(clientPage);
    const application = new UsAccountOpeningPage(clientPage);
    const documentSigning = new DocumentSigningPage(clientPage);
    const admin = new AccountOpeningReviewPage(adminPage);
    const assets = resolveUsOpeningDocumentAssets();
    let usStatus: '已开通' | '可申请' | '申请中' | '已拒绝' | '失败' = '可申请';

    await business.step(
      { action: '读取美国账户状态并按当前状态选择只读路径', expected: '未开户时进入表单；已开户时禁止重复申请' },
      async ({ setActual, setBusinessData }) => {
        await chooser.goto(env.client.baseUrl!);
        await chooser.openChooser();
        const option = await chooser.readOption('美国账户');
        expect(['可申请', '已开通', '已拒绝', '失败']).toContain(option.status);
        usStatus = option.status;
        expect(option.actionAvailable).toBe(usStatus === '可申请');
        setBusinessData({ usOpeningStatus: option.status });
        if (usStatus !== '可申请') {
          setActual(`美国账户状态=${usStatus}；本次切换为终态只读复核，不进入资料上传或Documenso`);
          return;
        }
        await chooser.openApplication('美国账户');
        await application.expectLoaded();
        await application.validateRequiredPrefilledFields();
        await application.validateUploadFields(assets.map(asset => asset.field));
        setActual('美国开户表单已打开，基础资料和五个上传字段均可读取');
      }
    );

    if (usStatus !== '可申请') {
      await business.step(
        { action: '按原reviewId核对Client与Admin开户终态', expected: '原美国开户申请可唯一读取，且不产生任何新动作' },
        async ({ setActual, setBusinessData, recordPrimaryOracle }) => {
          await admin.goto(env.admin.baseUrl!);
          await admin.searchCustomer(env.accountOpening.testEmail!);
          const records = await admin.readRecords(env.accountOpening.testEmail!);
          const persisted = new FlowStateStore()
            .list(US_ACCOUNT_OPENING_FLOW_ID)
            .find(state => state.adminReference);
          expect(persisted?.adminReference).toBeTruthy();
          const matched = records.filter(record =>
            record.customerMatched &&
            record.accountType === '美国账户' &&
            record.applicationId === persisted!.adminReference
          );
          expect(matched).toHaveLength(1);
          const detailPage = await admin.openDetail(matched[0]);
          const detail = await detailPage.readDetail(matched[0].applicationId!);
          expect(admin.reviewClickCount()).toBe(0);
          const readinessStatus = usStatus === '已开通'
            ? 'READY'
            : 'BLOCKED_BAAS_FAILED';
          if (usStatus !== '已开通') {
            testInfo.annotations.push({
              type: 'blocker',
              description: `${readinessStatus}: Client美国账户状态=${usStatus}`
            });
          }
          setBusinessData({
            candidateCount: matched.length,
            fidereStatusAfter: matched[0].status,
            clientUsAccountFinalStatus: usStatus,
            baasFinalStatus: usStatus === '已开通' ? 'BAAS_APPROVED' : 'BAAS_FAILED',
            baasFailureReason: detail.failureReason,
            readinessStatus,
            mutationPerformed: false
          });
          recordPrimaryOracle({
            id: 'open-us-dry-postcheck',
            name: '美国开户跨端终态只读复核',
            expected: '原reviewId候选数=1，Client/Admin当前状态可读',
            actual: `Client=${usStatus}，Admin=${matched[0].status}，候选数=1`,
            status: 'passed'
          });
          setActual(`原美国开户申请只读核对完成：Client=${usStatus}，Admin=${matched[0].status}；未执行任何开户动作`);
        }
      );

      await business.step(
        { action: '确认已开户账号零写操作', expected: '资料上传、Documenso、Client提交和Admin审核均为0次' },
        async ({ setActual, setBusinessData }) => {
          expect(chooser.applicationClickCount()).toBe(0);
          expect(application.submissionClickCount()).toBe(0);
          expect(application.signingEntryClickCount()).toBe(0);
          expect(documentSigning.completeClickCount()).toBe(0);
          expect(documentSigning.signingConfirmationClickCount()).toBe(0);
          expect(admin.reviewClickCount()).toBe(0);
          setBusinessData({
            openingDocumentUploadCount: 0,
            signingFieldApplyClicks: 0,
            signingFinalClicks: 0,
            finalSubmissionClicks: 0,
            adminReviewClicks: 0,
            mutationPerformed: false
          });
          setActual('终态只读分支没有重复上传、签署、扣费、提交或Admin处理');
        }
      );
      return;
    }

    await business.step(
      { action: '按字段上传五份固定Sandbox资料', expected: '每份文件被对应字段接受且没有格式或大小错误' },
      async ({ setActual, setBusinessData }) => {
        const results = [];
        for (const asset of assets) {
          results.push(await application.uploadDocument(asset));
        }
        expect(results).toHaveLength(5);
        expect(results.every(result => result.accepted)).toBe(true);
        setBusinessData({
          openingDocumentUploads: results.map(result => ({
            field: result.field,
            fileName: result.fileName,
            result: 'accepted'
          }))
        });
        setActual('五份固定Sandbox资料均被各自语义字段接受');
      }
    );

    await business.step(
      {
        action: '完成Documenso必填字段并停在最终完成前',
        expected: 'iframe正常加载，固定TEST签名可插入，最终按钮可定位但点击0次'
      },
      async ({ setActual, setBusinessData }) => {
        const taxFormStatus = await application.readTaxFormStatus();
        expect(taxFormStatus).toMatch(/美国税务表格/);
        await documentSigning.open(() => application.openTaxDocumentSigning());
        const signing = await documentSigning.prepareSandboxSignature({
          signatureText: env.accountOpening.signatureText!,
          initials: env.accountOpening.initials!
        });
        expect(signing.requiredFieldsBefore).toBe(1);
        expect(signing.requiredFieldsAfter).toBe(0);
        expect(signing.identityChallengePresent).toBe(false);
        expect(signing.fieldSignClicks).toBe(1);
        expect(signing.finalActionClicks).toBe(0);
        expect(application.submissionClickCount()).toBe(0);
        setBusinessData({
          taxFormStatus,
          signingProvider: signing.provider,
          signingOpeningMode: signing.openingMode,
          signingMethod: signing.signatureMethod,
          signatureUploadAvailable: signing.uploadSignatureAvailable,
          typedSignatureAvailable: signing.typedSignatureAvailable,
          initialsRequired: signing.initialsRequired,
          dateHandling: signing.dateHandling,
          checkboxHandling: signing.checkboxHandling,
          identityChallengePresent: signing.identityChallengePresent,
          signingRequiredFieldsBefore: signing.requiredFieldsBefore,
          signingRequiredFieldsAfter: signing.requiredFieldsAfter,
          signingFinalAction: signing.finalActionName,
          signingFinalActionLocator: signing.finalActionLocator,
          signingFieldApplyClicks: signing.fieldSignClicks,
          signingFinalClicks: signing.finalActionClicks,
          finalSubmissionClicks: 0
        });
        setActual(
          `Documenso iframe已加载，固定TEST Canvas签名已填入；${signing.finalActionName}已定位但未点击`
        );
      }
    );

    await business.step(
      { action: '验证Admin开户审核入口和客户搜索', expected: '个人开户审核页及客户搜索可用，未执行Approve/Reject' },
      async ({ setActual, setBusinessData }) => {
        await admin.goto(env.admin.baseUrl!);
        await admin.searchCustomer(env.accountOpening.testEmail!);
        const records = await admin.readRecords(env.accountOpening.testEmail!);
        setBusinessData({
          adminOpeningRowCount: await admin.tableRowCount(),
          adminOpeningMatchedHistoryCount: records.filter(record => record.customerMatched).length
        });
        expect(admin.reviewClickCount()).toBe(0);
        setActual('Admin开户审核入口和专用客户搜索已验证；未打开审核Mutation路径');
      }
    );

    await business.step(
      { action: '确认Dry Run零写操作', expected: 'Client最终提交0次、Admin审核0次、两个安全开关关闭' },
      async ({ setActual, setBusinessData, recordPrimaryOracle }) => {
        expect(application.submissionClickCount()).toBe(0);
        expect(application.signingEntryClickCount()).toBe(1);
        expect(documentSigning.completeClickCount()).toBe(0);
        expect(documentSigning.signingConfirmationClickCount()).toBe(0);
        expect(admin.reviewClickCount()).toBe(0);
        expect(env.exchange.allowMoneyTests).toBe(false);
        expect(env.allowAdminMutationTests).toBe(false);
        setBusinessData({ mutationPerformed: false, adminReviewClicks: 0 });
        recordPrimaryOracle({
          id: 'open-us-dry-run-no-mutation',
          name: '美国开户Dry Run零写操作',
          expected: 'Client/Admin最终动作均为0次',
          actual: 'Client提交0次，Admin审核0次',
          status: 'passed'
        });
        setActual('资料上传检查完成；未创建开户申请、未扣费、未执行Admin审核');
      }
    );
  }
);
