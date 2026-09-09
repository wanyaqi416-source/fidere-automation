import { expect, type Frame, type Locator, type Page } from '@playwright/test';

import { assertClientTestEnvironment } from '../../../src/utils/clientSafety';

type SignaturePoint = readonly [number, number];

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

export type RegistrationAgreementInspection = {
  implementation: 'RegistrationAgreementSigner';
  openingMode: 'iframe';
  providerHost: string;
  safeFrameUrl: string;
  documentTitle: string;
  documentBelongsToTestUser: boolean;
  initialRemainingFields: number;
  signatureFieldLocated: boolean;
  namePreserved: boolean;
  titleStatus: string;
  dateStatus: string;
  identityChallengePresent: boolean;
};

export type CompletedRegistrationAgreementInspection = {
  completed: true;
  remainingFields: 0;
};

export type RegistrationAgreementSigningResult = {
  signatureMethod: 'Canvas Draw' | 'Typed Signature';
  signatureFieldLocated: true;
  testSignatureDrawn: boolean;
  signatureDrawnThisRun: boolean;
  testSignatureApplied: true;
  documentAlreadyCompleted: boolean;
  fieldSignClickCount: number;
  agreementActionClickCount: number;
  agreementConfirmationClickCount: number;
  finalRemainingFields: 0;
  namePreserved: true;
  titleStatus: string;
  dateStatus: string;
};

type ProtectedFieldState = {
  nameValue?: string;
  titleValue?: string;
  dateValue?: string;
  titleStatus: string;
  dateStatus: string;
};

/**
 * Personal Registration's embedded agreement signer.
 *
 * This class deliberately owns its own registration-specific DOM contract. It
 * does not import or delegate to the account-opening signer.
 */
export class RegistrationAgreementSigner {
  readonly implementation = 'RegistrationAgreementSigner' as const;
  private signerFrame?: Frame;
  private providerOrigin?: string;
  private signatureField?: Locator;
  private signatureEditor?: Locator;
  private initialProtectedFields?: ProtectedFieldState;
  private signatureFieldLocated = false;
  private signatureFieldOpenClicks = 0;
  private testSignatureApplied = false;
  private testSignatureDrawnThisRun = false;
  private fieldSignClicks = 0;
  private agreementActionClicks = 0;
  private agreementConfirmationClicks = 0;

  constructor(readonly page: Page) {}

  async open(
    expectedTestName: string,
    options: { outerHeading?: RegExp } = {}
  ): Promise<RegistrationAgreementInspection> {
    assertClientTestEnvironment(this.page.url());
    await expect(
      this.page.getByRole('heading', {
        name: options.outerHeading ?? /^(?:授权|Authorization)$/i
      }).last()
    ).toBeVisible({ timeout: 30_000 });

    for (let attachAttempt = 0; attachAttempt < 2; attachAttempt += 1) {
      const candidates = await this.waitForAgreementFrames();
      this.signerFrame = candidates[0];
      const frame = this.requireFrame();

      try {
        const completedAtOpen = await this.isDocumentCompletedState(frame);
        const documentTitle = completedAtOpen
          ? 'Current Registration Agreement (completed)'
          : await this.readDocumentTitle(frame);
        const documentBelongsToTestUser = completedAtOpen || this.normalizedIdentity(documentTitle).includes(
          this.normalizedIdentity(expectedTestName)
        );
        if (!documentBelongsToTestUser) {
          throw new Error('Registration Agreement title does not belong to this Fresh test user.');
        }

        const initialRemainingFields = await this.getRemainingFieldCount();
        this.initialProtectedFields = await this.readProtectedFieldState(frame, initialRemainingFields);
        const safeUrl = new URL(frame.url());
        this.providerOrigin = safeUrl.origin;

        return {
          implementation: this.implementation,
          openingMode: 'iframe',
          providerHost: safeUrl.hostname,
          safeFrameUrl: `${safeUrl.origin}${this.safeProviderPath(safeUrl.pathname)}`,
          documentTitle,
          documentBelongsToTestUser,
          initialRemainingFields,
          signatureFieldLocated: false,
          namePreserved: Boolean(
            this.initialProtectedFields.nameValue?.trim() || documentBelongsToTestUser
          ),
          titleStatus: this.initialProtectedFields.titleStatus,
          dateStatus: this.initialProtectedFields.dateStatus,
          identityChallengePresent: await this.hasVisibleIdentityChallenge(frame)
        };
      } catch (error) {
        const detached = frame.isDetached() ||
          (error instanceof Error && /Frame was detached/i.test(error.message));
        if (!detached || attachAttempt === 1) throw error;
      }
    }

    throw new Error('Registration Agreement frame could not be attached.');
  }

