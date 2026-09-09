import { expect, type Locator, type Page } from '@playwright/test';
import { BrokerOpeningPage } from './BrokerOpeningPage';
import { SecuritiesTradingPage } from './SecuritiesTradingPage';
import { WEBULL_BROKER_NAME, WEBULL_DOCUMENTS, readWebullSigningResult, type WebullDocumentId } from '../../src/journey/webull-opening';
import { assertSandboxEnvironment } from '../../src/flow-engine';

export class WebullOpeningPage {
  readonly opening: BrokerOpeningPage;
  private confirmationClicks = 0;
  private restored = new Set<WebullDocumentId>();

  constructor(readonly page: Page) {
    this.opening = new BrokerOpeningPage(page);
  }

  async open(baseURL: string) {
    const securities = new SecuritiesTradingPage(this.page);
    await securities.goto(baseURL);
    const cards = (await securities.readBrokerCards()).filter(card => card.name === WEBULL_BROKER_NAME);
    expect(cards, 'Only the Webull card may open this flow').toHaveLength(1);
    expect(cards[0].action, 'An existing application must be resumed, not recreated').toBe('立即开户');
    await securities.openApplication(WEBULL_BROKER_NAME);
    return { card: cards[0], fee: await this.opening.readFee() };
  }

  async inspectUnsignedDocuments() {
    await this.opening.continueWebullToDocuments();
    const entries = [];
    for (const document of WEBULL_DOCUMENTS) {
      const entry = await this.signingEntry(document.id);
      await expect(entry).toBeVisible();
      await expect(entry).toBeEnabled();
      entries.push({ ...document, signingEntryVisible: true, signingEntryEnabled: true });
    }
    await expect(this.nextStep).toBeVisible();
    await expect(this.nextStep).toBeDisabled();
    const progress = this.page.getByText(/^\d+\s*\/\s*\d+\s*已完成$/);
    await expect(progress).toHaveCount(1);
    return { documents: entries, progressText: (await progress.innerText()).trim(), submitEnabled: await this.nextStep.isEnabled() };
  }

  // The nearest container containing this verified label and its own action,
  // never the position of one of two identically named buttons.
  async signingEntry(id: WebullDocumentId): Promise<Locator> {
    const container = await this.documentContainer(id);
    const entry = container.getByRole('button', { name: '去签署', exact: true });
    await expect(entry).toHaveCount(1);
    return entry;
  }

  async expectDocumentSigned(id: WebullDocumentId): Promise<void> {
    await expect.poll(async () => (await this.readDocumentState(id)).completed,
      { timeout: 45_000, message: `Fidere has not confirmed Webull ${id}; never sign it again.` }).toBe(true);
  }

  async readDocumentState(id: WebullDocumentId) {
    const container = await this.findDocumentContainer(id);
    if (!container) return { id, completed: false, action: 'updating' };
    const signed = container.getByRole('button', { name: '已签署', exact: true });
    const completed = await container.getByText('已完成', { exact: true }).isVisible()
      && await signed.count() === 1 && await signed.isDisabled();
    return { id, completed, action: (await container.getByRole('button').allTextContents()).join(' ').trim() };
  }

  async continueToReview(): Promise<void> {
    for (const document of WEBULL_DOCUMENTS) await this.expectDocumentSigned(document.id);
    await expect(this.nextStep).toBeEnabled();
    await this.nextStep.click();
  }

  async restoreExistingSignedDocument(id: WebullDocumentId) {
    assertSandboxEnvironment(this.page.url());
    if (this.restored.has(id)) throw new Error('Existing Webull document may only be restored once per session.');
    this.restored.add(id);
    const entry = await this.signingEntry(id);
    const [response] = await Promise.all([
      this.page.waitForResponse(response => new URL(response.url()).origin === new URL(this.page.url()).origin
        && new URL(response.url()).pathname.endsWith('/brokerage/init-sign')
        && response.request().method() === 'POST', { timeout: 30_000 }),
      entry.click()
    ]);
    const result = readWebullSigningResult(await response.json());
    const evidence = { id, ...result, path: new URL(response.url()).pathname, httpStatus: response.status() };
    console.log('WEBULL_EXISTING_DOCUMENT ' + JSON.stringify(evidence));
    if (!response.ok() || !result.signed) {
      throw new Error(`WEBULL_EXISTING_SIGNING_UNCONFIRMED: ${id}, HTTP ${response.status()}, signed=${result.signed}; no repeat Sign or fee submission.`);
    }
    const dialog = this.page.getByRole('dialog').filter({ hasText: WEBULL_DOCUMENTS.find(document => document.id === id)!.label });
    await expect(dialog.getByText('你已完成签署', { exact: true })).toBeVisible();
    await expect(dialog.getByText('第三方签署已确认', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(dialog).toBeHidden();
    await this.expectDocumentSigned(id);
    return evidence;
  }

  async prepareReview(): Promise<void> {
    await this.continueToReview();
    await expect(this.page.getByText('资料已全部备齐，可提交审核', { exact: true })).toBeVisible();
    for (const document of WEBULL_DOCUMENTS) await expect(this.page.getByText(document.label, { exact: true })).toBeVisible();
    await this.page.getByRole('checkbox', { name: /我确认以上资料真实、完整，并授权/ }).check();
    await expect(this.finalSubmit).toBeEnabled();
  }

  async confirmSubmissionOnce(): Promise<void> {
    assertSandboxEnvironment(this.page.url());
    if (process.env.ALLOW_MONEY_TESTS !== 'true' || process.env.ALLOW_CLIENT_MUTATION_TESTS !== 'true'
      || this.confirmationClicks !== 0) throw new Error('Webull fee confirmation requires authorization and one click only.');
    await expect(this.finalSubmit).toBeEnabled();
    this.confirmationClicks++;
    await this.finalSubmit.click();
  }

  confirmationClickCount(): number { return this.confirmationClicks; }

  private get finalSubmit() {
    return this.page.getByRole('button', { name: '确认提交开户申请', exact: true });
  }

  private async documentContainer(id: WebullDocumentId): Promise<Locator> {
    const container = await this.findDocumentContainer(id);
    if (!container) throw new Error(`No unique signing entry associated with ${id}.`);
    return container;
  }

  private async findDocumentContainer(id: WebullDocumentId): Promise<Locator | undefined> {
    const document = WEBULL_DOCUMENTS.find(item => item.id === id);
    if (!document) throw new Error('Unknown Webull signing document.');
    const label = this.page.getByText(document.label, { exact: true });
    await expect(label).toHaveCount(1);
    let container = label;
    for (let level = 0; level < 6; level++) {
      container = container.locator('..');
      const actions = container.getByRole('button', { name: /^(去签署|已签署)$/ });
      const otherLabel = WEBULL_DOCUMENTS.find(item => item.id !== id)!.label;
      if (await container.getByText(otherLabel, { exact: true }).count()) break;
      if (await actions.count() === 1) return container;
    }
    return undefined;
  }

  private get nextStep() {
    return this.page.getByRole('button', { name: '下一步：提交审核', exact: true });
  }
}
