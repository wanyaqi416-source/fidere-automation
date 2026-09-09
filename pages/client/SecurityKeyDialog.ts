import { expect, type Locator, type Page } from '@playwright/test';

export type SecurityKeyInputDescriptor = {
  tagName: string;
  type: string;
  inputMode: string;
  maxLength: number;
  placeholder: string;
  ariaLabel: string;
};

export type SecurityKeyDomStructure = {
  visibleInputCount: number;
  inputs: SecurityKeyInputDescriptor[];
  buttonLabels: string[];
};

export type SecurityKeySetupEvidence = {
  required: boolean;
  actionClickCount: number;
  actionLabels: string[];
  verificationReady: boolean;
  dialogClosed: boolean;
};

export class SecurityKeyDialog {
  readonly page: Page;
  readonly dialog: Locator;
  readonly title: Locator;
  readonly inputs: Locator;
  readonly verifyButton: Locator;
  private verificationClicks = 0;
  private setupActionClicks = 0;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page
      .getByRole('dialog')
      .filter({ hasText: /安全密钥/ })
      .last();
    this.title = this.dialog.getByText(/安全密钥/).first();
    this.inputs = this.dialog.locator('input');
    this.verifyButton = this.dialog.getByRole('button', { name: '验证', exact: true });
  }

  async waitForOpen(): Promise<void> {
    await expect(this.dialog).toBeVisible();
    await expect(this.title).toBeVisible();
  }

  async readDomStructure(): Promise<SecurityKeyDomStructure> {
    const visibleInputs = await this.visibleInputs();
    const inputs = await Promise.all(
      visibleInputs.map(input =>
        input.evaluate(element => {
          const field = element as HTMLInputElement;
          return {
            tagName: field.tagName.toLowerCase(),
            type: field.type,
            inputMode: field.inputMode,
            maxLength: field.maxLength,
            placeholder: field.placeholder,
            ariaLabel: field.getAttribute('aria-label') ?? ''
          };
        })
      )
    );
    const buttonLabels = (await this.dialog.getByRole('button').allTextContents())
      .map(label => label.trim())
      .filter(Boolean);

    return { visibleInputCount: visibleInputs.length, inputs, buttonLabels };
  }

  async fill(securityKey: string): Promise<void> {
    if (!/^\d{6}$/.test(securityKey)) {
      throw new Error('完成安全密钥验证失败：CLIENT_SECURITY_KEY 必须配置为6位数字。');
    }

    const visibleInputs = await this.visibleInputs();
    if (visibleInputs.length === 1) {
      await visibleInputs[0].fill(securityKey);
      return;
    }

    if (visibleInputs.length === securityKey.length) {
      for (const [index, input] of visibleInputs.entries()) {
        await input.fill(securityKey[index]);
      }
      return;
    }

    throw new Error(
      `完成安全密钥验证失败：预期1个组合输入框或6个独立输入框，实际发现${visibleInputs.length}个可见输入框。`
    );
  }

  async configureIfRequired(securityKey: string): Promise<SecurityKeySetupEvidence> {
    await this.waitForOpen();
    if (await this.verifyButton.isVisible().catch(() => false)) {
      return {
        required: false,
        actionClickCount: 0,
        actionLabels: [],
        verificationReady: true,
        dialogClosed: false
      };
    }

    const actionLabels: string[] = [];
    for (let step = 0; step < 3; step += 1) {
      const visibleInputs = await this.visibleInputs();
      if (visibleInputs.length > 0) {
        await this.fill(securityKey);
      }
      if (await this.verifyButton.isVisible().catch(() => false)) {
        return {
          required: false,
          actionClickCount: 0,
          actionLabels: [],
          verificationReady: true,
          dialogClosed: false
        };
      }

      const action = this.dialog.getByRole('button', {
        name: /^(?:下一步|确认|确定|设置|确认设置)$/
      });
      const actionCount = await action.count();
      if (actionCount !== 1) {
        const buttons = (await this.dialog.getByRole('button').allInnerTexts())
          .map(label => label.trim())
          .filter(Boolean);
        throw new Error(
          `Security Key setup expected one bounded action, found ${actionCount}; available buttons: ${buttons.join(', ') || '[none]'}.`
        );
      }

      const label = (await action.innerText()).trim();
      const before = await this.setupStepFingerprint();
      this.setupActionClicks += 1;
      actionLabels.push(label);
      await action.click();

      await expect.poll(async () => {
        if (!await this.dialog.isVisible().catch(() => false)) return true;
        if (await this.verifyButton.isVisible().catch(() => false)) return true;
        return (await this.setupStepFingerprint()) !== before;
      }, {
        timeout: 15_000,
        intervals: [250, 500, 1_000],
        message: `Security Key setup did not advance after step ${step + 1}.`
      }).toBe(true);

      if (!await this.dialog.isVisible().catch(() => false)) {
        return {
          required: true,
          actionClickCount: this.setupActionClicks,
          actionLabels,
          verificationReady: false,
          dialogClosed: true
        };
      }
      if (await this.verifyButton.isVisible().catch(() => false)) {
        return {
          required: true,
          actionClickCount: this.setupActionClicks,
          actionLabels,
          verificationReady: true,
          dialogClosed: false
        };
      }
    }

    throw new Error('Security Key setup did not reach verification or completion within three bounded steps.');
  }

  async completeSetupWizard(securityKey: string): Promise<SecurityKeySetupEvidence> {
    await this.waitForOpen();
    if (this.setupActionClicks !== 0) {
      throw new Error('Security Key setup wizard may run only once per browser context.');
    }

    const actionLabels: string[] = [];
    for (let step = 0; step < 3; step += 1) {
      const visibleInputs = await this.visibleInputs();
      if (visibleInputs.length > 0) {
        await this.fill(securityKey);
      }

      const action = this.dialog.getByRole('button', {
        name: /^(?:下一步|验证|确认|确定|设置|确认设置)$/
      });
      const actionCount = await action.count();
      if (actionCount !== 1) {
        const buttons = (await this.dialog.getByRole('button').allInnerTexts())
          .map(label => label.trim())
          .filter(Boolean);
        throw new Error(
          `Security Key setup step ${step + 1} expected one action, found ${actionCount}; available buttons: ${buttons.join(', ') || '[none]'}.`
        );
      }

      const label = (await action.innerText()).trim();
      const before = await this.setupStepFingerprint();
      this.setupActionClicks += 1;
      actionLabels.push(label);
      await action.click();

      await expect.poll(async () => {
        if (!await this.dialog.isVisible().catch(() => false)) return true;
        return (await this.setupStepFingerprint()) !== before;
      }, {
        timeout: 15_000,
        intervals: [250, 500, 1_000],
        message: `Security Key setup wizard did not advance after step ${step + 1}.`
      }).toBe(true);

      if (!await this.dialog.isVisible().catch(() => false)) {
        return {
          required: true,
          actionClickCount: this.setupActionClicks,
          actionLabels,
          verificationReady: false,
          dialogClosed: true
        };
      }
    }

    throw new Error('Security Key setup wizard remained open after three bounded steps.');
  }

  async verifyOnce(): Promise<void> {
    if (this.verificationClicks > 0) {
      throw new Error('安全密钥“验证”按钮已点击过一次；为避免重复提交，本测试不会再次点击。');
    }

    this.verificationClicks += 1;
    await this.verifyButton.click();
    try {
      await expect(this.dialog).toBeHidden({ timeout: 10_000 });
    } catch (error) {
      throw new Error(
        '完成安全密钥验证失败：点击一次“验证”后弹窗仍然可见；测试已停止且不会再次点击。',
        { cause: error }
      );
    }
  }

  async closeWithoutVerifying(): Promise<void> {
    if (this.verificationClicks > 0) {
      throw new Error('不能把已点击“验证”的资金操作作为提交前校验关闭。');
    }

    const closeButton = this.dialog.getByRole('button', { name: /^(关闭|close)$/i });
    if ((await closeButton.count()) === 1) {
      await closeButton.click();
    } else {
      await this.page.keyboard.press('Escape');
    }
    await expect(this.dialog).toBeHidden();
  }

  wasVerificationClicked(): boolean {
    return this.verificationClicks > 0;
  }

  verificationClickCount(): number {
    return this.verificationClicks;
  }

  setupActionClickCount(): number {
    return this.setupActionClicks;
  }

  async isVerificationStep(): Promise<boolean> {
    return this.verifyButton.isVisible().catch(() => false);
  }

  private async setupStepFingerprint(): Promise<string> {
    const structure = await this.readDomStructure();
    const text = (await this.dialog.innerText())
      .replace(/\d/g, '#')
      .replace(/\s+/g, ' ')
      .trim();
    return JSON.stringify({
      text,
      visibleInputCount: structure.visibleInputCount,
      inputValueLengths: await Promise.all(
        (await this.visibleInputs()).map(input => input.inputValue().then(value => value.length))
      ),
      placeholders: structure.inputs.map(input => input.placeholder),
      ariaLabels: structure.inputs.map(input => input.ariaLabel),
      buttons: structure.buttonLabels
    });
  }

  private async visibleInputs(): Promise<Locator[]> {
    const visible: Locator[] = [];
    for (const input of await this.inputs.all()) {
      if (await input.isVisible()) {
        visible.push(input);
      }
    }
    return visible;
  }
}