  private async waitForAgreementFrames(): Promise<Frame[]> {
    let candidates: Frame[] = [];
    await expect.poll(async () => {
      candidates = [];
      for (const frame of this.page.frames()) {
        if (frame.isDetached()) continue;
        try {
          const heading = frame.getByRole('heading', {
            name: /^(?:Sign Document|签署文档)(?:\s|$)/i
          });
          const signing = (await heading.count()) === 1 && await heading.isVisible();
          if (signing || await this.isDocumentCompletedState(frame)) candidates.push(frame);
        } catch (error) {
          if (!(error instanceof Error) || !/Frame was detached/i.test(error.message)) throw error;
        }
      }
      return candidates.length;
    }, {
      timeout: 30_000,
      intervals: [300, 500, 750, 1_000],
      message: 'Registration Agreement did not expose one embedded signing or completed frame.'
    }).toBe(1);
    return candidates;
  }

  async getRemainingFieldCount(): Promise<number> {
    const frame = this.requireFrame();
    let remainingFields: number | undefined;
    let stableReadyWithoutFields = 0;
    await expect.poll(async () => {
      if (await this.isDocumentCompletedState(frame)) {
        remainingFields = 0;
        return true;
      }
      const loading = frame.getByText(/^Loading\.\.\.$/i);
      if ((await loading.count()) > 0 && await loading.first().isVisible()) {
        stableReadyWithoutFields = 0;
        return false;
      }
      const counters = frame.getByText(
        /(?:\d+\s+Fields?\s+Remaining|\d+\s*个字段剩余)/i
      );
      const values: number[] = [];
      for (const counter of await counters.all()) {
        if (!await counter.isVisible()) continue;
        const text = (await counter.textContent() ?? '').trim();
        const count = Number(text.match(/\d+/)?.[0]);
        if (Number.isFinite(count)) values.push(count);
      }
      if (values.length > 0) {
        remainingFields = Math.min(...values);
        return true;
      }

      const complete = frame.getByRole('button', {
        name: /^(?:Complete|完成|Sign Document|签署文档)$/i
      });
      const visibleSignatureLabels = await this.visibleLocators(
        frame.getByText(/^(?:Signature|签名)$/i)
      );
      const readyWithoutFields =
        (await complete.count()) === 1 &&
        await complete.isVisible() &&
        await complete.isEnabled() &&
        visibleSignatureLabels.length === 0;
      stableReadyWithoutFields = readyWithoutFields ? stableReadyWithoutFields + 1 : 0;
      if (stableReadyWithoutFields < 3) return false;
      remainingFields = 0;
      return true;
    }, {
      timeout: 30_000,
      intervals: [250, 500, 1_000],
      message: 'Registration Agreement did not finish loading its remaining-fields state.'
    }).toBe(true);
    return remainingFields!;
  }

