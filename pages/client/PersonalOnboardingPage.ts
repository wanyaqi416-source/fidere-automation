import { existsSync, statSync } from 'node:fs';
import { basename, extname, relative, resolve } from 'node:path';

import { expect, type Locator, type Page, type Response } from '@playwright/test';

import type { PersonalRegistrationProfile } from '../../src/registration';

type PersonalOnboardingInput = {
  profile: PersonalRegistrationProfile;
  phone: string;
  idNumber: string;
  taxNumber: string;
  addressProofPath: string;
};

export type PersonalAddressProofUploadEvidence = {
  fieldLabel: 'Residential Address Proof';
  required: false;
  fileName: string;
  extension: string;
  sizeBytes: number;
  accept: string;
  inputName: string;
  selected: true;
  validationErrorVisible: false;
};

export type AuthorizationDocumentCreationEvidence = {
  requestObserved: true;
  host: string;
  path: string;
  method: 'POST';
  httpStatus: number;
  observedAt: string;
  documentPayloadPresent: boolean;
  payloadKind: 'token' | 'signingUrl' | 'both' | 'unknown';
  businessCode?: string;
  safeMessage?: string;
};

export type PersonalProfileSubmissionEvidence = {
  requestObserved: true;
  host: string;
  path: string;
  method: 'POST';
  httpStatus: number;
  observedAt: string;
  businessCode?: string;
  memberStatus?: string;
  safeMessage?: string;
  redirectedToSignSuccess: true;
  pendingReviewPageVisible: true;
  pendingReviewIndicator: string;
};

export type PersonalOnboardingStep =
  | 'account-type'
  | 'personal'
  | 'contact'
  | 'tax'
  | 'authorization'
  | 'completed';

export type FinalSubmitReadiness = {
  buttonType: string;
  buttonDisabled: boolean;
  ariaDisabled: string | null;
  formPresent: boolean;
  formValid: boolean | null;
  invalidControls: Array<{
    name: string;
    type: string;
    required: boolean;
  }>;
};

export type FinalSubmitDomDiagnostics = FinalSubmitReadiness & {
  currentPath: string;
  buttonClass: string;
  reactHandlerReady: boolean;
  buttonReceivesPointer: boolean;
  topmostElement: string;
  iframeCount: number;
  visibleIframeCount: number;
  visibleDocumensoIframeCount: number;
  visibleDialogCount: number;
  visibleProgressbarCount: number;
  visibleBackdropCount: number;
};

export type FinalSubmitBlockCondition =
  | 'NONE'
  | 'SIGNATURE_REF_FALSE'
  | 'FORM_INVALID'
  | 'BUTTON_DISABLED'
  | 'POINTER_BLOCKED'
  | 'UNKNOWN_NO_REQUEST'
  | 'REQUEST_WITHOUT_RESPONSE'
  | 'REQUEST_COMPLETED_WITHOUT_WAITING_REVIEW';

export type FinalSubmitAttemptDiagnostic = {
  attempt: number;
  clicked: true;
  requestObserved: boolean;
  memberProfileRequestCount: number;
  responseObserved: boolean;
  responseStatus?: number;
  blockedCondition: FinalSubmitBlockCondition;
  signBeforeSubmitMessageObserved: boolean;
  signBeforeSubmitMessage?: string;
  consoleErrors: string[];
  pageErrors: string[];
  before: FinalSubmitDomDiagnostics;
  after: FinalSubmitDomDiagnostics;
};

export type PersonalProfileSubmitAttempt = {
  diagnostic: FinalSubmitAttemptDiagnostic;
  evidence?: PersonalProfileSubmissionEvidence;
};

const optionPatterns: Record<string, RegExp> = {
  passport: /护照|Passport/i,
  male: /^男$|^Male$/i,
  single: /单身|Single/i,
  HK: /香港|Hong Kong/i,
  custody: /托管|Custody/i,
  salary: /工资|薪金|Salary/i,
  'below-250k': /250[,，]?000.*以下|低于\s*\$?250k|Below\s*\$?250k/i,
  'custody-services': /托管.*服务|Custody.*services/i,
  employed: /^受雇$|^Employed$/i,
  'information-technology': /^信息技术$|^Information Technology$/i,
  'entry-specialist': /基层员工.*专员|Entry.*Specialist/i,
  no: /^否$|^No$/i
};

