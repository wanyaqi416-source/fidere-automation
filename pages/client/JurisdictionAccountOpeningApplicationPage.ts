import { expect, type Locator, type Page } from '@playwright/test';

import { Decimal, decimalFromText } from '../../src/utils/money';
import { SecurityKeyDialog } from './SecurityKeyDialog';

export type JurisdictionOpeningSummary = {
  currency: string;
  openingFee: Decimal;
  openingFeeText: string;
  paymentAccount: string;
  fundingRule: string;
};

export type JurisdictionOpeningCreationEvidence = {
  route: string;
  status: '申请中' | '已开通';
};

type JurisdictionConfig = {
  region: 'BH' | 'SG';
  accountName: '巴林账户' | '新加坡账户';
};

export class JurisdictionAccountOpeningApplicationPage {
  readonly securityKey: SecurityKeyDialog;
  private confirmationClicks = 0;
  private postSetupConfirmationClicks = 0;
  private applicationCreations = 0;

  constructor(readonly page: Page, private readonly config: JurisdictionConfig) {
    this.securityKey = new SecurityKeyDialog(page);
  }

  async expectLoaded(): Promise<void> {
    await expect(this.page).toHaveURL(
      new RegExp(`/account/jurisdiction-application\\?region=${this.config.region}`)
    );
    await expect(this.page.getByRole('heading', {
      name: `${this.config.accountName}开户申请`,
      exact: true
    })).toBeVisible({ timeout: 20_000 });
    await expect(this.submitButton).toBeVisible();
  }

  async readOpeningFee(): Promise<string> {
    const feeHeading = this.page.getByRole('heading', { name: /^[A-Z]{3}\s+[\d,.]+$/ });
    await expect(feeHeading).toHaveCount(1);
    return (await feeHeading.innerText()).trim();
  }

  async readSummary(): Promise<JurisdictionOpeningSummary> {
    const bodyText = (await this.page.locator('body').innerText()).replace(/\u00a0/g, ' ');
    const openingFeeText = await this.readOpeningFee();
    const currency = openingFeeText.match(/\b[A-Z]{3}\b/)?.[0];
    const paymentAccount = bodyText.match(/扣费账户\s+([^\n]+)/)?.[1]?.trim();
    const fundingRule = bodyText.match(/开户费用将在[^\n]+/)?.[0]?.trim();
    if (!currency || !paymentAccount || !fundingRule) {
      throw new Error(`${this.config.accountName} opening summary is incomplete.`);
    }
    return {
      currency,
      openingFee: decimalFromText(openingFeeText, `${this.config.accountName} opening fee`),
      openingFeeText,
      paymentAccount,
      fundingRule
    };
  }

  async fileInputCount(): Promise<number> {
    return this.page.locator('input[type="file"]').count();
  }

  async submitEnabled(): Promise<boolean> {
    return this.submitButton.isEnabled();
  }

  async openSecurityKeyDialogOnce(beforeClick: () => void): Promise<void> {
    if (this.confirmationClicks > 0) {
      throw new Error(`${this.config.accountName} confirmation may be clicked only once per run.`);
    }
    await expect(this.submitButton).toBeEnabled();
    beforeClick();
    this.confirmationClicks += 1;
    await this.submitButton.click();
    await this.securityKey.waitForOpen();
  }

  async openSecurityKeyDialogAfterSetupOnce(beforeClick: () => void): Promise<void> {
    if (this.postSetupConfirmationClicks > 0) {
      throw new Error(`${this.config.accountName} post-setup confirmation may be clicked only once per run.`);
    }
    await expect(this.submitButton).toBeEnabled();
    beforeClick();
    this.postSetupConfirmationClicks += 1;
    await this.submitButton.click();
    await this.securityKey.waitForOpen();
    await expect(this.securityKey.verifyButton).toBeVisible();
  }

  async waitForApplicationCreationEvidence(
    chooser: {
      goto(baseURL: string): Promise<void>;
      openChooser(): Promise<void>;
      readOption(name: '巴林账户' | '新加坡账户'): Promise<{ status: string }>;
    },
    baseURL: string
  ): Promise<JurisdictionOpeningCreationEvidence> {
    let status: JurisdictionOpeningCreationEvidence['status'] | undefined;
    await expect.poll(async () => {
      await chooser.goto(baseURL);
      await chooser.openChooser();
      const option = await chooser.readOption(this.config.accountName);
      if (option.status === '申请中' || option.status === '已开通') {
        status = option.status;
        return true;
      }
      await this.page.keyboard.press('Escape');
      return false;
    }, {
      timeout: 30_000,
      intervals: [1_000, 2_000, 5_000],
      message: `${this.config.accountName} security was verified once, but no application became observable.`
    }).toBe(true);
    this.applicationCreations += 1;
    return { route: new URL(this.page.url()).pathname, status: status! };
  }

  submissionClickCount(): number {
    return this.confirmationClicks;
  }

  applicationCreateCount(): number {
    return this.applicationCreations;
  }

  postSetupConfirmationClickCount(): number {
    return this.postSetupConfirmationClicks;
  }

  private get submitButton(): Locator {
    return this.page.getByRole('button', { name: '确认并提交申请', exact: true });
  }
}