  async inspectCompletedAgreement(): Promise<CompletedRegistrationAgreementInspection> {
    this.requireFrame();
    const providerOrigin = this.providerOrigin;
    if (!providerOrigin) throw new Error('Registration Agreement provider has not been identified.');
    await expect.poll(async () => {
      // Fidere can replace the signing iframe when the completed document loads.
      const completedFrames: Frame[] = [];
      for (const frame of this.page.frames()) {
        if (frame === this.page.mainFrame() || frame.isDetached()) continue;
        const frameUrl = frame.url();
        if (!/^https?:\/\//i.test(frameUrl) || new URL(frameUrl).origin !== providerOrigin) continue;
        if (await this.isDocumentCompletedState(frame)) completedFrames.push(frame);
      }
      if (completedFrames.length === 1) this.signerFrame = completedFrames[0];
      return completedFrames.length;
    }, {
      timeout: 20_000,
      intervals: [250, 500, 1_000],
      message: 'Registration Agreement did not expose one current completed document frame.'
    }).toBe(1);
    const remainingFields = await this.getRemainingFieldCount();
    if (remainingFields !== 0) {
      throw new Error(
        `Completed Registration Agreement must have zero remaining fields; received ${remainingFields}.`
      );
    }
    return { completed: true, remainingFields: 0 };
  }

  async locateSignatureField(): Promise<Locator> {
    const frame = this.requireFrame();
    const remaining = await this.getRemainingFieldCount();
    if (remaining < 1) {
      throw new Error('Registration Agreement has no unfinished field to locate.');
    }

    await this.waitForDocumentPagesReady(frame);
    await this.collapseMobileSignerPanel(frame);
    await this.scrollFrameBottomIntoView(frame);
    const nextField = frame.getByRole('button', {
      name: /^(?:Next Field|下一个字段)$/i
    });
    await expect(nextField).toHaveCount(1);
    await expect(nextField).toBeEnabled();
    await nextField.click();

    await expect.poll(async () => this.currentPdfFieldIsExposed(frame), {
      timeout: 30_000,
      intervals: [200, 400, 750, 1_000],
      message: 'Registration Next Field did not expose the current PDF signature field.'
    }).toBe(true);

    const prompt = frame.getByText(/^(?:Click to insert field|点击填写字段)$/i);
    await expect(prompt).toHaveCount(1);
    const tooltipId = await prompt.getAttribute('id');
    if (!tooltipId) {
      throw new Error('Registration PDF signature field is missing its ARIA association.');
    }
    const pdfField = frame.locator(`[aria-describedby=${JSON.stringify(tooltipId)}]`);
    await expect(pdfField).toHaveCount(1);
    await expect(pdfField).toBeVisible();
    await this.collapseMobileSignerPanel(frame);
    await this.waitForClearPdfFieldHitTarget(frame, pdfField);
    this.signatureField = pdfField;
    this.signatureFieldLocated = true;
    return pdfField;
  }

  async openSignatureEditor(): Promise<void> {
    const frame = this.requireFrame();
    const field = this.requireSignatureField();
    if (this.signatureFieldOpenClicks > 0) {
      throw new Error('Registration PDF signature field may be opened only once per Journey attempt.');
    }
    const box = await field.boundingBox();
    if (!box) throw new Error('Registration PDF signature field has no clickable Canvas position.');
    this.signatureFieldOpenClicks += 1;
    await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const editor = await this.waitForFieldSignatureEditor(frame);
    this.signatureEditor = editor;
  }

  async drawTestSignature(signatureText: string): Promise<'Canvas Draw' | 'Typed Signature'> {
    if (signatureText !== 'TEST') {
      throw new Error('Personal Registration only permits the Sandbox signature TEST.');
    }
    const editor = this.requireSignatureEditor();
    const drawTab = editor.getByText(/^(?:Draw|绘制|手写)$/i);
    if ((await drawTab.count()) > 0 && await drawTab.first().isVisible()) {
      await drawTab.first().click();
    }

    const canvases = editor.locator('canvas');
    const candidates: Array<{ canvas: Locator; area: number; receivesPointer: boolean }> = [];
    for (const canvas of await canvases.all()) {
      if (!await canvas.isVisible()) continue;
      const metadata = await canvas.evaluate(element => {
        const target = element as HTMLCanvasElement;
        const rect = target.getBoundingClientRect();
        const topmost = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2
        );
        return {
          area: rect.width * rect.height,
          receivesPointer: topmost === target || target.contains(topmost)
        };
      });
      candidates.push({ canvas, ...metadata });
    }
    candidates.sort((left, right) =>
      Number(right.receivesPointer) - Number(left.receivesPointer) || right.area - left.area
    );

    for (const { canvas, receivesPointer } of candidates) {
      if (!receivesPointer) continue;
      await canvas.scrollIntoViewIfNeeded();
      const existingInkPixels = await this.countVisibleInkPixels(canvas);
      if (existingInkPixels < 100) {
        await this.drawFixedTestSignature(canvas);
        this.testSignatureDrawnThisRun = true;
      }
      const inkPixels = await this.countVisibleInkPixels(canvas);
      if (inkPixels < 100) {
        throw new Error('Registration TEST trajectory did not produce visible Canvas ink.');
      }
      await this.page.screenshot({
        path: 'test-results/registration-signature-drawn.png',
        fullPage: false
      });
      return 'Canvas Draw';
    }

    const typed = editor.getByRole('textbox', { name: /Signature|签名/i });
    if ((await typed.count()) === 1 && await typed.isVisible()) {
      await typed.fill(signatureText);
      await expect(typed).toHaveValue(signatureText);
      return 'Typed Signature';
    }
    throw new Error(
      candidates.length > 0
        ? 'Registration Agreement Canvas is visible but does not receive pointer input.'
        : 'Registration Agreement exposes neither a Canvas nor Typed signature editor.'
    );
  }

