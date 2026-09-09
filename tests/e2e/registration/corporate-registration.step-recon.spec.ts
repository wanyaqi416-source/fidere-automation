import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { CorporateRegistrationPage } from '../../../pages/client/CorporateRegistrationPage';
import { env } from '../../../src/config/env';
import { loadCorporateDraft } from '../../../src/registration';
import { refreshCorporateDraftAuthentication } from './corporate-registration.helpers';

const stepFileNames: Readonly<Record<string, string>> = {
  '基本档案': 'basic-profile',
  '运营信息': 'operations',
  '资产来源': 'source-of-assets',
  '合规问询': 'compliance',
  '授权代表': 'authorized-representative',
  '企业董事': 'directors',
  '企业股东': 'shareholders',
  '电子签名': 'electronic-signature',
  '提交申请': 'submission'
};

const variantActions: Readonly<Record<string, readonly string[]>> = {
  'director-natural': ['添加自然人董事'],
  'director-legal': ['法人董事 (0)', '添加法人董事'],
  'shareholder-type': ['添加企业股东'],
  'shareholder-natural': ['添加企业股东', '个人股东'],
  'shareholder-legal': ['添加企业股东', '企业股东']
};

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for Corporate Registration Recon.`);
  return value;
}

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'REG-C-001 Corporate Registration step Recon @registration @corporate @recon @L3',
  async ({ browser }) => {
    const draft = loadCorporateDraft();
    if (!draft) throw new Error('Corporate Registration Draft is required before step Recon.');
    const stepName = required('CORPORATE_RECON_STEP', process.env.CORPORATE_RECON_STEP);
    const fileName = stepFileNames[stepName];
    if (!fileName) throw new Error(`Unsupported Corporate Registration Recon step: ${stepName}.`);
    const variant = process.env.CORPORATE_RECON_VARIANT;
    const actions = variant ? variantActions[variant] : undefined;
    if (variant && !actions) throw new Error(`Unsupported Corporate Registration Recon variant: ${variant}.`);

    const context = await browser.newContext({
      baseURL: required('CLIENT_BASE_URL', env.client.baseUrl),
      storageState: { cookies: [], origins: [] }
    });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    const clientBaseUrl = required('CLIENT_BASE_URL', env.client.baseUrl);
    const directStep = process.env.CORPORATE_RECON_DIRECT === 'true';
    const stepNumber = Object.keys(stepFileNames).indexOf(stepName) + 1;
    const route = directStep
      ? `/zh-CN/registration?step=${stepNumber}&type=corporate`
      : '/zh-CN/registration?type=corporate';
    const targetUrl = new URL(route, clientBaseUrl).toString();
    await refreshCorporateDraftAuthentication({
      page,
      context,
      email: draft.email,
      returnUrl: targetUrl
    });

    const corporate = new CorporateRegistrationPage(page);
    if (!directStep) {
      await corporate.expectOpen();
      await corporate.openAvailableStep(stepName);
    } else {
      await expect
        .poll(() => corporate.visibleText(), {
          message: `Corporate registration direct step ${stepName} did not finish loading.`,
          timeout: 20_000
        })
        .toContain(stepName);
    }
    for (const action of actions ?? []) {
      await corporate.activateVisibleText(action);
    }
    if (process.env.CORPORATE_RECON_MAILING_DIFFERENT === 'true') {
      await corporate.revealDifferentMailingAddress();
    }
    await corporate.pageRoot.waitFor({ state: 'visible' });

    const comboboxes = await corporate.inspectComboboxOptions();
    let validationText: string | undefined;
    if (process.env.CORPORATE_RECON_VALIDATE === 'true') {
      const validationButton = page.getByRole('button', {
        name: /^(?:下一步|创建董事档案|创建股东档案)$/
      }).filter({ visible: true }).first();
      if (await validationButton.isVisible()) {
        await validationButton.click();
        validationText = await corporate.visibleText();
      }
    }

    const snapshot = {
      step: stepName,
      variant,
      url: page.url(),
      capturedAt: new Date().toISOString(),
      bodyText: await corporate.visibleText(),
      controls: await corporate.inspectControls(),
      uploads: await corporate.inspectUploads(),
      comboboxes,
      validationText,
      consoleErrors
    };
    const outputDirectory = path.resolve('.tmp/corporate-recon');
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(
      path.join(outputDirectory, `${fileName}${variant ? `-${variant}` : ''}.json`),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      'utf8'
    );
    await page.screenshot({
      path: path.join(outputDirectory, `${fileName}${variant ? `-${variant}` : ''}.png`),
      fullPage: true
    });
    await context.close();
  }
);
