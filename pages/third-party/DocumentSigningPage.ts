import { expect, type Frame, type Locator, type Page } from '@playwright/test';

import { assertClientTestEnvironment } from '../../src/utils/clientSafety';

export type SandboxSignerIdentity = {
  signatureText: string;
  initials: string;
};

export type DocumentSigningDryRunResult = {
  openingMode: 'iframe';
  provider: 'Documenso';
  providerHost: string;
  signatureMethod: 'Canvas Draw';
  uploadSignatureAvailable: boolean;
  typedSignatureAvailable: boolean;
  initialsRequired: boolean;
  dateHandling: 'Document prefilled';
  checkboxHandling: 'Document prefilled';
  identityChallengePresent: boolean;
  requiredFieldsBefore: number;
  requiredFieldsAfter: number;
  finalActionName: string;
  finalActionLocator: string;
  fieldSignClicks: number;
  finalActionClicks: number;
};

export type DocumentCompletionResult = {
  actionName: 'Sign';
  completionEvidence: 'frame-detached' | 'confirmation-hidden' | 'completion-state';
  requestPath?: string;
  httpStatus?: number;
};

export type DocumentCompletionPromptResult = {
  actionName: 'Complete';
  confirmationTitle: string;
  documensoDocumentTitle: string;
};

export type PreparedDocumentSigningInspection = {
  openingMode: 'iframe';
  provider: 'Documenso';
  fidereModuleName: 'FATCA 第三方签署';
  signerFullName: string;
  signatureValue: 'TEST';
  fieldsRemaining: 0;
  signatureFieldsCompleted: true;
  identityChallengePresent: false;
  finalActionName: 'Complete';
};

export type InitialDocumentSigningInspection = {
  openingMode: 'iframe';
  provider: 'Documenso';
  providerHost: string;
  safeFrameUrl: string;
  fieldsRemainingBefore: number;
  signerFullNamePresent: boolean;
  signerFullNameMatchesJourney: boolean;
  signatureAlreadyCompleted: boolean;
  identityChallengePresent: boolean;
};

type SignaturePoint = readonly [number, number];

const SANDBOX_SIGNER_POLICY = {
  signatureText: 'TEST',
  initials: 'T'
} as const;

const TEST_SIGNATURE_STROKES: readonly (readonly SignaturePoint[])[] = [
  [[0.06, 0.25], [0.20, 0.25]],
  [[0.13, 0.25], [0.13, 0.78]],
  [[0.28, 0.25], [0.28, 0.78]],
  [[0.28, 0.25], [0.42, 0.25]],
  [[0.28, 0.51], [0.39, 0.51]],
  [[0.28, 0.78], [0.42, 0.78]],
  [[0.61, 0.30], [0.56, 0.24], [0.48, 0.26], [0.46, 0.39], [0.50, 0.49], [0.58, 0.54], [0.61, 0.66], [0.58, 0.77], [0.49, 0.79], [0.44, 0.73]],
  [[0.69, 0.25], [0.86, 0.25]],
  [[0.775, 0.25], [0.775, 0.78]]
];

export class DocumentSigningPage {
  private signerFrame?: Frame;
  private fieldSignClicks = 0;
  private completeClicks = 0;
  private signingConfirmationClicks = 0;

  constructor(readonly page: Page) {}

  async open(trigger: () => Promise<void>): Promise<void> {
    assertClientTestEnvironment(this.page.url());
    await trigger();
    await this.attachExisting('FATCA 第三方签署');
  }

  async attachExisting(
    moduleHeading: string | RegExp,
    expectedProviderHost = 'app.documenso.com'
  ): Promise<void> {
    assertClientTestEnvironment(this.page.url());
    await expect(
      this.page.getByRole('heading', { name: moduleHeading, exact: false }).first()
    ).toBeVisible({ timeout: 30_000 });

    let candidates: Frame[] = [];
    await expect.poll(async () => {
      candidates = [];
      for (const frame of this.page.frames()) {
        if ((await frame.getByText('Sign Document', { exact: true }).count()) === 1) {
          candidates.push(frame);
        }
      }
      return candidates.length;
    }, {
      timeout: 30_000,
      message: 'Documenso未加载出唯一Sign Document iframe。'
    }).toBe(1);

    const [signerFrame] = candidates;
    const providerUrl = new URL(signerFrame.url());
    if (providerUrl.hostname !== expectedProviderHost) {
      throw new Error(`Unexpected document signing provider host: ${providerUrl.hostname}.`);
    }
    this.signerFrame = signerFrame;
  }