  async completeSignatureField(): Promise<void> {
    const editor = this.requireSignatureEditor();
    const frame = this.requireFrame();
    const sign = editor.getByRole('button', { name: /^(?:Sign|签名|签署)$/i });
    const next = editor.getByRole('button', { name: /^(?:Next|下一步)$/i });
    const apply = (await sign.count()) === 1 ? sign : next;
    await this.clickFieldSignOnce(apply);

    await expect.poll(async () => {
      const remaining = await this.getRemainingFieldCount();
      if (remaining === 0) return 'signed';
      if (await this.hasVisibleFieldAuthentication(frame)) return 'authentication-required';
      if (await this.hasVisibleSigningError(frame)) return 'signing-error';
      return 'pending';
    }, {
      timeout: 30_000,
      intervals: [200, 400, 750, 1_000],
      message: 'Registration PDF signature field did not produce a definitive result.'
    }).toBe('signed');

    await expect(editor).toBeHidden({ timeout: 20_000 });
    this.testSignatureApplied = true;
  }

  async waitForRemainingFieldsZero(): Promise<0> {
    await expect.poll(() => this.getRemainingFieldCount(), {
      timeout: 30_000,
      intervals: [300, 500, 750, 1_000],
      message: 'Registration signature was applied but remaining fields did not reach zero.'
    }).toBe(0);
    await expect.poll(async () => {
      const staleCounter = this.requireFrame().getByText(
        /(?:1\s+Field\s+Remaining|1\s*个字段剩余)/i
      );
      let visible = 0;
      for (const counter of await staleCounter.all()) {
        if (await counter.isVisible()) visible += 1;
      }
      return visible;
    }, {
      timeout: 10_000,
      intervals: [200, 400, 750],
      message: 'Registration Agreement still displays one remaining field.'
    }).toBe(0);
    return 0;
  }

  async finalizeAgreementIfRequired(): Promise<void> {
    const frame = this.requireFrame();
    if (await this.isDocumentCompletedState(frame)) return;
    if (await this.isAuthorizationStepCompleted()) return;
    await this.scrollSignerControlsIntoView(frame);

    const actionCandidates: Locator[] = [];
    for (const button of await frame.getByRole('button').all()) {
      if (!await button.isVisible() || !await button.isEnabled()) continue;
      const name = (await button.innerText()).replace(/\s+/g, ' ').trim();
      if (/^(?:Sign Document|签署文档|Complete|完成)$/i.test(name)) {
        actionCandidates.push(button);
      }
    }
    if (actionCandidates.length > 1) {
      throw new Error('Registration Agreement exposed multiple document completion actions.');
    }
    if (actionCandidates.length === 1) {
      if (this.agreementActionClicks > 0) {
        throw new Error('Registration Agreement completion action may be clicked only once.');
      }
      this.agreementActionClicks += 1;
      await actionCandidates[0].click();

      const confirmation = await this.visibleAgreementConfirmation(frame);
      if (confirmation) {
        const sign = confirmation.getByRole('button', {
          name: /^(?:Sign|签署|Confirm|确认)$/i
        });
        await expect(sign).toHaveCount(1);
        await expect(sign).toBeEnabled();
        if (this.agreementConfirmationClicks > 0) {
          throw new Error('Registration Agreement confirmation may be clicked only once.');
        }
        this.agreementConfirmationClicks += 1;
        await sign.click();
        await expect.poll(async () => {
          if (frame.isDetached()) return true;
          try {
            if (!await confirmation.isVisible()) return true;
            if (await this.isDocumentCompletedState(frame)) return true;
            return this.isAuthorizationStepCompleted();
          } catch (error) {
            return frame.isDetached() ||
              (error instanceof Error && /Frame was detached/i.test(error.message));
          }
        }, {
          timeout: 30_000,
          intervals: [250, 500, 1_000],
          message: 'Registration Agreement Sign confirmation did not settle to a completed state.'
        }).toBe(true);
      }
    }
  }

