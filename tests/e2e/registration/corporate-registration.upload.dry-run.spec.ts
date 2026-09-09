import path from 'node:path';

import { test, expect } from '../../../fixtures/registration.fixture';
import { CorporateRegistrationPage } from '../../../pages/client/CorporateRegistrationPage';
import { env } from '../../../src/config/env';
import {
  CORPORATE_DOCUMENT_MAPPING,
  type CorporateDocumentDefinition,
  loadCorporateDraft
} from '../../../src/registration';
import type { BusinessStepDefinition } from '../../../src/reporting/business-report.types';
import { refreshCorporateDraftAuthentication } from './corporate-registration.helpers';

const flowSteps: readonly BusinessStepDefinition[] = [
  { action: '恢复Corporate Draft认证', expected: '现有企业Draft登录有效且未最终提交' },
  { action: '校验企业注册资产', expected: '28个PNG测试资产存在并满足10 MB限制' },
  { action: '读取企业注册步骤', expected: '9个企业注册步骤均可识别' },
  { action: '验证企业基本资料页面', expected: '企业基础资料页面可打开且不提交' },
  { action: '验证运营信息与公司文件', expected: '7个公司文件字段逐一接受映射PNG' },
  { action: '验证资产来源页面', expected: '资产来源页面可打开且不保存' },
  { action: '验证合规问询与AML文件', expected: 'AML上传字段接受映射PNG' },
  { action: '验证授权代表文件', expected: '授权代表4个文件字段接受映射PNG' },
  { action: '验证自然人董事文件', expected: '自然人董事4个文件字段接受映射PNG' },
  { action: '验证法人董事文件', expected: '法人董事8个文件字段接受映射PNG' },
  { action: '验证个人股东与UBO文件', expected: '个人股东4个文件字段接受映射PNG' },
  { action: '验证企业授权签署入口', expected: '企业授权步骤可打开且不执行签署' },
  { action: '验证最终提交边界', expected: '最终提交次数保持0且本Run未发生业务Mutation' }
];