  async prepareSandboxSignature(
    identity: SandboxSignerIdentity
  ): Promise<DocumentSigningDryRunResult> {
    this.assertSandboxSignaturePolicy(identity);
    const frame = this.requireSignerFrame();
    const fullNameLabel = frame.getByText('Full Name', { exact: true });
    await expect(fullNameLabel).toHaveCount(1);
    const fullName = fullNameLabel.locator('..').getByRole('textbox');
    await expect(fullName).toHaveCount(1);
    await expect(fullName).not.toHaveValue('');

    const signatureLabel = frame.getByText('Signature', { exact: true });
    await expect(signatureLabel).toHaveCount(1);
    const signatureGroup = signatureLabel.locator('..');
    const typedSignatureAvailable = (await signatureGroup.locator('input[type="text"]').count()) > 0;
    const initialsRequired = (await frame.getByText(/Initials?/i).count()) > 0;

    await expect.poll(() => frame.locator('canvas').count(), {
      timeout: 30_000,
      message: 'Documenso PDF Canvas未完成加载。'
    }).toBeGreaterThan(0);

    const remainingBefore = await this.readRemainingFieldCount();
    if (remainingBefore === 0) {
      const finalActionName = await this.waitForFinalAction(frame);
      return {
        openingMode: 'iframe',
        provider: 'Documenso',
        providerHost: new URL(frame.url()).hostname,
        signatureMethod: 'Canvas Draw',
        uploadSignatureAvailable: false,
        typedSignatureAvailable,
        initialsRequired,
        dateHandling: 'Document prefilled',
        checkboxHandling: 'Document prefilled',
        identityChallengePresent: await this.hasVisibleIdentityChallenge(frame),
        requiredFieldsBefore: 0,
        requiredFieldsAfter: 0,
        finalActionName,
        finalActionLocator: `getByRole('button', { name: '${finalActionName}', exact: true })`,
        fieldSignClicks: this.fieldSignClicks,
        finalActionClicks: this.completeClicks
      };
    }

    const nextField = frame.getByRole('button', { name: 'Next Field', exact: true });
    await expect(nextField).toHaveCount(1);
    await nextField.click();
    const spinner = frame.locator('svg.animate-spin');
    if (await spinner.isVisible()) {
      await expect(spinner).toBeHidden({ timeout: 30_000 });
    }
    const insertPrompt = frame.getByText('Click to insert field', { exact: true });
    await expect(insertPrompt).toHaveCount(1);
    await expect(insertPrompt).toBeVisible({ timeout: 20_000 });
    await this.activateCanvasField(frame, insertPrompt);

    const fieldDialog = frame.getByRole('dialog').filter({ hasText: 'Sign Signature Field' });
    await expect(fieldDialog).toHaveCount(1);
    await expect(fieldDialog).toBeVisible();
    await expect(fieldDialog.getByText('Draw', { exact: true })).toBeVisible();
    const uploadSignatureAvailable = await fieldDialog.getByText('Upload', { exact: true }).isVisible();
    const drawCanvas = fieldDialog.locator('canvas');
    await expect(drawCanvas).toHaveCount(1);
    await this.drawFixedTestSignature(drawCanvas, identity.signatureText);

    const applySignature = fieldDialog.getByRole('button', { name: 'Sign', exact: true });
    await expect(applySignature).toBeEnabled();
    if (this.fieldSignClicks > 0) {
      throw new Error('Documenso field-level Sign may be clicked only once per Dry Run.');
    }
    this.fieldSignClicks += 1;
    await applySignature.click();
    await expect(fieldDialog).toBeHidden();

    const finalActionName = await this.waitForFinalAction(frame);
    const remainingAfter = await this.readRemainingFieldCount();
    const identityChallengePresent = await this.hasVisibleIdentityChallenge(frame);

    return {
      openingMode: 'iframe',
      provider: 'Documenso',
      providerHost: new URL(frame.url()).hostname,
      signatureMethod: 'Canvas Draw',
      uploadSignatureAvailable,
      typedSignatureAvailable,
      initialsRequired,
      dateHandling: 'Document prefilled',
      checkboxHandling: 'Document prefilled',
      identityChallengePresent,
      requiredFieldsBefore: remainingBefore,
      requiredFieldsAfter: remainingAfter,
      finalActionName,
      finalActionLocator: `getByRole('button', { name: '${finalActionName}', exact: true })`,
      fieldSignClicks: this.fieldSignClicks,
      finalActionClicks: this.completeClicks
    };
  }

