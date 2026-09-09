import { expect, type Locator, type Page } from '@playwright/test';
import path from 'node:path';

import type {
  CorporateNaturalPersonProfile,
  CorporateRegistrationProfile
} from '../../src/registration/corporate-registration-profile';

export type CorporateControlSnapshot = {
  tag: string;
  type: string;
  role: string;
  label: string;
  placeholder: string;
  name: string;
  required: boolean;
  disabled: boolean;
  accept: string;
  multiple: boolean;
  text: string;
};

export type CorporateUploadSnapshot = CorporateControlSnapshot & {
  nearbyText: string;
  ancestorTrail: Array<{
    level: number;
    tag: string;
    className: string;
    text: string;
  }>;
};

export type CorporateComboboxSnapshot = {
  name: string;
  placeholder: string;
  nearbyText: string;
  options: string[];
};

export type CorporateUploadResult = {
  fileName: string;
  selected: boolean;
  alreadyUploaded: boolean;
  httpStatus?: number;
};

export class CorporateRegistrationPage {
  private authorizationTransitionClicks = 0;

  readonly pageRoot: Locator;
  readonly finalSubmitButton: Locator;

  constructor(readonly page: Page) {
    this.pageRoot = page.locator('main').or(page.locator('#root')).first();
    this.finalSubmitButton = page.getByRole('button', {
      name: /^(?:提交|完成|确认提交|Submit|Complete)$/
    });
  }