  async isAuthorizationStepCompleted(): Promise<boolean> {
    const labels = this.page.getByText(/^(?:授权|Authorization)$/i);
    for (const label of await labels.all()) {
      if (!await label.isVisible()) continue;
      const parentText = await label.evaluate(element =>
        (element.parentElement?.textContent ?? '').replace(/\s+/g, ' ').trim()
      );
      if (/(?:已完成|Completed)/i.test(parentText)) return true;
    }
    return false;
  }

  async waitForAuthorizationStepCompleted(timeout = 60_000): Promise<true> {
    await expect.poll(() => this.isAuthorizationStepCompleted(), {
      timeout,
      intervals: [500, 1_000, 2_000, 3_000, 5_000],
      message: 'Registration Agreement completed, but the Fidere Authorization step did not complete.'
    }).toBe(true);
    return true;
  }

  async signSandboxAgreement(input: {
    signatureText: string;
    testTitle: string;
  }): Promise<RegistrationAgreementSigningResult> {
    const initialRemaining = await this.getRemainingFieldCount();
    if (initialRemaining < 1) {
      throw new Error('Fresh Registration Agreement must start with at least one remaining field.');
    }
    await this.prepareTitleIfRequired(input.testTitle, initialRemaining);
    await this.locateSignatureField();
    await this.openSignatureEditor();
    const signatureMethod = await this.drawTestSignature(input.signatureText);
    await this.completeSignatureField();
    const finalRemainingFields = await this.waitForRemainingFieldsZero();
    const protectedFieldsAfter = await this.readProtectedFieldState(
      this.requireFrame(),
      finalRemainingFields
    );
    this.assertProtectedFieldsPreserved(protectedFieldsAfter);
    await this.finalizeAgreementIfRequired();

    return {
      signatureMethod,
      signatureFieldLocated: true,
      testSignatureDrawn: signatureMethod === 'Canvas Draw',
      signatureDrawnThisRun: this.testSignatureDrawnThisRun,
      testSignatureApplied: true,
      documentAlreadyCompleted: false,
      fieldSignClickCount: 1,
      agreementActionClickCount: this.agreementActionClicks,
      agreementConfirmationClickCount: this.agreementConfirmationClicks,
      finalRemainingFields,
      namePreserved: true,
      titleStatus: protectedFieldsAfter.titleStatus,
      dateStatus: protectedFieldsAfter.dateStatus
    };
  }

  async completePreparedSandboxAgreement(): Promise<RegistrationAgreementSigningResult> {
    const finalRemainingFields = await this.getRemainingFieldCount();
    if (finalRemainingFields !== 0) {
      throw new Error('Prepared Registration Agreement must have zero remaining fields.');
    }
    const documentAlreadyCompleted = await this.isDocumentCompletedState(this.requireFrame());
    const protectedFields = documentAlreadyCompleted
      ? this.initialProtectedFields!
      : await this.readProtectedFieldState(this.requireFrame(), finalRemainingFields);
    this.assertProtectedFieldsPreserved(protectedFields);
    this.testSignatureApplied = true;
    await this.finalizeAgreementIfRequired();
    return {
      signatureMethod: 'Canvas Draw',
      signatureFieldLocated: true,
      testSignatureDrawn: true,
      signatureDrawnThisRun: false,
      testSignatureApplied: true,
      documentAlreadyCompleted,
      fieldSignClickCount: 0,
      agreementActionClickCount: this.agreementActionClicks,
      agreementConfirmationClickCount: this.agreementConfirmationClicks,
      finalRemainingFields: 0,
      namePreserved: true,
      titleStatus: protectedFields.titleStatus,
      dateStatus: protectedFields.dateStatus
    };
  }

