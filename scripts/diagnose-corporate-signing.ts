import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { chromium, type Response } from '@playwright/test';
import 'dotenv/config';

type CorporateJourney = {
  runId: string;
  stage: string;
};

type SafeResponseSummary = {
  capturedAt: string;
  method: string;
  url: string;
  httpStatus: number;
  contentType: string;
  bodyLength: number;
  body: unknown;
};

const safeBodyKeys = new Set([
  'code',
  'status',
  'success',
  'message',
  'msg',
  'error',
  'errorCode',
  'detail',
  'reason'
]);

function safeDataShape(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'string') {
    return { type: 'string', empty: value.length === 0, length: value.length };
  }
  if (Array.isArray(value)) return { type: 'array', itemCount: value.length };
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const fields = Object.fromEntries(Object.entries(record).map(([key, item]) => {
      if (typeof item === 'string') {
        let host: string | undefined;
        if (/url/i.test(key) && item.length > 0) {
          try {
            host = new URL(item).hostname;
          } catch {
            host = undefined;
          }
        }
        return [key, {
          type: 'string',
          empty: item.length === 0,
          length: item.length,
          ...(host ? { host } : {})
        }];
      }
      if (item === null) return [key, { type: 'null' }];
      if (Array.isArray(item)) return [key, { type: 'array', itemCount: item.length }];
      return [key, { type: typeof item }];
    }));
    return {
      type: 'object',
      keys: Object.keys(record).sort(),
      fields,
      safeFields: safeBody(value)
    };
  }
  return { type: typeof value, value };
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for corporate signing diagnostics.`);
  return value;
}

function sanitizeText(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[masked-email]')
    .replace(/\b1\d{10}\b/g, '[masked-phone]')
    .replace(/\b(?:eyJ[A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+\b/g, '[masked-token]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[masked-secret]')
    .slice(0, 1_000);
}

function safeBody(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return { itemCount: value.length };
  if (typeof value !== 'object') return String(value);

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (key === 'data') {
      result.data = safeDataShape(item);
      continue;
    }
    if (!safeBodyKeys.has(key)) continue;
    result[key] = safeBody(item);
  }
  return {
    keys: Object.keys(source).sort(),
    ...result
  };
}

async function summarize(response: Response): Promise<SafeResponseSummary> {
  const contentType = response.headers()['content-type'] ?? '';
  const rawBody = await response.text();
  let parsed: unknown = rawBody;
  if (/json/i.test(contentType)) {
    try {
      parsed = JSON.parse(rawBody) as unknown;
    } catch {
      parsed = rawBody;
    }
  }

  const responseUrl = new URL(response.url());
  return {
    capturedAt: new Date().toISOString(),
    method: response.request().method(),
    url: `${responseUrl.origin}${responseUrl.pathname}`,
    httpStatus: response.status(),
    contentType,
    bodyLength: Buffer.byteLength(rawBody),
    body: safeBody(parsed)
  };
}

async function main(): Promise<void> {
  const baseUrl = required('CLIENT_BASE_URL', process.env.CLIENT_BASE_URL);
  const baseHost = new URL(baseUrl).hostname;
  if (!/(?:sandbox|staging|\.test)(?:\.|$)/i.test(baseHost)) {
    throw new Error(`Refusing corporate signing diagnostics on non-Sandbox host: ${baseHost}`);
  }

  const journeyPath = path.resolve('.journey-context', 'corporate', 'reg-c-002-current.json');
  if (!existsSync(journeyPath)) throw new Error('No current corporate journey is available.');
  const journey = JSON.parse(readFileSync(journeyPath, 'utf8')) as CorporateJourney;
  if (journey.stage !== 'AUTHORIZATION') {
    throw new Error(`Corporate signing diagnostics require AUTHORIZATION stage, received ${journey.stage}.`);
  }

  const authPath = path.resolve('auth', 'journeys', `${journey.runId}.json`);
  if (!existsSync(authPath)) throw new Error('Current corporate journey authentication state is missing.');

  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({ storageState: authPath });
    const page = await context.newPage();
    const responsePromise = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === 'POST' && url.pathname.endsWith('/api/kyb/init-doc-sign');
    }, { timeout: 45_000 });

    await page.goto(
      new URL('/zh-CN/registration?step=8&type=corporate', baseUrl).toString(),
      { waitUntil: 'domcontentloaded' }
    );
    const response = await responsePromise;
    const summary = await summarize(response);

    const outputDir = path.resolve('reports', 'diagnostics');
    mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'corporate-signing-init-latest.json');
    writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

    console.log(JSON.stringify({ ...summary, outputPath }, null, 2));
    await context.close();
  } finally {
    await browser.close();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