  async expectOpen(): Promise<void> {
    await expect(this.page).toHaveURL(/\/zh-CN\/registration\?(?:[^#]*&)?type=(?:corporate|company)(?:&|$)/);
    await expect(this.pageRoot).toBeVisible();
    await expect
      .poll(
        async () => {
          const controls = await this.inspectControls();
          return controls.filter(control => control.tag !== 'button' || control.label !== '语言').length;
        },
        {
          message: 'Corporate registration form did not finish loading.',
          timeout: 20_000
        }
      )
      .toBeGreaterThan(0);
  }

  async gotoStep(baseUrl: string, step: number): Promise<void> {
    await this.page.goto(
      new URL(`/zh-CN/registration?step=${step}&type=corporate`, baseUrl).toString(),
      { waitUntil: 'domcontentloaded' }
    );
    await this.expectOpen();
    const overview = this.page.getByRole('heading', { name: '企业注册流程', exact: true });
    if ((await overview.count()) === 1 && await overview.isVisible()) {
      const stepLabels: Record<number, string> = {
        1: '基本档案',
        2: '运营信息',
        3: '资产来源',
        4: '合规问询',
        5: '授权代表',
        6: '企业董事',
        7: '企业股东',
        8: '电子签名',
        9: '提交申请'
      };
      const label = stepLabels[step];
      if (!label) throw new Error(`Unsupported Corporate registration step: ${step}.`);
      await this.stepCard(label).click();
      await expect.poll(async () => {
        const currentOverview = this.page.getByRole('heading', {
          name: '企业注册流程',
          exact: true
        });
        return (await currentOverview.count()) === 0 || !await currentOverview.isVisible();
      }, {
        message: `Corporate overview did not open step ${step} (${label}).`,
        timeout: 20_000
      }).toBe(true);
    }
  }

  async expectStep(name: string): Promise<void> {
    const semanticHeading = this.page.getByRole('heading', { name, exact: true }).first();
    if ((await semanticHeading.count()) > 0 && await semanticHeading.isVisible()) return;
    await expect(this.page.getByText(name, { exact: true }).filter({ visible: true }).first())
      .toBeVisible({ timeout: 20_000 });
  }

  async fillBasicProfile(profile: CorporateRegistrationProfile): Promise<void> {
    await this.expectStep('基本档案信息');
    await this.fillNamed('entity_name', profile.companyName);
    await this.fillDate('请选择注册成立日期', profile.incorporationDate);
    await this.fillNamed('street', profile.registeredStreet);
    await this.fillNamed('state_province', profile.registeredState);
    await this.fillNamed('registration_number', profile.registrationNumber);
    await this.selectAutocomplete('请选择注册国家', profile.registrationCountry);
    await this.fillNamed('city', profile.registeredCity);
    await this.fillNamed('postal_code', profile.registeredPostalCode);
  }

  async expectCompanyName(expected: string): Promise<void> {
    await this.expectStep('基本档案信息');
    await expect(this.page.locator('input[name="entity_name"]')).toHaveValue(expected);
  }

  async fillOperations(input: {
    phone: string;
    email: string;
    businessNature: string;
  }): Promise<void> {
    await this.expectStep('运营信息');
    await this.fillNamed('mobile', input.phone);
    await this.fillNamed('email', input.email);
    await this.selectNamed('business_nature', new RegExp(`^${this.escapeRegex(input.businessNature)}$`));
    await this.selectNamed('mailingSameAsRegistered', /^(?:是|Yes)$/i);
  }

  async fillSourceOfAssets(value: string): Promise<void> {
    await this.expectStep('资产来源');
    await this.selectNamed('asset_source', new RegExp(`^${this.escapeRegex(value)}$`));
  }

  async fillCompliance(accountPurpose: string): Promise<void> {
    await this.expectStep('合规问询');
    await this.selectNamed('is_sanctioned', /^(?:否|No)$/i);
    await this.selectNamed('is_political_figure', /^(?:否|No)$/i);
    await this.selectNamed('is_related_to_pep', /^(?:否|No)$/i);
    await this.selectNamed('kyc_aml', /^(?:是|Yes)$/i);
    await this.selectNamed('account_purpose', new RegExp(`^${this.escapeRegex(accountPurpose)}$`));
  }

  async fillAuthorizedRepresentative(profile: CorporateNaturalPersonProfile): Promise<void> {
    await this.expectStep('授权代表');
    await this.fillNaturalPerson(profile, { isUbo: true, positionRequired: true });
  }

  async openNaturalDirectorForm(): Promise<void> {
    await this.expectStep('企业董事');
    await this.activateVisibleText('添加自然人董事');
    await this.expectStep('自然人董事');
  }

  async directorCounts(): Promise<{ natural: number; legal: number }> {
    await this.expectStep('企业董事');
    return {
      natural: await this.countFromLabel(/^(?:自然人董事|Natural Director)\s*\((\d+)\)$/i),
      legal: await this.countFromLabel(/^(?:法人董事|Legal Director)\s*\((\d+)\)$/i)
    };
  }

  async fillNaturalDirector(profile: CorporateNaturalPersonProfile): Promise<void> {
    await this.fillNaturalPerson(profile, { isUbo: false, positionRequired: false });
  }

  async openLegalDirectorForm(): Promise<void> {
    const tab = this.page.getByText(/^(?:法人董事|Legal Director)\s*\(\d+\)$/i).filter({ visible: true });
    await expect(tab).toHaveCount(1);
    await tab.click();
    await this.activateVisibleText('添加法人董事');
    await this.expectStep('法人董事');
  }

  async fillLegalDirector(profile: CorporateRegistrationProfile['legalDirector']): Promise<void> {
    await this.fillNamed('entity_name', profile.companyName);
    await this.fillNamed('registration_number', profile.registrationNumber);
    await this.fillDate('请选择注册成立日期', profile.incorporationDate);
    await this.selectAutocomplete('请选择注册国家', profile.registrationCountry);
    await this.fillNamed('street', profile.street);
    await this.fillNamed('city', profile.city);
    await this.fillNamed('state_province', profile.stateProvince);
    await this.fillNamed('postal_code', profile.postalCode);
    await this.fillNamed('mobile', profile.mobile);
    await this.fillNamed('email', profile.email);
    await this.selectNamed('business_nature', new RegExp(`^${this.escapeRegex(profile.businessNature)}$`));
    await this.selectNamed('mailing_address', /(?:不.*注册地址不同|different from.*registered)/i);
    await this.fillNamed('mailing_address_detail', '2 SANDBOX DIRECTOR MAILING ADDRESS');
    await this.selectNamed('mailing_country', /中国香港特别行政区|Hong Kong/i);
    await this.fillNamed('mailing_city', 'HONG KONG');
    await this.fillNamed('mailing_street', '2 TEST DIRECTOR MAILING STREET');
    await this.fillNamed('mailing_state_province', 'HONG KONG');
    await this.fillNamed('mailing_postal_code', '100002');
  }

  async openNaturalShareholderForm(): Promise<void> {
    await this.expectStep('企业股东');
    await this.activateVisibleText('添加企业股东');
    await this.activateVisibleText('个人股东');
    await this.expectStep('个人股东');
  }

  async shareholderCounts(): Promise<{ natural: number; legal: number }> {
    await this.expectStep('企业股东');
    const natural = await this.countVisibleNonHeadingLabels(/^(?:个人股东|Natural Shareholder)$/i);
    const legal = await this.countVisibleNonHeadingLabels(/^(?:企业股东|Legal Shareholder)$/i);
    return { natural, legal };
  }

  async fillNaturalShareholder(profile: CorporateNaturalPersonProfile): Promise<void> {
    await this.selectAutocomplete('请选择国籍', profile.nationality);
    await this.selectNamed('gender', /^(?:男|Male)$/i);
    await this.fillNamed('last_name', profile.lastName);
    await this.fillNamed('first_name', profile.firstName);
    await this.selectNamed('position', /(?:高级管理|Senior Management)/i);
    await this.fillIdentityAndContact(profile);
    await this.fillNaturalPersonAddresses(profile);
  }

  async createRelatedPerson(action: '创建董事档案' | '创建股东档案'): Promise<void> {
    const response = this.page.waitForResponse(candidate => {
      const url = new URL(candidate.url());
      return candidate.request().method() === 'POST' &&
        /\/kyb\/(?:add|update)-related-person$/.test(url.pathname);
    }, { timeout: 30_000 });
    const button = this.page.getByRole('button', { name: action, exact: true });
    await expect(button).toBeEnabled();
    const [result] = await Promise.all([response, button.click()]);
    if (!result.ok()) throw new Error(`${action} failed with HTTP ${result.status()}.`);
    await expect(this.page.getByRole('heading', {
      name: action === '创建董事档案' ? '企业董事' : '企业股东',
      exact: true
    })).toBeVisible({ timeout: 30_000 });
  }

  async continueFromRelatedPersonList(expectedStep: number): Promise<void> {
    await this.clickNextAndWaitForStep(expectedStep);
  }

  async continueFromShareholdersToAuthorization(): Promise<{ httpStatus: number }> {
    if (this.authorizationTransitionClicks > 0) {
      throw new Error('Shareholder-to-authorization Next may be clicked only once per Page Object run.');
    }

    const initializationResponse = this.page.waitForResponse(candidate => {
      const url = new URL(candidate.url());
      return candidate.request().method() === 'POST' &&
        url.pathname.endsWith('/api/kyb/init-doc-sign');
    }, { timeout: 45_000 });
    const next = this.page.getByRole('button', { name: '下一步', exact: true });
    await expect(next).toBeEnabled();
    this.authorizationTransitionClicks += 1;
    const [response] = await Promise.all([initializationResponse, next.click()]);
    if (!response.ok()) {
      throw new Error(`Corporate signing initialization failed with HTTP ${response.status()}.`);
    }
    await this.expectAuthorizationStep();
    return { httpStatus: response.status() };
  }

  async ensureAuthorizationStep(baseUrl: string): Promise<void> {
    if (!/(?:[?&])step=8(?:&|$)/.test(this.page.url())) {
      await this.gotoStep(baseUrl, 8);
    }
    await this.expectAuthorizationStep();
  }

  async saveCurrentStep(endpoint: string, expectedStep: number): Promise<number> {
    const responsePromise = this.page.waitForResponse(candidate => {
      const url = new URL(candidate.url());
      return candidate.request().method() === 'POST' && url.pathname.endsWith(endpoint);
    }, { timeout: 30_000 });
    const next = this.page.getByRole('button', { name: '下一步', exact: true });
    await expect(next).toBeEnabled();
    const [response] = await Promise.all([responsePromise, next.click()]);
    if (!response.ok()) throw new Error(`${endpoint} failed with HTTP ${response.status()}.`);
    await this.expectStepNumber(expectedStep);
    return response.status();
  }

  async clickNextAndWaitForStep(expectedStep: number): Promise<void> {
    const next = this.page.getByRole('button', { name: '下一步', exact: true });
    await expect(next).toBeEnabled();
    await next.click();
    await this.expectStepNumber(expectedStep);
  }

  async expectAuthorizationStep(): Promise<void> {
    await this.expectStep('授权');
    await expect(this.page).toHaveURL(/(?:[?&])step=8(?:&|$)/);
  }

  async expectSubmissionStep(): Promise<void> {
    await expect(this.page).toHaveURL(/(?:[?&])step=9(?:&|$)/, { timeout: 60_000 });
    await this.expectStep('提交申请');
  }

  async submitCorporateApplicationOnce(): Promise<{ httpStatus: number }> {
    const button = this.page.getByRole('button', { name: '提交', exact: true });
    await expect(button).toHaveCount(1);
    await expect(button).toBeEnabled();
    const responsePromise = this.page.waitForResponse(candidate => {
      const url = new URL(candidate.url());
      return candidate.request().method() === 'POST' && url.pathname.endsWith('/kyb/submit-application');
    }, { timeout: 30_000 });
    const [response] = await Promise.all([responsePromise, button.click()]);
    if (!response.ok()) {
      throw new Error(`Corporate final submission failed with HTTP ${response.status()}.`);
    }
    return { httpStatus: response.status() };
  }

  async expectSubmittedState(): Promise<string> {
    await this.page.waitForURL(/\/zh-CN\/sign-success(?:$|[?#])/, { timeout: 60_000 });
    const body = (await this.page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
    if (!/(?:审核|已提交|成功|等待|review|submitted|success)/i.test(body)) {
      throw new Error('Corporate submission route opened without a visible submitted/review state.');
    }
    return body.match(/(?:等待审核|审核中|已提交|提交成功|Under Review|Submitted)/i)?.[0] ?? 'sign-success';
  }

  async visibleText(): Promise<string> {
    return (await this.page.locator('body').innerText()).replace(/\r/g, '');
  }

  stepCard(name: string): Locator {
    return this.page.getByText(name, { exact: true }).filter({ visible: true });
  }

  async openAvailableStep(name: string): Promise<void> {
    const cardLabel = this.stepCard(name);
    await expect(cardLabel).toBeVisible();
    const overviewUrl = this.page.url();
    await cardLabel.click();
    await expect
      .poll(() => this.page.url(), {
        message: `Corporate registration step ${name} did not open.`,
        timeout: 10_000
      })
      .not.toBe(overviewUrl);
  }

  async activateVisibleText(name: string): Promise<void> {
    const candidates = await this.page.getByText(name, { exact: true }).filter({ visible: true }).all();
    let target: Locator | undefined;
    for (const candidate of candidates) {
      const actionable = await candidate.evaluate(element => {
        let current: Element | null = element;
        for (let level = 0; level < 5 && current; level += 1) {
          const role = current.getAttribute('role');
          if (
            current.tagName === 'BUTTON' ||
            current.tagName === 'A' ||
            role === 'button' ||
            role === 'tab' ||
            window.getComputedStyle(current).cursor === 'pointer'
          ) return true;
          current = current.parentElement;
        }
        return false;
      });
      if (actionable) {
        target = candidate;
        break;
      }
    }
    if (!target) throw new Error(`Corporate registration action ${name} has no actionable target.`);
    const previousText = await this.visibleText();
    await target.click();
    await expect
      .poll(() => this.visibleText(), {
        message: `Corporate registration action ${name} did not change the page.`,
        timeout: 10_000
      })
      .not.toBe(previousText);
  }

  async revealDifferentMailingAddress(): Promise<void> {
    const mailingAddressInput = this.page.locator('input[name="mailing_address"]');
    await expect(mailingAddressInput).toBeAttached();
    const comboboxes = await this.page.getByRole('combobox').all();
    let mailingCombobox: Locator | undefined;
    for (const combobox of comboboxes) {
      if (!(await combobox.isVisible())) continue;
      const belongsToMailingAddress = await combobox.evaluate(element => {
        let current: Element | null = element;
        for (let level = 0; level < 5 && current; level += 1) {
          const text = (current.textContent ?? '').replace(/\s+/g, '');
          if (text.includes('邮寄地址') && (text.includes('请选择') || text.includes('与注册地址'))) {
            return true;
          }
          current = current.parentElement;
        }
        return false;
      });
      if (belongsToMailingAddress) {
        mailingCombobox = combobox;
        break;
      }
    }
    if (!mailingCombobox) throw new Error('Corporate mailing-address combobox was not found by its field label.');
    await mailingCombobox.click();
    await this.page.getByRole('option', { name: /(?:不，与我的居住地址不同|邮寄地址与注册地址不同)/ }).click();
    await expect(this.page.getByText('邮寄地址证明', { exact: true })).toBeVisible();
  }

  async inspectControls(): Promise<CorporateControlSnapshot[]> {
    return this.page.locator('input, textarea, select, button, [role="combobox"], [role="checkbox"], [role="radio"]')
      .evaluateAll(elements => elements
        .filter(element => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        })
        .map(element => {
          const html = element as HTMLInputElement;
          const id = html.id;
          const explicitLabel = id
            ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent
            : undefined;
          const wrappingLabel = element.closest('label')?.textContent;
          const ariaLabel = element.getAttribute('aria-label');
          return {
            tag: element.tagName.toLowerCase(),
            type: html.type ?? '',
            role: element.getAttribute('role') ?? '',
            label: (ariaLabel ?? explicitLabel ?? wrappingLabel ?? '').trim(),
            placeholder: html.placeholder ?? '',
            name: html.name ?? '',
            required: html.required || element.getAttribute('aria-required') === 'true',
            disabled: html.disabled || element.getAttribute('aria-disabled') === 'true',
            accept: html.accept ?? '',
            multiple: html.multiple ?? false,
            text: (element.textContent ?? '').trim().replace(/\s+/g, ' ')
          };
        }));
  }

  async inspectUploads(): Promise<CorporateUploadSnapshot[]> {
    return this.page.locator('input[type="file"]').evaluateAll(elements => elements.map(element => {
      const input = element as HTMLInputElement;
      const container = element.closest('[class*="upload"], [class*="Upload"], [class*="form"], label, div');
      const id = input.id;
      const explicitLabel = id
        ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent
        : undefined;
      const ancestorTrail: CorporateUploadSnapshot['ancestorTrail'] = [];
      let ancestor: Element | null = element;
      for (let level = 0; level < 7 && ancestor; level += 1) {
        ancestorTrail.push({
          level,
          tag: ancestor.tagName.toLowerCase(),
          className: ancestor.getAttribute('class') ?? '',
          text: (ancestor.textContent ?? '').trim().replace(/\s+/g, ' ')
        });
        ancestor = ancestor.parentElement;
      }
      return {
        tag: 'input',
        type: 'file',
        role: element.getAttribute('role') ?? '',
        label: (element.getAttribute('aria-label') ?? explicitLabel ?? '').trim(),
        placeholder: input.placeholder ?? '',
        name: input.name ?? '',
        required: input.required || element.getAttribute('aria-required') === 'true',
        disabled: input.disabled || element.getAttribute('aria-disabled') === 'true',
        accept: input.accept ?? '',
        multiple: input.multiple,
        text: '',
        nearbyText: (container?.textContent ?? '').trim().replace(/\s+/g, ' '),
        ancestorTrail
      };
    }));
  }

  async uploadFieldLabels(): Promise<string[]> {
    const uploads = await this.inspectUploads();
    return uploads.map(upload => {
      const fieldContainer = upload.ancestorTrail.find(ancestor => ancestor.level === 3);
      return (fieldContainer?.text ?? upload.nearbyText)
        .replace('点击上传或拖拽文件到此处', '')
        .trim();
    });
  }

  async expectUploadFields(expectedLabels: readonly string[]): Promise<void> {
    await expect.poll(() => this.uploadFieldLabels()).toEqual(expectedLabels);
    const uploads = await this.inspectUploads();
    for (const upload of uploads) {
      expect(upload.accept).toBe('application/pdf,.pdf,image/*,.jpg,.jpeg,.png');
    }
  }

  async uploadDocument(document: {
    pageLabel: string;
    asset: string;
  }): Promise<CorporateUploadResult> {
    const input = await this.uploadInputFor(document.pageLabel);
    const assetPath = path.resolve(document.asset);
    const fileName = path.basename(assetPath);
    const alreadyUploaded = await this.uploadContainerContains(input, fileName);
    if (alreadyUploaded) {
      return { fileName, selected: false, alreadyUploaded: true };
    }
    const responsePromise = this.page.waitForResponse(candidate => {
      const url = new URL(candidate.url());
      return candidate.request().method() === 'POST' && url.pathname.endsWith('/upload');
    }, { timeout: 30_000 });
    const [, response] = await Promise.all([
      input.setInputFiles(assetPath),
      responsePromise
    ]);
    if (!response.ok()) {
      throw new Error(`${document.pageLabel} upload failed with HTTP ${response.status()}.`);
    }
    await expect
      .poll(
        () => input.evaluate((element, expectedFileName) => {
          const selectedName = (element as HTMLInputElement).files?.[0]?.name ?? '';
          let current: Element | null = element;
          let nearbyText = '';
          for (let level = 0; level < 5 && current; level += 1) {
            nearbyText += ` ${(current.textContent ?? '').trim()}`;
            current = current.parentElement;
          }
          return selectedName === expectedFileName || nearbyText.includes(expectedFileName);
        }, fileName),
        { message: `${document.pageLabel} did not accept ${fileName}.`, timeout: 10_000 }
      )
      .toBe(true);
    return {
      fileName,
      selected: true,
      alreadyUploaded: false,
      httpStatus: response.status()
    };
  }

  async inspectComboboxOptions(): Promise<CorporateComboboxSnapshot[]> {
    const comboboxes = await this.page.getByRole('combobox').all();
    const snapshots: CorporateComboboxSnapshot[] = [];

    for (const combobox of comboboxes) {
      if (!(await combobox.isVisible()) || !(await combobox.isEnabled())) continue;
      const metadata = await combobox.evaluate(element => {
        const input = element as HTMLInputElement;
        let ancestor: Element | null = element;
        let nearbyText = '';
        for (let level = 0; level < 5 && ancestor; level += 1) {
          const text = (ancestor.textContent ?? '').trim().replace(/\s+/g, ' ');
          if (text && text !== input.value && text !== input.placeholder) nearbyText = text;
          ancestor = ancestor.parentElement;
        }
        return {
          name: input.name ?? '',
          placeholder: input.placeholder ?? '',
          nearbyText
        };
      });
      await combobox.click();
      const options = (await this.page.getByRole('option').allTextContents())
        .map(option => option.trim().replace(/\s+/g, ' '))
        .filter(Boolean);
      snapshots.push({ ...metadata, options });
      await this.page.keyboard.press('Escape');
    }

    return snapshots;
  }

  async expectNoFinalSubmission(): Promise<void> {
    if (await this.finalSubmitButton.count()) {
      await expect(this.finalSubmitButton).not.toBeFocused();
    }
  }

  private async uploadInputFor(pageLabel: string): Promise<Locator> {
    const inputs = await this.page.locator('input[type="file"]').all();
    for (const input of inputs) {
      const matches = await input.evaluate((element, expectedLabel) => {
        let current: Element | null = element;
        for (let level = 0; level < 6 && current; level += 1) {
          const text = (current.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (text.startsWith(expectedLabel) && text.includes('上传')) return true;
          current = current.parentElement;
        }
        return false;
      }, pageLabel);
      if (matches) return input;
    }
    throw new Error(`Corporate upload field was not found by its real label: ${pageLabel}.`);
  }

  private async fillNaturalPerson(
    profile: CorporateNaturalPersonProfile,
    options: { isUbo: boolean; positionRequired: boolean }
  ): Promise<void> {
    await this.selectAutocomplete('请选择国籍', profile.nationality);
    await this.selectNamed('gender', /^(?:男|Male)$/i);
    await this.fillNamed('last_name', profile.lastName);
    await this.fillNamed('first_name', profile.firstName);
    await this.selectNamed(
      'is_ultimate_beneficiary',
      options.isUbo
        ? /^(?:此人为主体的最终受益人|This person is the ultimate beneficial owner)$/i
        : /^(?:此人不为主体的最终受益人|This person is not the ultimate beneficial owner)$/i
    );
    if (options.positionRequired) {
      await this.selectNamed('position', /(?:高级管理|Senior Management)/i);
    }
    await this.fillIdentityAndContact(profile);
    await this.fillNaturalPersonAddresses(profile);
  }

  private async fillIdentityAndContact(profile: CorporateNaturalPersonProfile): Promise<void> {
    await this.selectNamed('id_type', /^(?:护照|Passport)$/i);
    await this.fillNamed('id_number', profile.idNumber);
    await this.fillDate('请选择证件签发日期', profile.idIssueDate);
    await this.fillDate('请选择证件有效期', profile.idExpiryDate);
    await this.fillDate('请选择出生日期', profile.dateOfBirth);
    await this.fillNamed('mobile', profile.mobile);
    await this.fillNamed('email', profile.email);
  }

  private async fillNaturalPersonAddresses(profile: CorporateNaturalPersonProfile): Promise<void> {
    await this.fillNamed('residential_address', profile.residentialAddress);
    await this.selectNamed('country', /中国香港特别行政区|Hong Kong/i);
    await this.fillNamed('city', profile.city);
    await this.fillNamed('street', profile.street);
    await this.fillNamed('state_province', profile.stateProvince);
    await this.fillNamed('postal_code', profile.postalCode);
    await this.selectNamed('mailing_address', /(?:不.*居住地址不同|different from.*residential)/i);
    await this.fillNamed('mailing_address_detail', profile.mailingAddress);
    await this.selectNamed('mailing_country', /中国香港特别行政区|Hong Kong/i);
    await this.fillNamed('mailing_city', profile.mailingCity);
    await this.fillNamed('mailing_street', profile.mailingStreet);
    await this.fillNamed('mailing_state_province', profile.mailingStateProvince);
    await this.fillNamed('mailing_postal_code', profile.mailingPostalCode);
  }

  private async fillNamed(name: string, value: string): Promise<void> {
    const input = this.page.locator(`input[name=${JSON.stringify(name)}], textarea[name=${JSON.stringify(name)}]`);
    await expect(input).toHaveCount(1);
    await input.fill(value);
    await input.press('Tab');
    await expect(input).toHaveValue(value);
  }

  private async fillDate(placeholder: string, value: string): Promise<void> {
    const input = this.page.getByPlaceholder(placeholder, { exact: true });
    await expect(input).toHaveCount(1);
    await input.fill(value);
    await input.press('Tab');
    await expect(input).toHaveValue(value);
  }

  private async selectAutocomplete(placeholder: string, optionText: string): Promise<void> {
    const input = this.page.getByPlaceholder(placeholder, { exact: true });
    await expect(input).toHaveCount(1);
    await input.fill(optionText);
    const option = this.page.getByRole('option', {
      name: new RegExp(this.escapeRegex(optionText), 'i')
    });
    await expect(option.first()).toBeVisible();
    await option.first().click();
  }

  private async selectNamed(name: string, optionName: RegExp): Promise<void> {
    const combobox = await this.comboboxForNamedInput(name);
    await expect(combobox).toBeEnabled();
    await combobox.click();
    const option = this.page.getByRole('option', { name: optionName });
    await expect(option.first()).toBeVisible();
    await option.first().click();
    if (await this.page.getByRole('option').count()) await this.page.keyboard.press('Escape');
  }

  private async comboboxForNamedInput(name: string): Promise<Locator> {
    const controls = await this.page.getByRole('combobox').all();
    for (const control of controls) {
      if (!await control.isVisible()) continue;
      const matches = await control.evaluate((element, expectedName) => {
        let current: Element | null = element;
        for (let level = 0; level < 4 && current; level += 1) {
          const named = Array.from(current.querySelectorAll('input[name]')).some(
            input => input.getAttribute('name') === expectedName
          );
          if (named) return true;
          current = current.parentElement;
        }
        return false;
      }, name);
      if (matches) return control;
    }
    throw new Error(`Corporate combobox for ${name} was not found from its real named input.`);
  }

  private async expectStepNumber(step: number): Promise<void> {
    await expect(this.page).toHaveURL(new RegExp(`(?:[?&])step=${step}(?:&|$)`), {
      timeout: 30_000
    });
  }

  private async uploadContainerContains(input: Locator, fileName: string): Promise<boolean> {
    return input.evaluate((element, expectedFileName) => {
      let current: Element | null = element;
      for (let level = 0; level < 6 && current; level += 1) {
        if ((current.textContent ?? '').includes(expectedFileName)) return true;
        current = current.parentElement;
      }
      return false;
    }, fileName);
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async countFromLabel(pattern: RegExp): Promise<number> {
    const labels = this.page.getByText(pattern).filter({ visible: true });
    for (const label of await labels.all()) {
      const text = (await label.innerText()).replace(/\s+/g, ' ').trim();
      const match = text.match(pattern);
      if (match) return Number(match[1]);
    }
    return 0;
  }

  private async countVisibleNonHeadingLabels(pattern: RegExp): Promise<number> {
    const labels = await this.page.getByText(pattern).all();
    let count = 0;
    for (const label of labels) {
      if (!await label.isVisible()) continue;
      const isHeading = await label.evaluate(element => /^H[1-6]$/.test(element.tagName));
      if (!isHeading) count += 1;
    }
    return count;
  }
}
