import { expect, type Page } from '@playwright/test';

import type { AccountOpeningAdminRecord } from './AccountOpeningReviewPage';
import { AccountOpeningApprovalPage } from './AccountOpeningApprovalPage';

const DOCUMENT_FIELDS = [
  '护照文件',
  '身份证明文件',
  '自拍照',
  '地址证明',
  '资金来源证明'
] as const;

export type AccountOpeningAdminDetail = {
  applicationId: string;
  customerText: string;
  accountType: string;
  submittedAt: string;
  uploadedDocumentFields: string[];
  fatcaSectionPresent: boolean;
  fatcaDocumentViewAvailable: boolean;
  failureReason?: string;
};

export class AccountOpeningDetailPage {
  constructor(readonly page: Page) {}

  async goto(url: string, applicationId: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await expect(this.page).toHaveURL(/\/kyc\/accountReviews\/[^/?]+\?reviewId=/);
    if (new URL(this.page.url()).searchParams.get('reviewId') !== applicationId) {
      throw new Error('Admin Account Opening detail reviewId changed during navigation.');
    }
    await expect(this.page.getByRole('heading', { name: '详细信息', exact: true })).toBeVisible({
      timeout: 20_000
    });
  }

  async readDetail(applicationId: string): Promise<AccountOpeningAdminDetail> {
    const bodyText = (await this.page.locator('body').innerText()).replace(/\u00a0/g, ' ');
    const accountType = bodyText.match(/账户类型[：:]\s*(美国账户|新加坡账户|巴林账户)/)?.[1];
    const submittedAt = bodyText.match(/20\d{2}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}(?::\d{2})?/)?.[0];
    if (!accountType || !submittedAt) {
      throw new Error('Admin Account Opening detail is missing account type or submitted time.');
    }

    const uploadedDocumentFields: string[] = [];
    for (const field of DOCUMENT_FIELDS) {
      const heading = this.page.getByRole('heading', { name: field, exact: true });
      if ((await heading.count()) === 1 && await heading.isVisible()) {
        uploadedDocumentFields.push(field);
      }
    }

    const fatcaHeading = this.page.getByRole('heading', {
      name: 'FATCA 第三方文档签署',
      exact: true
    });
    const fatcaSectionPresent = (await fatcaHeading.count()) === 1 && await fatcaHeading.isVisible();
    let fatcaDocumentViewAvailable = false;
    if (fatcaSectionPresent) {
      const section = fatcaHeading.locator('..').locator('..');
      const view = section.getByRole('button', { name: '查看', exact: true });
      fatcaDocumentViewAvailable = (await view.count()) === 1 && await view.isVisible();
    }

    const failureReason = bodyText.match(/(?:失败原因|第三方失败原因)[：:]\s*([^\n]+)/)?.[1]?.trim();
    return {
      applicationId,
      customerText: bodyText,
      accountType,
      submittedAt,
      uploadedDocumentFields,
      fatcaSectionPresent,
      fatcaDocumentViewAvailable,
      failureReason
    };
  }

  async openApproval(record: AccountOpeningAdminRecord): Promise<AccountOpeningApprovalPage> {
    if (!record.processUrl || !record.applicationId) {
      throw new Error('Account Opening candidate has no process URL or reviewId.');
    }
    const approval = new AccountOpeningApprovalPage(this.page);
    await approval.goto(record.processUrl, record.applicationId);
    return approval;
  }
}