  completeClickCount(): number {
    return this.completeClicks;
  }

  signingConfirmationClickCount(): number {
    return this.signingConfirmationClicks;
  }

  fieldSignClickCount(): number {
    return this.fieldSignClicks;
  }

  async inspectInitialDocument(
    expectedSignerFullName: string
  ): Promise<InitialDocumentSigningInspection> {
    const frame = this.requireSignerFrame();
    const fullNameLabel = frame.getByText('Full Name', { exact: true });
    await expect(fullNameLabel).toHaveCount(1);
    const fullName = fullNameLabel.locator('..').getByRole('textbox');
    await expect(fullName).toHaveCount(1);
    const currentFullName = (await fullName.inputValue()).replace(/\s+/g, ' ').trim();
    const expected = expectedSignerFullName.replace(/\s+/g, ' ').trim();
    const fieldsRemainingBefore = await this.readRemainingFieldCount();
    const frameUrl = new URL(frame.url());

    return {
      openingMode: 'iframe',
      provider: 'Documenso',
      providerHost: frameUrl.hostname,
      safeFrameUrl: `${frameUrl.origin}${this.safeProviderPath(frameUrl.pathname)}`,
      fieldsRemainingBefore,
      signerFullNamePresent: currentFullName.length > 0,
      signerFullNameMatchesJourney:
        currentFullName.localeCompare(expected, undefined, { sensitivity: 'base' }) === 0,
      signatureAlreadyCompleted: fieldsRemainingBefore === 0,
      identityChallengePresent: await this.hasVisibleIdentityChallenge(frame)
    };
  }

  async inspectPreparedSandboxSignature(
    identity: SandboxSignerIdentity
  ): Promise<PreparedDocumentSigningInspection> {
    this.assertSandboxSignaturePolicy(identity);
    const frame = this.requireSignerFrame();
    const fullNameLabel = frame.getByText('Full Name', { exact: true });
    await expect(fullNameLabel).toHaveCount(1);
    const fullName = fullNameLabel.locator('..').getByRole('textbox');
    await expect(fullName).toHaveCount(1);
    await expect(fullName).not.toHaveValue('');

    await expect(frame.getByText('Signature', { exact: true })).toHaveCount(1);
    const fieldsRemaining = await this.readRemainingFieldCount();
    if (fieldsRemaining !== 0) {
      throw new Error(`Documenso Resume requires 0 Fields Remaining; received ${fieldsRemaining}.`);
    }
    await expect(frame.getByRole('button', { name: 'Next Field', exact: true })).toHaveCount(0);
    const identityChallengePresent = await this.hasVisibleIdentityChallenge(frame);
    if (identityChallengePresent) {
      throw new Error('Documenso Resume encountered an unexpected OTP or Captcha challenge.');
    }
    const finalActionName = await this.waitForFinalAction(frame);
    if (finalActionName !== 'Complete') {
      throw new Error(`Documenso Resume expected Complete; received ${finalActionName}.`);
    }
    if (this.fieldSignClicks !== 0) {
      throw new Error('Documenso Resume must not draw or apply a second signature.');
    }

    return {
      openingMode: 'iframe',
      provider: 'Documenso',
      fidereModuleName: 'FATCA 第三方签署',
      signerFullName: await fullName.inputValue(),
      signatureValue: 'TEST',
      fieldsRemaining: 0,
      signatureFieldsCompleted: true,
      identityChallengePresent: false,
      finalActionName: 'Complete'
    };
  }

