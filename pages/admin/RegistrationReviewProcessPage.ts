import { expect, type Locator, type Page, type Response } from '@playwright/test';

import type { RegistrationApprovalAccountType } from '../../src/registration';
import type { RegistrationReviewCandidate } from './RegistrationReviewDashboardPage';
import { decodeRegistrationKycCase, REGISTRATION_KYC, type RegistrationAccountType, type RegistrationKycCase } from '../../src/registration/registration-kyc-contract';

export type RegistrationApprovalResult = {
  requestPath?: string;
  httpStatus?: number;
  completionEvidence: 'route-changed' | 'form-hidden' | 'success-message';
};

export type RegistrationProcessState = {
  reviewId: string;
  reviewStep: string;
  memberStatus: number;
  memberKycStatus: number;
  clientAuthorizationStatus: number;
  kycStep: string;
  kycStepStatus: string;
  documents: Array<{ status: number; statusLabel: string }>;
  stages: Array<{ status: string; statusLabel: string }>;
};

function normalize(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

export class RegistrationReviewProcessPage {
  private approveClicks = 0;

  constructor(readonly page: Page) {}

  async readKycCase(accountType: RegistrationAccountType, processPath: string, baseURL: string): Promise<RegistrationKycCase> {
    const url = new URL(processPath, baseURL);
    if (url.origin !== new URL(baseURL).origin || !/^\/zh-CN\/kyc\/processingReviews\/[^/]+\//.test(url.pathname)) {
      throw new Error('KYC process URL must belong to the original Sandbox Admin.');
    }
    const expectedPath = REGISTRATION_KYC[accountType].responsePath;
    // Resolve the pending observer even when navigation fails; never leave a rejected wait promise behind.
    const responsePromise = this.page.waitForResponse(response =>
      new URL(response.url()).origin === url.origin && new URL(response.url()).pathname === expectedPath,
      { timeout: 20_000 }
    ).then(async response => ({
      ok: response.ok(),
      body: await response.text()
    }), () => ({ ok: false, body: undefined }));
    await this.page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await expect(this.page).not.toHaveURL(/\/login|\/signin|\/sign-in/i);
    const response = await responsePromise;
    if (!response.ok || !response.body) throw new Error('KYC_CASE_STATE_UNAVAILABLE: authenticated business response not received.');
    const actual = new URL(this.page.url());
    if (actual.pathname !== url.pathname || actual.searchParams.get('reviewId') !== url.searchParams.get('reviewId')) {
      throw new Error('KYC_CASE_CHANGED_DURING_NAVIGATION');
    }
    return decodeRegistrationKycCase(accountType, JSON.parse(response.body), `${url.pathname}${url.search}`);
  }

  async expectCurrentApprovalForm(): Promise<void> {
    await expect(this.page.getByRole('heading', { name: '审核决定', exact: true })).toBeVisible();
    await expect(this.decisionCombobox).toBeVisible();
    await expect(this.noteInput).toBeVisible();
    await expect(this.submitButton).toBeVisible();
  }

  async gotoProcessUrl(processUrl: string): Promise<RegistrationProcessState> {
    const responsePromise = this.page.waitForResponse(response =>
      new URL(response.url()).pathname === '/admin-api/operation/kyc/process',
      { timeout: 20_000 }
    ).then(async response => ({
      ok: response.ok(),
      status: response.status(),
      body: await response.text()
    }));
    await this.page.goto(processUrl, { waitUntil: 'domcontentloaded' });
    await expect(this.page).not.toHaveURL(/\/login|\/signin|\/sign-in/i);
    await expect(this.page.getByRole('heading', { name: '审核决定', exact: true })).toBeVisible({
      timeout: 20_000
    });
    const response = await responsePromise;
    if (!response.ok) throw new Error(`KYC process state returned HTTP ${response.status}.`);
    const payload = JSON.parse(response.body) as {
      data?: {
        reviewId?: number | string;
        reviewStep?: string;
        member?: { status?: number; kycStatus?: number };
        kyc?: {
          clientAuthorizationStatus?: number;
          kycStep?: string;
          kycStepStatus?: string;
        };
        documents?: Array<{ status?: number; statusLabel?: string }>;
        stages?: Array<{ status?: string; statusLabel?: string }>;
      };
    };
    const data = payload.data;
    if (!data?.reviewId || !data.reviewStep) throw new Error('KYC process state is missing review metadata.');
    return {
      reviewId: String(data.reviewId),
      reviewStep: data.reviewStep,
      memberStatus: data.member?.status ?? -1,
      memberKycStatus: data.member?.kycStatus ?? -1,
      clientAuthorizationStatus: data.kyc?.clientAuthorizationStatus ?? -1,
      kycStep: data.kyc?.kycStep ?? '',
      kycStepStatus: data.kyc?.kycStepStatus ?? '',
      documents: (data.documents ?? []).map(document => ({
        status: document.status ?? -1,
        statusLabel: document.statusLabel ?? ''
      })),
      stages: (data.stages ?? []).map(stage => ({
        status: stage.status ?? '',
        statusLabel: stage.statusLabel ?? ''
      }))
    };
  }

  async goto(candidate: RegistrationReviewCandidate): Promise<void> {
    await this.page.goto(candidate.processUrl, { waitUntil: 'domcontentloaded' });
    await expect(this.page).not.toHaveURL(/\/login|\/signin|\/sign-in/i);
    const current = new URL(this.page.url());
    const actualReviewId = current.searchParams.get('reviewId') ??
      current.pathname.match(/\/processingReviews\/([^/]+)/)?.[1];
    if (actualReviewId !== candidate.reviewId) {
      throw new Error('Registration process reviewId changed during navigation.');
    }
    await expect(this.page.getByRole('heading', { name: '审核决定', exact: true })).toBeVisible({
      timeout: 20_000
    });
    await expect(this.decisionCombobox).toBeVisible();
    await expect(this.noteInput).toBeVisible();
    await expect(this.submitButton).toBeVisible();
  }

  async verifyIdentityAndType(input: {
    accountType: RegistrationApprovalAccountType;
    displayName: string;
    registrationNumber?: string;
  }): Promise<void> {
    await expect(this.page.getByText(input.displayName, { exact: true }).first()).toBeVisible();
    await expect(
      this.page.getByText(input.accountType === 'personal' ? '个人客户' : '企业客户', { exact: true }).first()
    ).toBeVisible();
    if (input.registrationNumber) {
      await expect(this.page.getByText(input.registrationNumber, { exact: true }).first()).toBeVisible();
    }
  }

  async verifyCorporateSubmissionCompleteness(): Promise<void> {
    const requiredTabs = ['基本档案', '运营信息', '资产来源', '合规审查', '授权代表'];
    for (const tabName of requiredTabs) {
      await expect(this.page.getByRole('tab', { name: tabName, exact: true })).toBeVisible();
    }

    await this.openTabAndExpectContent('董事', /DIRECTOR NATURAL|自然人/);
    await this.openTabAndExpectContent('股东', /SHAREHOLDER NATURAL|个人股东/);
    await this.openTabAndExpectContent('电子签名', /已签署/);
  }

  async fillApprovalForm(note: string): Promise<void> {
    if (!note.trim()) throw new Error('Registration approval note is required.');
    await this.decisionCombobox.click();
    const approveOption = this.page.getByRole('option', { name: '通过审核', exact: true });
    await expect(approveOption).toHaveCount(1);
    await approveOption.click();
    await this.noteInput.fill(note);
    await expect(this.noteInput).toHaveValue(note);
    await expect(this.submitButton).toBeEnabled();
  }

  async confirmApproveOnce(): Promise<RegistrationApprovalResult> {
    if (this.approveClicks !== 0) {
      throw new Error('Registration Admin Approve may be clicked only once per run.');
    }
    await expect(this.submitButton).toBeEnabled();

    const mutationResponses: Array<{ requestPath: string; httpStatus: number }> = [];
    const capture = (response: Response) => {
      const request = response.request();
      if (request.method().toUpperCase() === 'GET') return;
      const url = new URL(response.url());
      if (url.origin !== new URL(this.page.url()).origin) return;
      if (!/\/admin-api\/(?:member\/review|operation\/ky[cb])/.test(url.pathname)) return;
      mutationResponses.push({ requestPath: url.pathname, httpStatus: response.status() });
    };

    this.page.on('response', capture);
    this.approveClicks += 1;
    try {
      await this.submitButton.click();

      const dialog = this.page.getByRole('dialog').filter({ visible: true });
      let confirmationVisible = false;
      await expect.poll(async () => {
        if ((await dialog.count()) === 1 && await dialog.isVisible()) {
          confirmationVisible = true;
          return true;
        }
        if (!/\/process(?:$|[?#])/.test(this.page.url())) return true;
        if (!(await this.submitButton.isVisible())) return true;
        const success = this.page.getByText(/审核.*成功|操作成功|提交成功/).first();
        return (await success.count()) === 1 && await success.isVisible();
      }, {
        timeout: 10_000,
        intervals: [250, 500, 1_000],
        message: 'Registration approval click produced neither confirmation nor completion evidence.'
      }).toBe(true);

      if (confirmationVisible) {
        const confirm = dialog.getByRole('button', { name: /^(确认|确定|确认通过|确认提交|通过)$/ });
        if ((await confirm.count()) !== 1) {
          throw new Error('Registration approval confirmation dialog has no unique confirm action.');
        }
        await confirm.click();
      }

      let completionEvidence: RegistrationApprovalResult['completionEvidence'] = 'form-hidden';
      await expect.poll(async () => {
        const success = this.page.getByText(/审核.*成功|操作成功|提交成功/).first();
        if ((await success.count()) === 1 && await success.isVisible()) {
          completionEvidence = 'success-message';
          return true;
        }
        if (!/\/process(?:$|[?#])/.test(this.page.url())) {
          completionEvidence = 'route-changed';
          return true;
        }
        if (!(await this.submitButton.isVisible())) {
          completionEvidence = 'form-hidden';
          return true;
        }
        return false;
      }, {
        timeout: 30_000,
        intervals: [500, 1_000, 2_000],
        message: 'Registration Admin Approve was clicked once but no completion evidence appeared.'
      }).toBe(true);

      const response = mutationResponses.at(-1);
      return {
        requestPath: response?.requestPath,
        httpStatus: response?.httpStatus,
        completionEvidence
      };
    } finally {
      this.page.off('response', capture);
    }
  }

  approvalClickCount(): number {
    return this.approveClicks;
  }

  private get decisionCombobox(): Locator {
    return this.page.getByRole('combobox').first();
  }

  private get noteInput(): Locator {
    return this.page.getByPlaceholder('请说明审核决定的原因...').first();
  }

  private get submitButton(): Locator {
    return this.page.getByRole('button', { name: '确认提交', exact: true });
  }

  private async openTabAndExpectContent(tabName: string, content: RegExp): Promise<void> {
    const tab = this.page.getByRole('tab', { name: tabName, exact: true });
    await expect(tab).toBeVisible();
    await tab.click();
    const text = normalize(await this.page.locator('main').innerText());
    expect(text).toMatch(content);
  }
}
