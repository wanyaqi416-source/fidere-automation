import { createHash } from 'node:crypto';
import { expect, type Frame, type Locator, type Page, type Response } from '@playwright/test';
import { assertClientTestEnvironment } from '../../src/utils/clientSafety';
import { getWebullSignerIdentity, WEBULL_DOCUMENTS, type WebullDocumentId } from '../../src/journey/webull-opening';

const TEST_STROKES = [
  [[.06,.25],[.20,.25]], [[.13,.25],[.13,.78]],
  [[.28,.25],[.28,.78]], [[.28,.25],[.42,.25]],
  [[.28,.51],[.39,.51]], [[.28,.78],[.42,.78]],
  [[.61,.30],[.56,.24],[.48,.26],[.46,.39],[.50,.49],[.58,.54],[.61,.66],[.58,.77],[.49,.79],[.44,.73]],
  [[.69,.25],[.86,.25]], [[.775,.25],[.775,.78]]
] as const;

/** Owns only Webull's verified W-8BEN and multi-page CRS embeds. */
export class WebullDocumentSigner {
  private frame?: Frame;
  private fullName = '';
  private fieldSignClicks = 0;
  private completeClicks = 0;
  private signClicks = 0;
  constructor(readonly page: Page, readonly documentId: WebullDocumentId) {}

  async attach(expectedName: string) {
    assertClientTestEnvironment(this.page.url());
    getWebullSignerIdentity();
    const definition = WEBULL_DOCUMENTS.find(document => document.id === this.documentId);
    if (!definition) throw new Error('Unknown Webull document type.');
    await expect(this.page.getByRole('dialog').getByRole('heading', { name: definition.label, exact: true })).toBeVisible();
    await expect.poll(() => this.page.frames().filter(frame => /^https:\/\/app\.documenso\.com\//.test(frame.url())).length,
      { timeout: 45_000 }).toBe(1);
    this.frame = this.page.frames().find(frame => /^https:\/\/app\.documenso\.com\//.test(frame.url()))!;
    const name = this.frame.getByRole('textbox', { name: 'Full Name', exact: true });
    await expect(name).not.toHaveValue('');
    this.fullName = await name.inputValue();
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toUpperCase();
    if (normalize(this.fullName) !== normalize(expectedName)) throw new Error('Webull signer does not match this Journey.');
    await expect(this.frame.getByText('Signature', { exact: true })).toHaveCount(1);
    await expect.poll(() => this.frame!.locator('canvas').count(), { timeout: 45_000 }).toBeGreaterThan(0);
    for (const challenge of await this.frame.getByText(/one[- ]time|verification code|captcha|验证码/i).all()) {
      if (await challenge.isVisible()) throw new Error('Webull signing requires an unexpected identity challenge.');
    }
    const fieldsRemaining = await this.remaining();
    return { fieldsRemaining, alreadySigned: fieldsRemaining === 0,
      documentReference: createHash('sha256').update(this.frame.url()).digest('hex'), provider: 'app.documenso.com' };
  }

  async prepare() {
    this.assertMutation();
    const frame = this.requireFrame();
    const before = await this.remaining();
    if (before <= 0 || this.fieldSignClicks !== 0) throw new Error('Webull signature already present or attempted.');
    await frame.getByRole('button', { name: 'Next Field', exact: true }).click();
    const tooltip = frame.getByText('Click to insert field', { exact: true });
    await expect(tooltip).toBeVisible({ timeout: 30_000 });
    const tooltipId = await tooltip.getAttribute('id');
    if (!tooltipId) throw new Error('Webull signature field lacks its ARIA relationship.');
    // CRS has several PDF pages; associate the semantic field with its own canvas.
    await frame.evaluate(id => {
      const fields = Array.from(document.querySelectorAll('[aria-describedby]'))
        .filter(node => node.getAttribute('aria-describedby')?.split(/\s+/).includes(id));
      if (fields.length !== 1) throw new Error('Webull signature field is not unique.');
      const rect = fields[0].getBoundingClientRect();
      const clientX = rect.x + rect.width / 2;
      const clientY = rect.y + rect.height / 2;
      const canvases = Array.from(document.querySelectorAll('canvas')).filter(canvas => {
        const box = canvas.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
      });
      if (canvases.length !== 1) throw new Error('Cannot associate Webull field with exactly one PDF page.');
      const common = { bubbles: true, cancelable: true, clientX, clientY };
      const canvas = canvases[0];
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...common, pointerId: 1, isPrimary: true }));
      canvas.dispatchEvent(new MouseEvent('mousedown', common));
      canvas.dispatchEvent(new PointerEvent('pointerup', { ...common, pointerId: 1, isPrimary: true }));
      canvas.dispatchEvent(new MouseEvent('mouseup', common));
      canvas.dispatchEvent(new MouseEvent('click', common));
    }, tooltipId);
    const dialog = frame.getByRole('dialog').filter({ hasText: 'Sign Signature Field' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Draw', { exact: true })).toBeVisible();
    await this.draw(dialog.locator('canvas'));
    const sign = dialog.getByRole('button', { name: 'Sign', exact: true });
    await expect(sign).toBeEnabled();
    this.fieldSignClicks += 1;
    await sign.click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => this.remaining(), { timeout: 30_000 }).toBe(0);
    await expect(frame.getByRole('textbox', { name: 'Full Name', exact: true })).toHaveValue(this.fullName);
    return { requiredFieldsBefore: before, requiredFieldsAfter: 0, signatureMethod: 'Canvas Draw', namePreserved: true };
  }