  async completeDocument(): Promise<DocumentCompletionPromptResult> {
    assertClientTestEnvironment(this.page.url());
    const frame = this.requireSignerFrame();
    const actionName = await this.waitForFinalAction(frame);
    if (actionName !== 'Complete') {
      throw new Error(`Unexpected Documenso final action: ${actionName}.`);
    }
    if (this.completeClicks > 0) {
      throw new Error('Documenso Complete may be clicked only once per run.');
    }

    const finalAction = frame.getByRole('button', { name: actionName, exact: true });
    this.completeClicks += 1;
    await finalAction.click();

    const confirmation = this.signingConfirmationDialog(frame);
    await expect(confirmation).toHaveCount(1);
    await expect(confirmation).toBeVisible({ timeout: 20_000 });
    const confirmationHeading = confirmation.getByText(
      /^(?:Are you sure\?|你确定吗[？?]?)$/i
    );
    await expect(confirmationHeading).toHaveCount(1);
    await expect(confirmationHeading).toBeVisible();
    await expect(confirmation.getByRole('button', { name: /^(?:Cancel|取消)$/i })).toBeVisible();
    await expect(confirmation.getByRole('button', { name: /^(?:Sign|签署)$/i })).toBeVisible();

    const documentPrompt = 'You are about to complete signing the following document';
    await expect(confirmation.getByText(documentPrompt, { exact: true })).toBeVisible();
    const confirmationLines = (await confirmation.innerText())
      .split(/\r?\n/)
      .map(value => value.trim())
      .filter(Boolean);
    const promptIndex = confirmationLines.indexOf(documentPrompt);
    const documensoDocumentTitle = promptIndex >= 0
      ? confirmationLines[promptIndex + 1]
      : undefined;
    if (!documensoDocumentTitle) {
      throw new Error('Documenso signing confirmation did not expose the current document name.');
    }

    return {
      actionName: 'Complete',
      confirmationTitle: (await confirmationHeading.innerText()).trim(),
      documensoDocumentTitle
    };
  }

  async confirmSigning(): Promise<DocumentCompletionResult> {
    assertClientTestEnvironment(this.page.url());
    const frame = this.requireSignerFrame();
    if (this.completeClicks !== 1) {
      throw new Error('Documenso Sign confirmation requires exactly one preceding Complete click.');
    }
    if (this.signingConfirmationClicks > 0) {
      throw new Error('Documenso confirmation Sign may be clicked only once per run.');
    }

    const confirmation = this.signingConfirmationDialog(frame);
    await expect(confirmation).toHaveCount(1);
    await expect(confirmation).toBeVisible();
    const signAction = confirmation.getByRole('button', { name: /^(?:Sign|签署)$/i });
    await expect(signAction).toHaveCount(1);
    await expect(signAction).toBeEnabled();

    const safeResponses: Array<{ requestPath: string; httpStatus: number }> = [];
    const captureResponse = (response: import('@playwright/test').Response) => {
      const url = new URL(response.url());
      if (
        url.hostname === 'app.documenso.com' &&
        response.request().method().toUpperCase() !== 'GET'
      ) {
        safeResponses.push({ requestPath: url.pathname, httpStatus: response.status() });
      }
    };
    this.page.on('response', captureResponse);

    this.signingConfirmationClicks += 1;
    try {
      await signAction.click();
      let completionEvidence: DocumentCompletionResult['completionEvidence'] = 'confirmation-hidden';
      await expect.poll(async () => {
        if (frame.isDetached()) {
          completionEvidence = 'frame-detached';
          return true;
        }
        if (!(await confirmation.isVisible())) {
          completionEvidence = 'confirmation-hidden';
          return true;
        }
        const completed = frame.getByText(/Document (?:signed|completed)|Signing complete|Completed/i);
        if ((await completed.count()) > 0 && await completed.first().isVisible()) {
          completionEvidence = 'completion-state';
          return true;
        }
        return false;
      }, {
        timeout: 30_000,
        message: 'Documenso confirmation Sign was clicked once but no completion state became observable.'
      }).toBe(true);

      const response = safeResponses.at(-1);
      return {
        actionName: 'Sign',
        completionEvidence,
        requestPath: response?.requestPath,
        httpStatus: response?.httpStatus
      };
    } finally {
      this.page.off('response', captureResponse);
    }
  }

  private assertSandboxSignaturePolicy(identity: SandboxSignerIdentity): void {
    if (
      identity.signatureText !== SANDBOX_SIGNER_POLICY.signatureText ||
      identity.initials !== SANDBOX_SIGNER_POLICY.initials
    ) {
      throw new Error('Documenso requires the configured Sandbox signature TEST and initials T.');
    }
  }

  private requireSignerFrame(): Frame {
    if (!this.signerFrame) throw new Error('Documenso signer iframe has not been opened.');
    return this.signerFrame;
  }

