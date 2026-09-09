import { expect, test } from '../../../fixtures/registration.fixture';

import { CorporateRegistrationPage } from '../../../pages/client/CorporateRegistrationPage';
import { env } from '../../../src/config/env';
import {
  CORPORATE_DOCUMENT_MAPPING,
  loadCorporateDraft
} from '../../../src/registration';
import { refreshCorporateDraftAuthentication } from './corporate-registration.helpers';

const steps = [
  '基本档案',
  '运营信息',
  '资产来源',
  '合规问询',
  '授权代表',
  '企业董事',
  '企业股东',
  '电子签名',
  '提交申请'
] as const;

const businessSteps = [
  { action: '恢复Corporate Draft认证', expected: '现有企业Draft登录有效且未最终提交' },
  { action: '验证企业注册步骤', expected: '9个真实企业注册步骤全部可见' },
  { action: '验证运营信息上传契约', expected: '7个公司资料上传字段和格式契约正确' },
  { action: '验证合规问询上传契约', expected: '可选AML文件上传字段和格式契约正确' },
  { action: '验证授权代表上传契约', expected: '授权代表必需上传字段可定位且不提交' }
] as const;

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for Corporate Registration Validation.`);
  return value;
}

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'REG-C-001 Corporate Registration Validation @registration @corporate @validation @L1',
  async ({ browser, business }) => {
    business.flow('corporate-registration-validation');
    business.plan(businessSteps);
    const draft = loadCorporateDraft();
    if (!draft) throw new Error('Corporate Registration Draft is required for REG-C-001.');
    expect(draft.finalSubmissionCount).toBe(0);

    const clientBaseUrl = required('CLIENT_BASE_URL', env.client.baseUrl);
    const overviewUrl = new URL('/zh-CN/registration?type=corporate', clientBaseUrl).toString();
    const context = await browser.newContext({
      baseURL: clientBaseUrl,
      storageState: { cookies: [], origins: [] }
    });
    const page = await context.newPage();
    const corporate = new CorporateRegistrationPage(page);
    try {
      await business.step(businessSteps[0], async ({ setActual, setBusinessData }) => {
        await refreshCorporateDraftAuthentication({
          page,
          context,
          email: draft.email,
          returnUrl: overviewUrl
        });
        business.setCurrentUrl(page.url());
        await corporate.expectOpen();
        setBusinessData({
          accountType: 'Corporate',
          currentRegistrationStep: '步骤总览',
          totalDocumentCount: CORPORATE_DOCUMENT_MAPPING.length,
          uploadedDocumentCount: 0,
          resumeStage: draft.stage,
          mutationPerformed: false
        });
        setActual(`Corporate Draft认证有效；Resume=${draft.stage}；最终提交次数=0`);
      });

      await business.step(businessSteps[1], async ({ setActual }) => {
        for (const step of steps) await expect(corporate.stepCard(step)).toBeVisible();
        setActual('9个企业注册步骤全部可见');
      });

      await business.step(businessSteps[2], async ({ setActual, setBusinessData }) => {
        await corporate.openAvailableStep('运营信息');
        business.setCurrentUrl(page.url());
        await corporate.expectUploadFields(
          CORPORATE_DOCUMENT_MAPPING
            .filter(document => document.step === '运营信息')
            .map(document => document.pageLabel)
        );
        setBusinessData({ currentRegistrationStep: '运营信息' });
        setActual('7个公司资料上传字段可定位，支持PNG/JPG/PDF，未选择文件');
      });

      await business.step(businessSteps[3], async ({ setActual, setBusinessData }) => {
        await page.goto(overviewUrl, { waitUntil: 'domcontentloaded' });
        await corporate.expectOpen();
        await corporate.openAvailableStep('合规问询');
        business.setCurrentUrl(page.url());
        await corporate.expectUploadFields(['反洗钱手册（可选）']);
        setBusinessData({ currentRegistrationStep: '合规问询' });
        setActual('AML可选上传字段可定位，未选择文件');
      });

      await business.step(businessSteps[4], async ({ setActual, setBusinessData, recordPrimaryOracle }) => {
        await page.goto(overviewUrl, { waitUntil: 'domcontentloaded' });
        await corporate.expectOpen();
        await corporate.openAvailableStep('授权代表');
        business.setCurrentUrl(page.url());
        await corporate.expectUploadFields(['证件正面', '证件反面（可选）', '居住地址证明']);
        expect(draft.finalSubmissionCount).toBe(0);
        setBusinessData({ currentRegistrationStep: '授权代表', mutationPerformed: false });
        recordPrimaryOracle({
          id: 'no-corporate-submission',
          name: '企业最终提交保持0次',
          expected: '0',
          actual: String(draft.finalSubmissionCount),
          status: 'passed'
        });
        setActual('授权代表上传契约正确；最终提交=0；Mutation=No');
      });
    } finally {
      await context.close();
    }
  }
);