async function readCreateKycDocEvidence(
  response: Response
): Promise<AuthorizationDocumentCreationEvidence> {
  const responseText = await response.text();
  const jsonStart = responseText.indexOf('{');
  if (jsonStart < 0) {
    throw new Error(
      `create-kyc-doc returned HTTP ${response.status()} without a JSON payload.`
    );
  }
  const payload = JSON.parse(responseText.slice(jsonStart)) as {
    data?: { token?: unknown; signingUrl?: unknown };
    token?: unknown;
    signingUrl?: unknown;
    code?: unknown;
    message?: unknown;
    msg?: unknown;
  };
  const data = payload.data ?? payload;
  const hasToken = typeof data.token === 'string' && data.token.length > 0;
  const hasSigningUrl = typeof data.signingUrl === 'string' && data.signingUrl.length > 0;
  const url = new URL(response.url());
  return {
    requestObserved: true,
    host: url.hostname,
    path: url.pathname,
    method: 'POST',
    httpStatus: response.status(),
    observedAt: new Date().toISOString(),
    documentPayloadPresent: hasToken || hasSigningUrl,
    businessCode: payload.code == null ? undefined : String(payload.code),
    safeMessage: typeof payload.message === 'string'
      ? payload.message.slice(0, 300)
      : typeof payload.msg === 'string'
        ? payload.msg.slice(0, 300)
        : undefined,
    payloadKind: hasToken && hasSigningUrl
      ? 'both'
      : hasToken
        ? 'token'
        : hasSigningUrl
          ? 'signingUrl'
          : 'unknown'
  };
}

async function readProfileSubmissionEvidence(
  response: Response
): Promise<Omit<
  PersonalProfileSubmissionEvidence,
  'redirectedToSignSuccess' | 'pendingReviewPageVisible' | 'pendingReviewIndicator'
>> {
  const responseText = await response.text();
  const jsonStart = responseText.indexOf('{');
  if (jsonStart < 0) {
    throw new Error(
      `member-profile returned HTTP ${response.status()} without a JSON payload.`
    );
  }
  const payload = JSON.parse(responseText.slice(jsonStart)) as {
    data?: { status?: unknown; code?: unknown; message?: unknown; msg?: unknown };
    status?: unknown;
    code?: unknown;
    message?: unknown;
    msg?: unknown;
  };
  const data = payload.data ?? payload;
  const url = new URL(response.url());
  const message = payload.message ?? payload.msg ?? data.message ?? data.msg;
  return {
    requestObserved: true,
    host: url.hostname,
    path: url.pathname,
    method: 'POST',
    httpStatus: response.status(),
    observedAt: new Date().toISOString(),
    businessCode: payload.code == null
      ? data.code == null ? undefined : String(data.code)
      : String(payload.code),
    memberStatus: data.status == null ? undefined : String(data.status),
    safeMessage: typeof message === 'string' ? message.slice(0, 300) : undefined
  };
}