  private async readRemainingFieldCount(): Promise<number> {
    const frame = this.requireSignerFrame();
    const text = await frame.getByText(/\d+ Fields? Remaining/i).allTextContents();
    const counts = text
      .map(value => Number(value.match(/\d+/)?.[0]))
      .filter(value => Number.isFinite(value));
    if (counts.length === 0) {
      throw new Error('Documenso did not expose a Fields Remaining counter.');
    }
    return Math.min(...counts);
  }

  private async activateCanvasField(frame: Frame, tooltip: Locator): Promise<void> {
    const tooltipId = await tooltip.getAttribute('id');
    if (!tooltipId) throw new Error('Documenso signature tooltip is missing its ARIA id.');
    const semanticField = frame.locator(`[aria-describedby="${tooltipId}"]`);
    await expect(semanticField).toHaveCount(1);
    await expect(semanticField).toBeVisible();

    const documentCanvas = frame.locator('canvas');
    await expect(documentCanvas).toHaveCount(1);
    await documentCanvas.evaluate((canvas, input) => {
      const field = document.querySelector(input.selector);
      if (!field) throw new Error('Semantic Documenso field was not found.');

      const rect = field.getBoundingClientRect();
      const clientX = rect.x + rect.width / 2;
      const clientY = rect.y + rect.height / 2;
      const common = { bubbles: true, cancelable: true, clientX, clientY };

      canvas.dispatchEvent(new PointerEvent('pointerdown', {
        ...common,
        pointerId: 1,
        isPrimary: true
      }));
      canvas.dispatchEvent(new MouseEvent('mousedown', common));
      canvas.dispatchEvent(new PointerEvent('pointerup', {
        ...common,
        pointerId: 1,
        isPrimary: true
      }));
      canvas.dispatchEvent(new MouseEvent('mouseup', common));
      canvas.dispatchEvent(new MouseEvent('click', common));
    }, { selector: `[aria-describedby="${tooltipId}"]` });
  }

  private async drawFixedTestSignature(canvas: Locator, signatureText: string): Promise<void> {
    if (signatureText !== SANDBOX_SIGNER_POLICY.signatureText) {
      throw new Error('Only the fixed Sandbox signature text TEST is allowed.');
    }
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Documenso Draw Canvas has no bounding box.');

    for (const stroke of TEST_SIGNATURE_STROKES) {
      const [start, ...points] = stroke;
      await this.page.mouse.move(box.x + start[0] * box.width, box.y + start[1] * box.height);
      await this.page.mouse.down();
      for (const [x, y] of points) {
        await this.page.mouse.move(box.x + x * box.width, box.y + y * box.height, { steps: 3 });
      }
      await this.page.mouse.up();
    }
  }

  private async waitForFinalAction(frame: Frame): Promise<string> {
    let names: string[] = [];
    await expect.poll(async () => {
      names = (await frame.getByRole('button').allTextContents())
        .map(value => value.replace(/\s+/g, ' ').trim())
        .filter(value => /^(?:Finish|Complete|Sign Document|Submit)$/i.test(value));
      return names.length;
    }, {
      timeout: 20_000,
      message: 'Documenso field completion did not reveal one final action.'
    }).toBe(1);
    const [name] = names;
    const finalAction = frame.getByRole('button', { name, exact: true });
    await expect(finalAction).toHaveCount(1);
    await expect(finalAction).toBeVisible();
    await expect(finalAction).toBeEnabled();
    return name;
  }

  private signingConfirmationDialog(frame: Frame): Locator {
    return frame
      .getByRole('dialog')
      .filter({ hasText: /(?:Are you sure\?|你确定吗[？?]?)/i });
  }

  private async hasVisibleIdentityChallenge(frame: Frame): Promise<boolean> {
    const challenges = frame.getByText(
      /OTP|one[- ]time|verification code|captcha|验证码|图形验证|短信验证|邮箱验证/i
    );
    for (let index = 0; index < await challenges.count(); index += 1) {
      if (await challenges.nth(index).isVisible()) return true;
    }
    return false;
  }

  private safeProviderPath(pathname: string): string {
    return pathname
      .split('/')
      .map(segment =>
        /^[A-F0-9-]{16,}$/i.test(segment) || /^[A-Za-z0-9_-]{24,}$/.test(segment)
          ? ':id'
          : segment
      )
      .join('/');
  }
}