  fieldSignClickCount(): number {
    return this.fieldSignClicks;
  }

  completionActionClickCount(): number {
    return this.agreementActionClicks;
  }

  confirmationClickCount(): number {
    return this.agreementConfirmationClicks;
  }

  private requireFrame(): Frame {
    if (!this.signerFrame) {
      throw new Error('Registration Agreement frame has not been opened.');
    }
    return this.signerFrame;
  }

  private requireSignatureField(): Locator {
    if (!this.signatureField || !this.signatureFieldLocated) {
      throw new Error('Registration signature field has not been located.');
    }
    return this.signatureField;
  }

  private requireSignatureEditor(): Locator {
    if (!this.signatureEditor) {
      throw new Error('Registration signature editor has not been opened.');
    }
    return this.signatureEditor;
  }

  private async visibleLocators(locator: Locator): Promise<Locator[]> {
    const visible: Locator[] = [];
    for (const candidate of await locator.all()) {
      if (await candidate.isVisible()) visible.push(candidate);
    }
    return visible;
  }

  private async readDocumentTitle(frame: Frame): Promise<string> {
    const headings = frame.getByRole('heading', { level: 1 });
    for (const heading of await headings.all()) {
      if (!await heading.isVisible()) continue;
      const title = (await heading.innerText()).replace(/\s+/g, ' ').trim();
      if (title) return title;
    }
    throw new Error('Registration Agreement did not expose a current document title.');
  }

  private normalizedIdentity(value: string): string {
    return value.toUpperCase().replace(/[_\s-]+/g, ' ').trim();
  }

  private async visibleSignatureEditor(frame: Frame): Promise<Locator | undefined> {
    const dialogs = frame.getByRole('dialog');
    for (const dialog of await dialogs.all()) {
      if (!await dialog.isVisible()) continue;
      const draw = dialog.getByText(/^(?:Draw|绘制|手写)$/i);
      const action = dialog.getByRole('button', {
        name: /^(?:Next|下一步|Sign|签名|签署)$/i
      });
      if ((await draw.count()) > 0 && (await action.count()) === 1) return dialog;
    }
    return undefined;
  }

  private async visibleFieldSignatureEditor(frame: Frame): Promise<Locator | undefined> {
    const dialogs = frame.getByRole('dialog');
    for (const dialog of await dialogs.all()) {
      if (!await dialog.isVisible()) continue;
      const title = dialog.getByRole('heading', {
        name: /^(?:Sign Signature Field|签署签名字段)$/i
      });
      if ((await title.count()) === 1 && await title.isVisible()) return dialog;
    }
    return undefined;
  }

  private async currentPdfFieldIsExposed(frame: Frame): Promise<boolean> {
    const prompt = frame.getByText(/^(?:Click to insert field|点击填写字段)$/i);
    return (await prompt.count()) === 1 && await prompt.isVisible();
  }