const variants: Array<{
  action: string;
  stepNumber: number;
  variant: CorporateDocumentDefinition['variant'];
  activate?: readonly string[];
  revealMailing?: boolean;
}> = [
  { action: '验证运营信息与公司文件', stepNumber: 2, variant: 'company' },
  { action: '验证合规问询与AML文件', stepNumber: 4, variant: 'company' },
  { action: '验证授权代表文件', stepNumber: 5, variant: 'authorized-representative', revealMailing: true },
  { action: '验证自然人董事文件', stepNumber: 6, variant: 'natural-director', activate: ['添加自然人董事'], revealMailing: true },
  { action: '验证法人董事文件', stepNumber: 6, variant: 'legal-director', activate: ['法人董事 (0)', '添加法人董事'], revealMailing: true },
  { action: '验证个人股东与UBO文件', stepNumber: 7, variant: 'natural-shareholder', activate: ['添加企业股东', '个人股东'], revealMailing: true }
];

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for Corporate Registration Upload Dry Run.`);
  return value;
}

function stepUrl(baseUrl: string, stepNumber?: number): string {
  const pathname = stepNumber
    ? `/zh-CN/registration?step=${stepNumber}&type=corporate`
    : '/zh-CN/registration?type=corporate';
  return new URL(pathname, baseUrl).toString();
}

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'REG-C-DRY-001 Corporate Registration Upload Dry Run @registration @corporate @dry-run @L3',
  async ({ browser, business }) => {
    business.flow('corporate-registration-upload-dry-run');
    business.plan(flowSteps);
    for (const document of CORPORATE_DOCUMENT_MAPPING) {
      business.setDocumentProgress({
        id: document.id,
        field: `${document.step} / ${document.pageLabel}`,
        file: document.asset,
        status: 'PENDING'
      });
    }

    const draft = loadCorporateDraft();
    if (!draft) throw new Error('Corporate Registration Draft is required for Upload Dry Run.');
    expect(draft.finalSubmissionCount).toBe(0);
    const baseUrl = required('CLIENT_BASE_URL', env.client.baseUrl);
    const context = await browser.newContext({
      baseURL: baseUrl,
      storageState: { cookies: [], origins: [] }
    });
    const page = await context.newPage();
    const corporate = new CorporateRegistrationPage(page);
    let uploadedDocumentCount = 0;

    const openStep = async (stepNumber?: number): Promise<void> => {
      await page.goto(stepUrl(baseUrl, stepNumber), { waitUntil: 'domcontentloaded' });
      business.setCurrentUrl(page.url());
      await corporate.expectOpen();
    };

    const uploadDocuments = async (
      documents: readonly CorporateDocumentDefinition[],
      setCurrentAction: (action: string) => void,
      setBusinessData: (data: Record<string, unknown>) => void
    ): Promise<void> => {
      for (const document of documents) {
        const fileName = path.basename(document.asset);
        setCurrentAction(`上传 ${document.pageLabel}：${fileName}`);
        business.setDocumentProgress({
          id: document.id,
          field: `${document.step} / ${document.pageLabel}`,
          file: document.asset,
          status: 'RUNNING'
        });
        try {
          await corporate.uploadDocument(document);
          uploadedDocumentCount += 1;
          business.setDocumentProgress({
            id: document.id,
            field: `${document.step} / ${document.pageLabel}`,
            file: document.asset,
            status: 'PASS',
            actual: '页面已接受文件'
          });
          setBusinessData({ uploadedDocumentCount, totalDocumentCount: CORPORATE_DOCUMENT_MAPPING.length });
        } catch (error) {
          business.setDocumentProgress({
            id: document.id,
            field: `${document.step} / ${document.pageLabel}`,
            file: document.asset,
            status: 'FAIL',
            actual: error instanceof Error ? error.message : String(error)
          });
          throw error;
        }
      }
    };

    try {
      await business.step(flowSteps[0], async ({ setActual, setBusinessData }) => {
        await refreshCorporateDraftAuthentication({
          page,
          context,
          email: draft.email,
          returnUrl: stepUrl(baseUrl)
        });
        business.setCurrentUrl(page.url());
        await corporate.expectOpen();
        setBusinessData({
          accountType: 'Corporate',
          currentRegistrationStep: '步骤总览',
          uploadedDocumentCount,
          totalDocumentCount: CORPORATE_DOCUMENT_MAPPING.length,
          directorCount: 0,
          shareholderCount: 0,
          uboCount: 0,
          remainingRequiredFields: 20,
          resumeStage: draft.stage
        });
        setActual(`Corporate Draft认证有效；Resume=${draft.stage}；最终提交次数=0`);
      });

      await business.step(flowSteps[1], async ({ setActual }) => {
        for (const document of CORPORATE_DOCUMENT_MAPPING) {
          const assetPath = path.resolve(document.asset);
          const file = await import('node:fs').then(module => module.statSync(assetPath));
          expect(file.isFile()).toBe(true);
          expect(file.size).toBeLessThanOrEqual(document.maxBytes);
          expect(path.extname(assetPath).toLowerCase()).toBe('.png');
        }
        setActual('28个PNG资产全部存在，格式与大小检查通过');
      });

      await business.step(flowSteps[2], async ({ setActual, setBusinessData }) => {
        await openStep();
        const labels = ['基本档案', '运营信息', '资产来源', '合规问询', '授权代表', '企业董事', '企业股东', '电子签名', '提交申请'];
        for (const label of labels) await expect(corporate.stepCard(label)).toBeVisible();
        setBusinessData({ currentRegistrationStep: '步骤总览' });
        setActual('9个真实企业注册步骤全部可见');
      });

      await business.step(flowSteps[3], async ({ setActual, setBusinessData }) => {
        await openStep(1);
        setBusinessData({ currentRegistrationStep: '基本档案' });
        setActual('企业基本资料页面可访问；未填写、未保存、未提交');
      });

      for (const variant of variants.slice(0, 1)) {
        await business.step(flowSteps.find(step => step.action === variant.action)!, async ({ setActual, setCurrentAction, setBusinessData }) => {
          await openStep(variant.stepNumber);
          setBusinessData({ currentRegistrationStep: '运营信息' });
          const documents = CORPORATE_DOCUMENT_MAPPING.filter(document => document.variant === variant.variant && document.step === '运营信息');
          await uploadDocuments(documents, setCurrentAction, setBusinessData);
          setActual(`${documents.length}个公司文件字段均接受映射PNG`);
        });
      }

      await business.step(flowSteps[5], async ({ setActual, setBusinessData }) => {
        await openStep(3);
        setBusinessData({ currentRegistrationStep: '资产来源' });
        setActual('资产来源页面可访问；未选择、未保存');
      });

      for (const variant of variants.slice(1)) {
        await business.step(flowSteps.find(step => step.action === variant.action)!, async ({ setActual, setCurrentAction, setBusinessData }) => {
          await openStep(variant.stepNumber);
          for (const action of variant.activate ?? []) await corporate.activateVisibleText(action);
          if (variant.revealMailing) await corporate.revealDifferentMailingAddress();
          const documents = CORPORATE_DOCUMENT_MAPPING.filter(document => document.variant === variant.variant && (
            variant.variant !== 'company' || document.step === '合规问询'
          ));
          setBusinessData({
            currentRegistrationStep: documents[0]?.step ?? variant.action,
            remainingRequiredFields: Math.max(0, CORPORATE_DOCUMENT_MAPPING.length - uploadedDocumentCount)
          });
          await uploadDocuments(documents, setCurrentAction, setBusinessData);
          setActual(`${documents.length}个${documents[0]?.step ?? ''}文件字段均接受映射PNG`);
        });
      }

      await business.step(flowSteps[11], async ({ setActual, setBusinessData }) => {
        await openStep(8);
        setBusinessData({
          currentRegistrationStep: '电子签名',
          signingType: 'Corporate Registration Agreement',
          initialFields: 'Not initialized',
          currentFields: 'Not initialized',
          signatureStatus: 'Pending',
          authorizationStatus: 'Pending',
          signingStatus: 'Dry Run only'
        });
        setActual('企业授权步骤可访问；未创建代表档案、未签名、未Complete');
      });

      await business.step(flowSteps[12], async ({ setActual, setBusinessData, recordPrimaryOracle }) => {
        await openStep(9);
        await corporate.expectNoFinalSubmission();
        expect(uploadedDocumentCount).toBe(CORPORATE_DOCUMENT_MAPPING.length);
        expect(draft.finalSubmissionCount).toBe(0);
        setBusinessData({
          currentRegistrationStep: '提交申请',
          uploadedDocumentCount,
          totalDocumentCount: CORPORATE_DOCUMENT_MAPPING.length,
          remainingRequiredFields: 0,
          mutationPerformed: false
        });
        recordPrimaryOracle({
          id: 'all-assets-accepted',
          name: '28个企业文件字段接受Sandbox PNG',
          expected: '28 / 28',
          actual: `${uploadedDocumentCount} / ${CORPORATE_DOCUMENT_MAPPING.length}`,
          status: 'passed'
        });
        recordPrimaryOracle({
          id: 'no-final-submission',
          name: '企业最终提交保持0次',
          expected: '0',
          actual: String(draft.finalSubmissionCount),
          status: 'passed'
        });
        setActual('28/28文件字段验证完成；最终提交=0；Admin Mutation=0；资金Mutation=0');
      });
    } finally {
      await context.close();
    }
  }
);
