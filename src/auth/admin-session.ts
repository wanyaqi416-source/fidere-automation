import { existsSync, readFileSync } from 'node:fs';
import { chromium, type BrowserContext, type BrowserContextOptions } from '@playwright/test';
import { AdminShellPage } from '../../pages/admin/AdminShellPage';
import { assertSandboxEnvironment } from '../flow-engine/mutation-guard';
import type { AdminAuthStatus } from './admin-auth-preflight';

export async function inspectSavedAdminSession(baseURL: string, storageStatePath: string): Promise<AdminAuthStatus> {
  assertSandboxEnvironment(baseURL);
  if (!existsSync(storageStatePath)) return 'expired';
  let storageState: Exclude<BrowserContextOptions['storageState'], string | undefined>;
  try {
    storageState = JSON.parse(readFileSync(storageStatePath, 'utf8'));
    if (!Array.isArray(storageState?.cookies) || !Array.isArray(storageState?.origins)) return 'expired';
  } catch {
    return 'expired';
  }
  const browser = await chromium.launch({ headless: true });
  try {
    let context: BrowserContext;
    try {
      context = await browser.newContext({ storageState });
    } catch {
      return 'expired';
    }
    return await new AdminShellPage(await context.newPage()).inspectAuthentication(baseURL);
  } finally {
    await browser.close();
  }
}