function sanitizeRuntimeMessage(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[masked-email]')
    .replace(/\b1[3-9]\d{9}\b/g, '[masked-phone]')
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{24,}\b/gi, '[masked-value]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export class PersonalOnboardingPage {
  readonly nextButton: Locator;
  readonly submitButton: Locator;
  private authorizationDocumentRetryClicks = 0;
  private profileFinalSubmitClicks = 0;

  constructor(readonly page: Page) {
    this.nextButton = page.getByRole('button', { name: /下一步|Next Step/i });
    this.submitButton = page.getByRole('button', { name: /^提交$|^Submit$/i });
  }

  async expectPersonalInfoStep(): Promise<void> {
    await expect(this.page).toHaveURL(/\/zh-CN\/registration\?type=individual(?:&|$)/);
    await expect(this.input('first_name')).toBeVisible({ timeout: 30_000 });
    await expect(this.page.getByText(/个人信息|Personal Information/i).first()).toBeVisible();
  }

  async currentStep(): Promise<PersonalOnboardingStep> {
    const pathname = new URL(this.page.url()).pathname;
    if (/\/account-type-selection$/.test(pathname)) return 'account-type';
    if (/\/(?:sign-success|dashboard)$/.test(pathname)) return 'completed';
    if (/\/registration$/.test(pathname)) {
      let detected: PersonalOnboardingStep | undefined;
      await expect.poll(async () => {
        detected = await this.visibleRegistrationStep();
        return detected;
      }, {
        timeout: 30_000,
        intervals: [200, 400, 750, 1_000],
        message: 'Personal onboarding form did not render a recognized step.'
      }).not.toBeUndefined();
      return detected!;
    }
    throw new Error(`Unsupported personal onboarding state at ${pathname}.`);
  }

  async fillPersonalInformation(input: PersonalOnboardingInput): Promise<void> {
    await this.fillPersonalInformationForm(input);
    await this.continueFromPersonalInformation();
  }

  async fillPersonalInformationForm(input: PersonalOnboardingInput): Promise<void> {
    const { profile } = input;
    await this.fillText('first_name', profile.firstName);
    await this.fillText('last_name', profile.lastName);
    const idType = this.input('id_type').locator('..').getByRole('combobox');
    await expect(idType).toHaveCount(1);
    await expect(idType).toBeDisabled();
    await expect(idType).toContainText(this.option(profile.idType));
    await this.fillText('id_number', input.idNumber);
    await this.fillDate(/证件签发日期|ID Issue Date/i, profile.idIssueDate);
    await this.fillDate(/证件到期日期|ID Expiry Date/i, profile.idExpiryDate);
    await this.fillDate(/出生日期|Date of Birth/i, profile.dateOfBirth);
    await this.selectNamedAutocomplete(/出生地|Place of Birth/i, this.option(profile.placeOfBirth), '香港');
    await this.selectFieldOption('gender', this.option(profile.gender));
    await this.selectFieldOption('marital_status', this.option(profile.maritalStatus));
    await this.selectNamedAutocomplete(/国籍|Citizenship/i, this.option(profile.citizenship), '香港');
    await this.checkSectionOption(
      /开设账户\/申请服务的目的|purpose.*account|services/i,
      this.option(profile.accountPurpose)
    );
    await this.checkSectionOption(
      /交易的资金来源|source of funds/i,
      this.option(profile.sourceOfFunds)
    );
    await this.checkSectionOption(/财富来源|source of wealth/i, this.option(profile.sourceOfWealth));
    await this.selectFieldOption('career_status', this.option(profile.careerStatus));
    await this.fillText('employer_name', profile.employerName);
    await this.selectFieldOption('industry_type', this.option(profile.industryType));
    await this.selectFieldOption('career_position', this.option(profile.careerPosition));
    await this.checkRadio(this.option(profile.annualIncome));
    await this.checkSectionOption(
      /预期将涉及的资产类别|anticipated asset classes/i,
      this.option(profile.anticipatedAssetClass)
    );
    await this.selectFieldOption('third_parties_in_out', this.option(profile.thirdPartyDeposits));
    await expect(this.nextButton).toBeEnabled();
  }

  async expectLegalName(firstName: string, lastName: string): Promise<void> {
    if (!/^[A-Z]+(?: [A-Z]+)*$/.test(firstName) || !/^[A-Z]+(?: [A-Z]+)*$/.test(lastName)) {
      throw new Error('Personal registration legal name must use uppercase alphabetic words.');
    }
    await expect(this.input('first_name')).toHaveValue(firstName);
    await expect(this.input('last_name')).toHaveValue(lastName);
  }

  async continueFromPersonalInformation(): Promise<void> {
    await this.goNextTo('phone');
  }

  async fillContactInformation(
    input: PersonalOnboardingInput
  ): Promise<PersonalAddressProofUploadEvidence> {
    const { profile } = input;
    await this.fillText('phone', input.phone);
    await this.fillText('street_address', profile.streetAddress);
    await this.fillText('detailed_address', profile.detailedAddress);
    await this.fillText('city', profile.city);
    await this.fillText('state_region', profile.stateRegion);
    await this.fillText('postal_code', profile.postalCode);
    await this.selectNamedAutocomplete(/国家|Country/i, this.option(profile.country), '香港');
    const addressProof = await this.uploadAddressProof(input.addressProofPath);
    await this.goNextTo('tax_number');
    return addressProof;
  }

  async uploadAddressProof(assetPath: string): Promise<PersonalAddressProofUploadEvidence> {
    const absolutePath = resolve(process.cwd(), assetPath);
    const workspaceRelativePath = relative(process.cwd(), absolutePath);
    if (workspaceRelativePath.startsWith('..') || workspaceRelativePath === '') {
      throw new Error('Personal address proof must be a file inside the workspace.');
    }
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      throw new Error('Personal registration Sandbox address-proof asset is missing.');
    }

    const input = await this.addressProofInput();
    await expect(
      this.page.getByText(/居住地址证明.*选填|Residential Address Proof.*Optional/i).first()
    ).toBeVisible();
    await expect(
      this.page.getByText(/PDF.*JPG.*PNG.*10\s*MB/i).first()
    ).toBeVisible();
    const accept = (await input.getAttribute('accept')) ?? '';
    const extension = extname(absolutePath).toLowerCase();
    const normalizedAccept = accept.toLowerCase();
    const acceptsAsset = !accept ||
      normalizedAccept.includes(extension) ||
      (['.png', '.jpg', '.jpeg'].includes(extension) && normalizedAccept.includes('image/')) ||
      (extension === '.pdf' && normalizedAccept.includes('application/pdf'));
    if (!acceptsAsset) {
      throw new Error(`Personal address-proof field does not accept ${extension || 'this file type'}.`);
    }
    if (statSync(absolutePath).size > 10 * 1024 * 1024) {
      throw new Error('Personal address-proof asset exceeds the page limit of 10 MB.');
    }

    await input.setInputFiles(absolutePath);
    const fileName = basename(absolutePath);
    await expect.poll(() => input.evaluate(element => {
      const fileInput = element as HTMLInputElement;
      return fileInput.files?.[0]?.name ?? '';
    }), {
      timeout: 15_000,
      intervals: [200, 400, 750, 1_000],
      message: 'Personal address-proof input did not retain the selected Sandbox file.'
    }).toBe(fileName);

    const validationError = this.page.getByText(
      /地址证明.*(?:必填|格式|大小|失败)|Proof of Address.*(?:required|format|size|failed)/i
    );
    await expect(validationError).toHaveCount(0);
    await expect(this.nextButton).toBeEnabled();

    return {
      fieldLabel: 'Residential Address Proof',
      required: false,
      fileName,
      extension,
      sizeBytes: statSync(absolutePath).size,
      accept,
      inputName: (await input.getAttribute('name')) ?? 'unlabelled-file-input',
      selected: true,
      validationErrorVisible: false
    };
  }

  async fillTaxResidency(
    input: PersonalOnboardingInput
  ): Promise<AuthorizationDocumentCreationEvidence> {
    const hongKongTaxSwitch = this.input('tax_region_in_hongkong');
    if (await hongKongTaxSwitch.count()) {
      await expect(hongKongTaxSwitch).toBeChecked();
    }
    await this.fillText('tax_number', input.taxNumber);
    await expect(this.nextButton).toBeEnabled();
    const creationResponsePromise = this.page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method().toUpperCase() === 'POST' &&
        url.pathname.endsWith('/create-kyc-doc');
    }, { timeout: 30_000 });
    await this.nextButton.click();
    const creationResponse = await creationResponsePromise;
    await expect.poll(() => this.visibleRegistrationStep(), {
      timeout: 30_000,
      intervals: [300, 500, 750, 1_000],
      message: 'Tax residency save did not enter the authorization step.'
    }).toBe('authorization');

    return readCreateKycDocEvidence(creationResponse);
  }

  async isFinalSubmitEnabled(): Promise<boolean> {
    return await this.submitButton.isVisible() && await this.submitButton.isEnabled();
  }

  async isFinalSubmitHandlerReady(): Promise<boolean> {
    return this.submitButton.evaluate(button => {
      const hasReactHandler = (element: Element | null, handlerName: string): boolean => {
        if (!element) return false;
        const record = element as unknown as Record<string, unknown>;
        return Object.keys(record).some(key => {
          if (!key.startsWith('__reactProps$')) return false;
          const props = record[key];
          return typeof props === 'object' && props !== null &&
            typeof (props as Record<string, unknown>)[handlerName] === 'function';
        });
      };
      const value = button as HTMLButtonElement;
      return hasReactHandler(value, 'onClick') || hasReactHandler(value.form, 'onSubmit');
    });
  }

  async expectFinalSubmitHandlerReady(): Promise<true> {
    await expect.poll(() => this.isFinalSubmitHandlerReady(), {
      timeout: 20_000,
      intervals: [200, 400, 750, 1_000],
      message: 'Personal registration Submit is visible, but its React submission handler is not hydrated.'
    }).toBe(true);
    return true;
  }

  async inspectFinalSubmitReadiness(): Promise<FinalSubmitReadiness> {
    await expect(this.submitButton).toBeVisible();
    return this.submitButton.evaluate(button => {
      const element = button as HTMLButtonElement;
      const form = element.form;
      return {
        buttonType: element.type,
        buttonDisabled: element.disabled,
        ariaDisabled: element.getAttribute('aria-disabled'),
        formPresent: Boolean(form),
        formValid: form ? form.checkValidity() : null,
        invalidControls: form
          ? Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(':invalid'))
            .map(control => ({
              name: control.name || control.getAttribute('data-testid') || 'unnamed',
              type: control instanceof HTMLInputElement ? control.type : control.tagName.toLowerCase(),
              required: control.required
            }))
          : []
      };
    });
  }

  async inspectFinalSubmitDomDiagnostics(): Promise<FinalSubmitDomDiagnostics> {
    await expect(this.submitButton).toHaveCount(1);
    await expect(this.submitButton).toBeVisible();
    const readiness = await this.inspectFinalSubmitReadiness();
    const pointer = await this.submitButton.evaluate(button => {
      const element = button as HTMLButtonElement;
      const rect = element.getBoundingClientRect();
      const target = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2
      );
      const targetClass = target instanceof HTMLElement
        ? typeof target.className === 'string' ? target.className : ''
        : '';
      return {
        buttonClass: typeof element.className === 'string' ? element.className : '',
        buttonReceivesPointer: Boolean(
          target && (target === element || element.contains(target))
        ),
        topmostElement: target
          ? [
              target.tagName.toLowerCase(),
              target.getAttribute('role') ?? '',
              targetClass
            ].filter(Boolean).join(' ').slice(0, 180)
          : 'none'
      };
    });
    const frames = this.page.locator('iframe');
    let visibleIframeCount = 0;
    let visibleDocumensoIframeCount = 0;
    for (const frame of await frames.all()) {
      if (!await frame.isVisible()) continue;
      visibleIframeCount += 1;
      const src = await frame.getAttribute('src');
      if (!src) continue;
      try {
        if (new URL(src, this.page.url()).hostname === 'app.documenso.com') {
          visibleDocumensoIframeCount += 1;
        }
      } catch {
        // An invalid iframe URL is reported by the aggregate count without exposing its value.
      }
    }
    return {
      ...readiness,
      currentPath: new URL(this.page.url()).pathname,
      buttonClass: pointer.buttonClass,
      reactHandlerReady: await this.isFinalSubmitHandlerReady(),
      buttonReceivesPointer: pointer.buttonReceivesPointer,
      topmostElement: pointer.topmostElement,
      iframeCount: await frames.count(),
      visibleIframeCount,
      visibleDocumensoIframeCount,
      visibleDialogCount: await this.visibleCount(this.page.getByRole('dialog')),
      visibleProgressbarCount: await this.visibleCount(this.page.getByRole('progressbar')),
      visibleBackdropCount: await this.visibleCount(this.page.locator('.MuiBackdrop-root'))
    };
  }

  async reloadAuthorizationForFinalSubmitRecovery(): Promise<AuthorizationDocumentCreationEvidence> {
    const responsePromise = this.page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method().toUpperCase() === 'POST' &&
        url.pathname.endsWith('/create-kyc-doc');
    }, { timeout: 30_000 });
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    const response = await responsePromise;
    await expect.poll(() => this.visibleRegistrationStep(), {
      timeout: 30_000,
      intervals: [200, 400, 750, 1_000],
      message: 'Personal registration recovery reload did not restore the authorization step.'
    }).toBe('authorization');
    return readCreateKycDocEvidence(response);
  }

  async isAuthorizationDocumentRetryVisible(): Promise<boolean> {
    return this.authorizationRetryButton().isVisible();
  }

  async attemptSignedRegistrationProfileSubmission(
    input: { requestTimeout?: number } = {}
  ): Promise<PersonalProfileSubmitAttempt> {
    await expect(this.submitButton).toHaveCount(1);
    await expect(this.submitButton).toBeVisible();
    await expect(this.submitButton).toBeEnabled();
    await this.submitButton.scrollIntoViewIfNeeded();
    await this.expectFinalSubmitHandlerReady();
    if (this.profileFinalSubmitClicks > 0) {
      throw new Error('Personal profile final Submit may be clicked only once per Journey run.');
    }

    const before = await this.inspectFinalSubmitDomDiagnostics();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    let memberProfileRequestCount = 0;
    const requestListener = (request: import('@playwright/test').Request): void => {
      const url = new URL(request.url());
      if (
        request.method().toUpperCase() === 'POST' &&
        url.pathname.endsWith('/member-profile')
      ) {
        memberProfileRequestCount += 1;
      }
    };
    const consoleListener = (message: import('@playwright/test').ConsoleMessage): void => {
      if (message.type() === 'error') {
        consoleErrors.push(sanitizeRuntimeMessage(message.text()));
      }
    };
    const pageErrorListener = (error: Error): void => {
      pageErrors.push(sanitizeRuntimeMessage(error.message));
    };
    this.page.on('request', requestListener);
    this.page.on('console', consoleListener);
    this.page.on('pageerror', pageErrorListener);
    await this.startSignBeforeSubmitCapture();

    const responsePromise = this.page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method().toUpperCase() === 'POST' &&
        url.pathname.endsWith('/member-profile');
    }, { timeout: input.requestTimeout ?? 8_000 }).catch(() => undefined);
    this.profileFinalSubmitClicks += 1;
    let response: Response | undefined;
    let responseEvidence: Awaited<ReturnType<typeof readProfileSubmissionEvidence>> | undefined;
    let evidence: PersonalProfileSubmissionEvidence | undefined;
    let waitingReviewObserved = false;
    try {
      await this.submitButton.click();
      response = await responsePromise;
      if (response) {
        responseEvidence = await readProfileSubmissionEvidence(response);
        const responseAccepted =
          response.status() >= 200 &&
          response.status() < 300 &&
          (!responseEvidence.businessCode || ['0', '200'].includes(responseEvidence.businessCode));
        if (responseAccepted) {
          try {
            await this.page.waitForURL(
              url => /\/zh-CN\/sign-success(?:$|[?#])/.test(url.toString()),
              { timeout: 20_000 }
            );
            const pendingReview = await this.expectPendingReviewPage();
            waitingReviewObserved = true;
            evidence = {
              ...responseEvidence,
              redirectedToSignSuccess: true,
              pendingReviewPageVisible: true,
              pendingReviewIndicator: pendingReview.indicator
            };
          } catch {
            waitingReviewObserved = false;
          }
        }
      }
    } finally {
      this.page.off('request', requestListener);
      this.page.off('console', consoleListener);
      this.page.off('pageerror', pageErrorListener);
    }

    const signBeforeSubmitMessage = await this.stopSignBeforeSubmitCapture();
    const submitStillVisible =
      (await this.submitButton.count()) === 1 && await this.submitButton.isVisible();
    const after = submitStillVisible
      ? await this.inspectFinalSubmitDomDiagnostics()
      : {
          ...before,
          currentPath: new URL(this.page.url()).pathname,
          buttonClass: 'not-present-after-navigation',
          reactHandlerReady: false,
          buttonReceivesPointer: false,
          topmostElement: 'submit-button-not-present'
        };
    let blockedCondition: FinalSubmitBlockCondition = 'NONE';
    if (!evidence) {
      if (memberProfileRequestCount > 0 && !response) {
        blockedCondition = 'REQUEST_WITHOUT_RESPONSE';
      } else if (response && !waitingReviewObserved) {
        blockedCondition = 'REQUEST_COMPLETED_WITHOUT_WAITING_REVIEW';
      } else if (signBeforeSubmitMessage) {
        blockedCondition = 'SIGNATURE_REF_FALSE';
      } else if (before.formValid === false) {
        blockedCondition = 'FORM_INVALID';
      } else if (before.buttonDisabled || before.ariaDisabled === 'true') {
        blockedCondition = 'BUTTON_DISABLED';
      } else if (!before.buttonReceivesPointer || before.visibleBackdropCount > 0) {
        blockedCondition = 'POINTER_BLOCKED';
      } else {
        blockedCondition = 'UNKNOWN_NO_REQUEST';
      }
    }

    return {
      diagnostic: {
        attempt: this.profileFinalSubmitClicks,
        clicked: true,
        requestObserved: memberProfileRequestCount > 0,
        memberProfileRequestCount,
        responseObserved: Boolean(response),
        responseStatus: response?.status(),
        blockedCondition,
        signBeforeSubmitMessageObserved: Boolean(signBeforeSubmitMessage),
        signBeforeSubmitMessage,
        consoleErrors,
        pageErrors,
        before,
        after
      },
      evidence
    };
  }

  async submitSignedRegistrationProfileOnce(): Promise<PersonalProfileSubmissionEvidence> {
    const attempt = await this.attemptSignedRegistrationProfileSubmission();
    if (!attempt.evidence) {
      throw new Error(
        `Personal profile Submit produced no completed business evidence; blocker=${attempt.diagnostic.blockedCondition}.`
      );
    }
    return attempt.evidence;
  }

  async expectPendingReviewPage(): Promise<{ indicator: string }> {
    await expect(this.page).toHaveURL(/\/zh-CN\/sign-success(?:$|[?#])/);
    const body = this.page.locator('body');
    await expect(body).toBeVisible();
    let indicator = '';
    await expect.poll(async () => {
      const pageText = (await body.innerText()).replace(/\s+/g, ' ').trim();
      const match = pageText.match(
        /(?:等待.{0,8}审核|待审核|审核(?:中|处理)|资料.{0,12}(?:已提交|审核)|提交成功|pending.{0,8}review|under.{0,8}review|review.{0,8}pending)/i
      );
      indicator = match?.[0] ?? '';
      return indicator.length > 0;
    }, {
      timeout: 20_000,
      intervals: [250, 500, 1_000],
      message: 'Personal registration did not display its submitted/waiting-for-review page.'
    }).toBe(true);
    return { indicator };
  }

  profileFinalSubmitClickCount(): number {
    return this.profileFinalSubmitClicks;
  }

  async retryAuthorizationDocumentOnce(): Promise<void> {
    const retry = this.authorizationRetryButton();
    await expect(retry).toBeVisible();
    await expect(retry).toBeEnabled();
    if (this.authorizationDocumentRetryClicks > 0) {
      throw new Error('Authorization document Retry may be clicked only once per Resume run.');
    }
    this.authorizationDocumentRetryClicks += 1;
    await retry.click();
  }

  authorizationDocumentRetryClickCount(): number {
    return this.authorizationDocumentRetryClicks;
  }

  private async visibleCount(locator: Locator): Promise<number> {
    let count = 0;
    for (const candidate of await locator.all()) {
      if (await candidate.isVisible()) count += 1;
    }
    return count;
  }

  private async startSignBeforeSubmitCapture(): Promise<void> {
    await this.page.evaluate(() => {
      type CaptureState = { messages: string[]; observer: MutationObserver };
      const target = window as unknown as { __fidereFinalSubmitCapture?: CaptureState };
      target.__fidereFinalSubmitCapture?.observer.disconnect();
      const messages: string[] = [];
      const capture = (): void => {
        const text = document.body?.innerText ?? '';
        const match = text.match(
          /(?:请先完成.{0,12}签署|请先签署.{0,16}(?:再|后).{0,12}提交|Please.{0,16}sign.{0,20}before.{0,16}submit)/i
        );
        if (match?.[0] && !messages.includes(match[0])) messages.push(match[0]);
      };
      const observer = new MutationObserver(capture);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });
      target.__fidereFinalSubmitCapture = { messages, observer };
      capture();
    });
  }

  private async stopSignBeforeSubmitCapture(): Promise<string | undefined> {
    return this.page.evaluate(() => {
      type CaptureState = { messages: string[]; observer: MutationObserver };
      const target = window as unknown as { __fidereFinalSubmitCapture?: CaptureState };
      const state = target.__fidereFinalSubmitCapture;
      state?.observer.disconnect();
      delete target.__fidereFinalSubmitCapture;
      return state?.messages[0];
    }).then(message => message ? sanitizeRuntimeMessage(message) : undefined);
  }

  private input(name: string): Locator {
    return this.page.locator(`[name="${name}"]`);
  }

  private async addressProofInput(): Promise<Locator> {
    const labelled = this.page.getByLabel(/地址证明|Proof of Address/i);
    if (await labelled.count() === 1 && await labelled.getAttribute('type') === 'file') {
      return labelled;
    }

    const named = this.page.locator([
      'input[type="file"][name="address_proof"]',
      'input[type="file"][name="proof_of_address"]',
      'input[type="file"][name="address_proof_file"]'
    ].join(', '));
    if (await named.count() === 1) return named;

    const contactFileInputs = this.page.locator('input[type="file"]');
    await expect(contactFileInputs).toHaveCount(1);
    return contactFileInputs;
  }

  private authorizationRetryButton(): Locator {
    return this.page.getByRole('button', { name: /^(?:重试|Retry)$/i });
  }

  private async visibleRegistrationStep(): Promise<PersonalOnboardingStep | undefined> {
    if (await this.input('first_name').isVisible()) return 'personal';
    if (await this.input('phone').isVisible()) return 'contact';
    if (await this.input('tax_number').isVisible()) return 'tax';
    if (
      await this.submitButton.isVisible() &&
      await this.page.getByRole('heading', { name: /授权|Authorization/i }).first().isVisible()
    ) {
      return 'authorization';
    }
    return undefined;
  }

  private option(value: string): RegExp {
    return optionPatterns[value] ?? new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  private async fillText(name: string, value: string): Promise<void> {
    const input = this.input(name);
    await expect(input).toHaveCount(1);
    await input.fill(value);
    await expect(input).toHaveValue(value);
  }

  private async fillDate(placeholder: RegExp, isoDate: string): Promise<void> {
    const input = this.page.getByPlaceholder(placeholder);
    await expect(input).toHaveCount(1);
    const candidates = [isoDate, isoDate.replace(/-/g, '/')];
    for (const value of candidates) {
      await input.fill(value);
      if ((await input.inputValue()).replace(/\//g, '-') === isoDate) return;
    }
    throw new Error(`Personal registration date field ${placeholder} rejected the Sandbox date.`);
  }

  private async checkRadio(pattern: RegExp): Promise<void> {
    const radio = this.page.getByRole('radio', { name: pattern });
    await expect(radio).toHaveCount(1);
    await radio.check();
    await expect(radio).toBeChecked();
  }

  private async selectNamedAutocomplete(
    accessibleName: RegExp,
    pattern: RegExp,
    searchTerm: string
  ): Promise<void> {
    const input = this.page.getByRole('combobox', { name: accessibleName });
    await expect(input).toHaveCount(1);
    await input.fill(searchTerm);
    await this.chooseVisibleOption(pattern);
  }

  private async checkSectionOption(headingName: RegExp, optionName: RegExp): Promise<void> {
    const section = this.page.getByRole('heading', { name: headingName }).locator('..');
    const option = section.getByRole('checkbox', { name: optionName });
    await expect(option).toHaveCount(1);
    await option.check();
    await expect(option).toBeChecked();
  }

  private async selectFieldOption(name: string, pattern: RegExp): Promise<void> {
    const radio = this.page.getByRole('radio', { name: pattern });
    if ((await radio.count()) === 1 && await radio.isVisible()) {
      await radio.check();
      return;
    }

    const input = this.input(name);
    await expect(input).toHaveCount(1);
    const role = await input.getAttribute('role');
    const control = role === 'combobox'
      ? input
      : input.locator('..').getByRole('combobox');
    await expect(control).toHaveCount(1);
    await control.click();
    await this.chooseVisibleOption(pattern);
  }

  private async chooseVisibleOption(pattern: RegExp): Promise<void> {
    const listbox = this.page.getByRole('listbox').last();
    await expect(listbox).toBeVisible();
    const option = listbox.getByRole('option', { name: pattern });
    await expect(option).toHaveCount(1);
    await option.click();
    if (await listbox.isVisible()) {
      await this.page.keyboard.press('Escape');
    }
  }

  private async goNextTo(nextFieldName: string): Promise<void> {
    await expect(this.nextButton).toBeEnabled();
    await this.nextButton.click();
    await expect(this.input(nextFieldName)).toBeVisible({ timeout: 30_000 });
  }
}
