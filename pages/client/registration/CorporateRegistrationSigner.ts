import { expect, type Frame, type Page } from '@playwright/test';

import { assertClientTestEnvironment } from '../../../src/utils/clientSafety';
import {
  RegistrationAgreementSigner,
  type RegistrationAgreementInspection,
  type RegistrationAgreementSigningResult
} from './RegistrationAgreementSigner';

export type CorporateSigningInspection = Omit<
  RegistrationAgreementInspection,
  'implementation'
> & {
  implementation: 'CorporateRegistrationSigner';
  domContractVerified: true;
};

export type CorporateSigningResult = RegistrationAgreementSigningResult & {
  implementation: 'CorporateRegistrationSigner';
};

export type CorporateSigningCallbackResult = {
  waitingPageObserved: boolean;
  waitingStatusText: string;
  transitionClickCount: 0 | 1;
  networkObservations: Array<{
    path: string;
    status: number;
    method: string;
  }>;
};

/**
 * Corporate KYB owns this wrapper and its outer-page contract. The deployed
 * Corporate page currently embeds the same Documenso signer build as personal
 * registration; delegation is allowed only after that exact DOM is verified.
 */
export class CorporateRegistrationSigner {
  readonly implementation = 'CorporateRegistrationSigner' as const;
  private readonly embeddedSigner: RegistrationAgreementSigner;

  constructor(readonly page: Page) {
    this.embeddedSigner = new RegistrationAgreementSigner(page);
  }

  async open(expectedSignerName: string): Promise<CorporateSigningInspection> {
    assertClientTestEnvironment(this.page.url());
    const outerHeading = /^(?:授权|Authorization)$/i;
    await expect(
      this.page.getByRole('heading', { name: outerHeading }).first()
    ).toBeVisible({ timeout: 30_000 });

    await this.verifyEmbeddedCorporateContract();
    const inspection = await this.embeddedSigner.open(expectedSignerName, {
      outerHeading
    });
    return {
      ...inspection,
      implementation: this.implementation,
      domContractVerified: true
    };
  }

  async signSandboxDocument(input: {
    signatureText: string;
    testTitle: string;
  }): Promise<CorporateSigningResult> {
    const result = await this.embeddedSigner.signSandboxAgreement(input);
    return { ...result, implementation: this.implementation };
  }

  async waitForCorporateSubmissionStep(): Promise<CorporateSigningCallbackResult> {
    let waitingPageObserved = false;
    let waitingStatusText = 'Not observed';
    let transitionClickCount: 0 | 1 = 0;
    const networkObservations: CorporateSigningCallbackResult['networkObservations'] = [];
    const origin = new URL(this.page.url()).origin;
    const capture = (response: import('@playwright/test').Response) => {
      const url = new URL(response.url());
      if (url.origin !== origin) return;
      if (!/(?:sign|document|documenso|authorization|kyb)/i.test(url.pathname)) return;
      networkObservations.push({
        path: url.pathname,
        status: response.status(),
        method: response.request().method()
      });
    };
    this.page.on('response', capture);
    try {
      await expect.poll(async () => {
        if (/(?:[?&])step=9(?:&|$)/.test(this.page.url())) {
          const submissionHeading = this.page.getByRole('heading', {
            name: /^(?:提交申请|Submit Application)$/i
          }).first();
          if (await submissionHeading.isVisible().catch(() => false)) return 'submission-ready';
        }

        const main = this.page.locator('main').first();
        const text = (await main.isVisible().catch(() => false))
          ? (await main.innerText()).replace(/\s+/g, ' ').trim()
          : '';
        const waitingMatch = text.match(
          /(?:等待签署结果|正在获取签署结果|正在确认签署|等待.*回调|Waiting for.*sign|Checking.*sign)/i
        );
        if (waitingMatch) {
          waitingPageObserved = true;
          waitingStatusText = waitingMatch[0];
        }
        if (/(?:签署失败|获取签署结果失败|Signing failed|Signature failed)/i.test(text)) {
          return 'signing-failed';
        }

        if (waitingPageObserved && /(?:签署成功|签署已完成|已获取签署结果|Signing completed)/i.test(text)) {
          const next = this.page.getByRole('button', {
            name: /^(?:下一步|继续|Next|Continue)$/i
          });
          if ((await next.count()) === 1 && await next.isVisible() && await next.isEnabled()) {
            if (transitionClickCount === 0) {
              transitionClickCount = 1;
              await next.click();
            }
          }
        }
        return 'pending';
      }, {
        timeout: 180_000,
        intervals: [500, 1_000, 2_000, 3_000, 5_000],
        message: 'Corporate signing callback did not reach the submission step.'
      }).toBe('submission-ready');
    } finally {
      this.page.off('response', capture);
    }

    return {
      waitingPageObserved,
      waitingStatusText,
      transitionClickCount,
      networkObservations
    };
  }

  private async verifyEmbeddedCorporateContract(): Promise<void> {
    let signerFrame: Frame | undefined;
    await expect.poll(async () => {
      const matches: Frame[] = [];
      for (const frame of this.page.frames()) {
        if (frame.isDetached()) continue;
        const host = this.safeHost(frame.url());
        if (!/documenso\.com$/i.test(host)) continue;
        const heading = frame.getByRole('heading', {
          name: /^(?:Sign Document|签署文档)(?:\s|$)/i
        });
        if ((await heading.count()) === 1 && await heading.isVisible()) matches.push(frame);
      }
      if (matches.length === 1) signerFrame = matches[0];
      return matches.length;
    }, {
      timeout: 60_000,
      intervals: [300, 500, 750, 1_000, 1_500, 2_000],
      message: 'Corporate authorization did not expose one verified Documenso signer frame.'
    }).toBe(1);

    const frame = signerFrame!;
    const remaining = frame.getByText(/(?:\d+\s+Fields?\s+Remaining|\d+\s*个字段剩余)/i);
    const nextField = frame.getByRole('button', { name: /^(?:Next Field|下一个字段)$/i });
    await expect(remaining.first()).toBeVisible();
    await expect(nextField).toHaveCount(1);
  }

  private safeHost(value: string): string {
    try {
      return new URL(value).hostname;
    } catch {
      return '';
    }
  }
}
