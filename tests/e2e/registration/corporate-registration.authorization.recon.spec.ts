import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type Response } from '@playwright/test';

import { env } from '../../../src/config/env';
import { CorporateRegistrationJourneyStore } from '../../../src/registration';

type SafeResponseObservation = {
  host: string;
  path: string;
  method: string;
  status: number;
  topLevelKeys?: string[];
  dataKeys?: string[];
  businessCode?: string | number;
  payloadKind?: 'json' | 'non-json' | 'unreadable';
};

function safePath(pathname: string): string {
  return pathname
    .split('/')
    .map(segment =>
      /^[A-F0-9-]{16,}$/i.test(segment) || /^[A-Za-z0-9_-]{16,}$/.test(segment)
        ? ':id'
        : segment
    )
    .join('/');
}

function journeyAuthPath(runId: string): string {
  return path.resolve('auth', 'journeys', `${runId}.json`);
}

function isRelevant(response: Response, clientHost: string): boolean {
  const url = new URL(response.url());
  return url.hostname === clientHost && /\/api\//i.test(url.pathname);
}

async function summarizeResponse(response: Response): Promise<SafeResponseObservation> {
  const url = new URL(response.url());
  const observation: SafeResponseObservation = {
    host: url.hostname,
    path: safePath(url.pathname),
    method: response.request().method().toUpperCase(),
    status: response.status()
  };
  if (!/(?:kyb|authori[sz]|document|create.*doc|sign)/i.test(url.pathname)) return observation;

  try {
    const payload = await response.json() as Record<string, unknown>;
    observation.payloadKind = 'json';
    observation.topLevelKeys = Object.keys(payload).sort();
    observation.businessCode = typeof payload.code === 'string' || typeof payload.code === 'number'
      ? payload.code
      : undefined;
    if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
      observation.dataKeys = Object.keys(payload.data as Record<string, unknown>).sort();
    }
  } catch (error) {
    observation.payloadKind = error instanceof SyntaxError ? 'non-json' : 'unreadable';
  }
  return observation;
}

test.describe.configure({ mode: 'serial', retries: 0 });

test(
  'REG-C-002 Corporate authorization read-only network Recon @registration @corporate @readonly',
  async ({ browser }) => {
    const journey = new CorporateRegistrationJourneyStore().load();
    if (!journey) throw new Error('Active REG-C-002 Journey is required.');
    if (!env.client.baseUrl) throw new Error('CLIENT_BASE_URL is required.');

    const clientUrl = new URL(env.client.baseUrl);
    const context = await browser.newContext({
      baseURL: env.client.baseUrl,
      storageState: journeyAuthPath(journey.runId)
    });
    const page = await context.newPage();
    const responseTasks: Array<Promise<SafeResponseObservation>> = [];
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('response', response => {
      if (isRelevant(response, clientUrl.hostname)) responseTasks.push(summarizeResponse(response));
    });
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 500));
    });
    page.on('pageerror', error => pageErrors.push(error.message.slice(0, 500)));

    await page.goto(
      new URL('/zh-CN/registration?step=8&type=corporate', env.client.baseUrl).toString(),
      { waitUntil: 'domcontentloaded' }
    );
    await expect(page).not.toHaveURL(/\/login(?:$|[?#])/);
    await expect(page.getByRole('heading', { name: /^(?:授权|Authorization)$/i }))
      .toBeVisible({ timeout: 30_000 });

    let networkIdle = true;
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(error => {
      networkIdle = false;
      pageErrors.push(`networkidle unavailable: ${error instanceof Error ? error.name : 'unknown'}`);
    });
    await Promise.allSettled(responseTasks);

    const observations = await Promise.all(responseTasks);
    const frames = page.frames().map(frame => {
      const url = new URL(frame.url());
      return { host: url.hostname, path: safePath(url.pathname) };
    });
    const bodyText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
    const snapshot = {
      capturedAt: new Date().toISOString(),
      journeyStage: journey.stage,
      networkIdle,
      emptyDocumentState: /(?:暂无数据|No data)/i.test(bodyText),
      authorizationHeadingVisible: true,
      frameCount: frames.length,
      documensoFrameCount: frames.filter(frame => /documenso\.com$/i.test(frame.host)).length,
      frames,
      observations,
      consoleErrors,
      pageErrors
    };

    const outputDirectory = path.resolve('.tmp/corporate-recon');
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(
      path.join(outputDirectory, 'authorization-current-journey.json'),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      'utf8'
    );
    await context.close();
  }
);