  private async waitForDocumentPagesReady(frame: Frame): Promise<void> {
    await expect.poll(() => frame.locator('body').evaluate(() => {
      const loading = Array.from(document.querySelectorAll('*')).some(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 &&
          /^Loading\.\.\.$/i.test((element.textContent ?? '').trim());
      });
      if (loading) return false;
      return Array.from(document.querySelectorAll('*')).some(element => {
        const style = getComputedStyle(element);
        return element.scrollHeight > element.clientHeight * 2 &&
          /(auto|scroll)/.test(style.overflowY);
      });
    }), {
      timeout: 30_000,
      intervals: [250, 500, 1_000],
      message: 'Registration Agreement PDF pages did not finish loading before field navigation.'
    }).toBe(true);
  }

  private async countVisibleInkPixels(canvas: Locator): Promise<number> {
    return canvas.evaluate(element => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext('2d');
      if (!context) return 0;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const alpha = pixels[index + 3];
        const brightness = pixels[index] + pixels[index + 1] + pixels[index + 2];
        if (alpha > 0 && brightness < 720) count += 1;
      }
      return count;
    });
  }

  private async clickFieldSignOnce(sign: Locator): Promise<void> {
    await expect(sign).toHaveCount(1);
    await expect(sign).toBeEnabled();
    if (this.fieldSignClicks > 0) {
      throw new Error('Registration signature field may be applied only once per Journey.');
    }
    this.fieldSignClicks += 1;
    await sign.click();
  }

  private async scrollSignerControlsIntoView(frame: Frame): Promise<void> {
    await this.scrollFrameBottomIntoView(frame);
    const expand = frame.getByRole('button', { name: /^(?:Expand|展开)$/i });
    if ((await expand.count()) === 1 && await expand.isVisible()) {
      await expect(expand).toBeEnabled();
      await expand.click();
    }
  }

  private async scrollFrameBottomIntoView(frame: Frame): Promise<void> {
    const frameElement = await frame.frameElement();
    await frameElement.evaluate(element => (element as Element).scrollIntoView({
      block: 'end',
      inline: 'nearest'
    }));
  }

  private async collapseMobileSignerPanel(frame: Frame): Promise<void> {
    const collapse = frame.getByRole('button', { name: /^(?:Collapse|收起)$/i });
    if ((await collapse.count()) !== 1 || !await collapse.isVisible()) return;
    await collapse.click();
    await expect(frame.getByRole('button', { name: /^(?:Expand|展开)$/i })).toBeVisible();
  }

  private async waitForClearPdfFieldHitTarget(frame: Frame, field: Locator): Promise<void> {
    const frameElement = await frame.frameElement();
    await frameElement.evaluate(element => (element as Element).scrollIntoView({
      block: 'center',
      inline: 'nearest'
    }));

    await expect.poll(async () => {
      const internalClear = await field.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return hit instanceof HTMLCanvasElement;
      });
      if (!internalClear) return false;

      const box = await field.boundingBox();
      if (!box) return false;
      const point = {
        x: box.x + box.width / 2,
        y: box.y + box.height / 2
      };
      return frameElement.evaluate((element, coordinates) => {
        const hit = document.elementFromPoint(coordinates.x, coordinates.y);
        return hit === element || Boolean(hit && element.contains(hit));
      }, point);
    }, {
      timeout: 20_000,
      intervals: [200, 400, 750, 1_000],
      message: 'Registration PDF signature field remained covered by a signing panel or page overlay.'
    }).toBe(true);
  }

  private async waitForFieldSignatureEditor(frame: Frame): Promise<Locator> {
    let editor: Locator | undefined;
    await expect.poll(async () => {
      editor = await this.visibleFieldSignatureEditor(frame) ??
        await this.visibleSignatureEditor(frame);
      return Boolean(editor);
    }, {
      timeout: 20_000,
      intervals: [200, 400, 750, 1_000],
      message: 'Registration PDF signature field did not open its TEST signature editor.'
    }).toBe(true);
    return editor!;
  }

  private async hasVisibleFieldAuthentication(frame: Frame): Promise<boolean> {
    const dialogs = frame.getByRole('dialog');
    for (const dialog of await dialogs.all()) {
      if (!await dialog.isVisible()) continue;
      const text = (await dialog.innerText()).replace(/\s+/g, ' ').trim();
      if (/password|passkey|verification code|two-factor|authenticate|OTP/i.test(text)) {
        return true;
      }
    }
    return false;
  }

  private async hasVisibleSigningError(frame: Frame): Promise<boolean> {
    const alerts = frame.getByRole('alert');
    for (const alert of await alerts.all()) {
      if (!await alert.isVisible()) continue;
      const text = (await alert.innerText()).replace(/\s+/g, ' ').trim();
      if (/unable|failed|error|invalid|could not/i.test(text)) return true;
    }
    return false;
  }

  private async visibleAgreementConfirmation(frame: Frame): Promise<Locator | undefined> {
    let visibleDialog: Locator | undefined;
    let settledState: 'pending' | 'dialog' | 'completed' = 'pending';
    await expect.poll(async () => {
      const dialogs = frame.getByRole('dialog');
      for (const dialog of await dialogs.all()) {
        if (!await dialog.isVisible()) continue;
        const actions = dialog.getByRole('button', {
          name: /^(?:Sign|签署|Confirm|确认)$/i
        });
        if ((await actions.count()) === 1) {
          visibleDialog = dialog;
          settledState = 'dialog';
          return settledState;
        }
      }
      if (await this.isAuthorizationStepCompleted()) {
        settledState = 'completed';
      }
      return settledState;
    }, {
      timeout: 20_000,
      intervals: [200, 400, 750],
      message: 'Registration Agreement completion action produced neither confirmation nor completion.'
    }).not.toBe('pending');
    return visibleDialog;
  }

  private async isDocumentCompletedState(frame: Frame): Promise<boolean> {
    if (frame.isDetached()) return false;
    try {
      const completed = frame.getByText(
        /^(?:Document Completed!|Document (?:signed|completed)|Signing complete|文档已完成[!！]?)$/i
      );
      for (const state of await completed.all()) {
        if (await state.isVisible()) return true;
      }
    } catch (error) {
      if (frame.isDetached() || (error instanceof Error && /Frame was detached/i.test(error.message))) {
        return false;
      }
      throw error;
    }
    return false;
  }

  private async drawFixedTestSignature(canvas: Locator): Promise<void> {
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Registration TEST signature Canvas has no bounding box.');

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

  private async readProtectedFieldState(
    frame: Frame,
    remainingFields: number
  ): Promise<ProtectedFieldState> {
    const nameValue = await this.readOptionalTextbox(frame, /^(?:Name|姓名)$/i);
    const titleValue = await this.readOptionalTextbox(frame, /^(?:Title|职位)$/i);
    const dateValue = await this.readOptionalTextbox(frame, /^(?:Date|日期)$/i);
    return {
      nameValue,
      titleValue,
      dateValue,
      titleStatus: titleValue !== undefined
        ? titleValue.trim() ? 'Prefilled and preserved' : 'Visible but not required'
        : remainingFields === 1
          ? 'Document value preserved; not a remaining field'
          : 'Not exposed as an editable field',
      dateStatus: dateValue !== undefined
        ? dateValue.trim() ? 'Automatically populated and preserved' : 'Visible but not required'
        : 'Document value preserved; not editable'
    };
  }

  private async readOptionalTextbox(frame: Frame, name: RegExp): Promise<string | undefined> {
    const inputs = frame.getByRole('textbox', { name });
    for (const input of await inputs.all()) {
      if (await input.isVisible()) return input.inputValue();
    }
    return undefined;
  }

  private async prepareTitleIfRequired(testTitle: string, remainingFields: number): Promise<void> {
    const frame = this.requireFrame();
    const titles = frame.getByRole('textbox', { name: /^(?:Title|职位)$/i });
    for (const title of await titles.all()) {
      if (!await title.isVisible()) continue;
      const current = await title.inputValue();
      const required = await title.getAttribute('required') !== null ||
        await title.getAttribute('aria-required') === 'true';
      if (!current.trim() && required) {
        if (!testTitle.trim()) {
          throw new Error('REGISTRATION_TEST_TITLE is required for an empty required Title field.');
        }
        await title.fill(testTitle);
        await expect(title).toHaveValue(testTitle);
      }
      return;
    }
    if (remainingFields > 1) {
      throw new Error(
        'Registration Agreement has multiple remaining fields but no editable required Title was identified.'
      );
    }
  }

  private assertProtectedFieldsPreserved(after: ProtectedFieldState): void {
    const before = this.initialProtectedFields;
    if (!before) throw new Error('Registration protected fields were not inspected before signing.');
    for (const key of ['nameValue', 'dateValue'] as const) {
      if (before[key] !== undefined && after[key] !== before[key]) {
        throw new Error(`Registration ${key} changed while applying the TEST signature.`);
      }
    }
  }

  private async hasVisibleIdentityChallenge(frame: Frame): Promise<boolean> {
    const challenges = frame.getByText(
      /OTP|one[- ]time|verification code|captcha|验证码|图形验证|短信验证|邮箱验证/i
    );
    for (const challenge of await challenges.all()) {
      if (await challenge.isVisible()) return true;
    }
    return false;
  }

  private safeProviderPath(pathname: string): string {
    return pathname
      .split('/')
      .map(segment =>
        /^[A-F0-9-]{16,}$/i.test(segment) || /^[A-Za-z0-9_-]{16,}$/.test(segment)
          ? ':id'
          : segment
      )
      .join('/');
  }
}