  async complete() {
    this.assertMutation();
    if (this.completeClicks !== 0 || await this.remaining() !== 0) throw new Error('Webull Complete requires zero fields and no previous click.');
    const button = this.requireFrame().getByRole('button', { name: 'Complete', exact: true });
    await expect(button).toBeEnabled();
    this.completeClicks += 1;
    await button.click();
    const confirmation = this.confirmation();
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole('button', { name: /^(Cancel|取消)$/ })).toBeVisible();
    await expect(confirmation.getByRole('button', { name: /^(Sign|签署)$/ })).toBeEnabled();
    const lines = (await confirmation.innerText()).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const prompt = lines.indexOf('You are about to complete signing the following document');
    if (prompt < 0 || !lines[prompt + 1]) throw new Error('Webull confirmation has no actual document title.');
    return { documentTitlePresent: true };
  }

  async confirm() {
    this.assertMutation();
    if (this.completeClicks !== 1 || this.signClicks !== 0) throw new Error('Webull Sign executes once after Complete.');
    const frame = this.requireFrame();
    const dialog = this.confirmation();
    const button = dialog.getByRole('button', { name: /^(Sign|签署)$/ });
    await expect(button).toBeEnabled();
    let responseEvidence: { requestPath: string; httpStatus: number } | undefined;
    const observe = (response: Response) => {
      const url = new URL(response.url());
      if (url.hostname === 'app.documenso.com' && url.pathname === '/api/trpc/recipient.completeDocumentWithToken') {
        responseEvidence = { requestPath: url.pathname, httpStatus: response.status() };
      }
    };
    this.page.on('response', observe);
    this.signClicks += 1;
    try {
      await button.click();
      await expect.poll(async () => frame.isDetached() || !(await dialog.isVisible()), { timeout: 45_000 }).toBe(true);
      return { ...responseEvidence, completionEvidence: frame.isDetached() ? 'frame-detached' : 'confirmation-hidden' };
    } finally { this.page.off('response', observe); }
  }

  counts() { return { fieldSign: this.fieldSignClicks, complete: this.completeClicks, sign: this.signClicks }; }
  private assertMutation() {
    assertClientTestEnvironment(this.page.url());
    getWebullSignerIdentity();
    if (process.env.ALLOW_CLIENT_MUTATION_TESTS !== 'true') throw new Error('Webull signing requires ALLOW_CLIENT_MUTATION_TESTS.');
  }
  private requireFrame() { if (!this.frame) throw new Error('Webull document not attached.'); return this.frame; }
  private confirmation() { return this.requireFrame().getByRole('dialog').filter({ hasText: /Are you sure\?|你确定吗/ }); }
  private async remaining() {
    const counts: number[] = [];
    for (const counter of await this.requireFrame().getByText(/^\d+ Fields? Remaining$/i).all()) {
      if (await counter.isVisible()) counts.push(Number((await counter.innerText()).match(/\d+/)![0]));
    }
    if (counts.length === 0 || new Set(counts).size !== 1) throw new Error('Webull field counters missing or inconsistent.');
    return counts[0];
  }
  private async draw(canvas: Locator) {
    await expect(canvas).toHaveCount(1);
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Webull signature canvas not visible.');
    for (const [start, ...points] of TEST_STROKES) {
      await this.page.mouse.move(box.x + start[0] * box.width, box.y + start[1] * box.height);
      await this.page.mouse.down();
      try {
        for (const [x,y] of points) await this.page.mouse.move(box.x + x * box.width, box.y + y * box.height, { steps: 3 });
      } finally { await this.page.mouse.up(); }
    }
  }
}
