import { defineConfig, devices } from '@playwright/test';
import { authStatePaths } from './src/config/auth';
import { env } from './src/config/env';

export default defineConfig({
  globalSetup: './global-setup.ts',
  testDir: './tests',
  timeout: env.testTimeoutMs,
  expect: {
    timeout: env.expectTimeoutMs
  },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ['list', { printSteps: true }],
    [
      'html',
      {
        outputFolder: 'playwright-report',
        open: 'never',
        title: 'Fidere Client Automation Test Report'
      }
    ],
    ['junit', { outputFile: 'reports/junit-results.xml' }],
    ['./reporters/fidere-business-reporter.ts']
  ],
  use: {
    actionTimeout: env.actionTimeoutMs,
    navigationTimeout: env.navigationTimeoutMs,
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'client-auth',
      testMatch: 'setup/client.auth.setup.ts',
      retries: 0,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: env.client.baseUrl,
        storageState: { cookies: [], origins: [] },
        trace: 'off',
        screenshot: 'off',
        video: 'off'
      }
    },
    {
      name: 'opening-client-auth',
      testMatch: 'setup/opening-client.auth.setup.ts',
      retries: 0,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: env.client.baseUrl,
        storageState: { cookies: [], origins: [] },
        trace: 'off',
        screenshot: 'off',
        video: 'off'
      }
    },
    {
      name: 'client',
      testMatch: 'client/**/*.spec.ts',
      testIgnore: [
        'client/account-opening/us-account-opening-validation.spec.ts',
        'client/account-opening/singapore-account-opening-readonly.spec.ts',
        'client/account-opening/bahrain-account-opening-validation.spec.ts'
      ],
      dependencies: ['client-auth'],
      retries: 0,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: env.client.baseUrl,
        storageState: authStatePaths.client
      }
    },
    {
      name: 'opening-client',
      testMatch: [
        'client/account-opening/us-account-opening-validation.spec.ts',
        'client/account-opening/singapore-account-opening-readonly.spec.ts',
        'client/account-opening/bahrain-account-opening-validation.spec.ts'
      ],
      dependencies: ['opening-client-auth'],
      retries: 0,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: env.client.baseUrl,
        storageState: authStatePaths.openingClient
      }
    },
    {
      name: 'admin',
      testMatch: 'admin/**/*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: env.admin.baseUrl,
        storageState: authStatePaths.admin
      }
    },
    {
      name: 'workflows',
      testMatch: ['workflows/**/*.spec.ts', 'e2e/**/*.spec.ts'],
      testIgnore: [
        'e2e/account-opening/us-account-opening.dry-run.spec.ts',
        'e2e/account-opening/bahrain-account-opening.dry-run.spec.ts',
        'e2e/account-opening/bahrain-account-opening.spec.ts',
        'e2e/account-opening/singapore-account-opening.spec.ts',
        'e2e/account-opening/us-account-opening.preflight.spec.ts',
        'e2e/account-opening/us-account-opening-resume.preflight.spec.ts',
        'e2e/account-opening/us-account-opening-fee-resume.preflight.spec.ts',
        'e2e/account-opening/us-account-opening-approve.spec.ts',
        'e2e/account-opening/us-account-opening-resume.spec.ts'
      ],
      dependencies: ['client-auth'],
      retries: 0,
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'opening-workflows',
      testMatch: [
        'e2e/account-opening/us-account-opening.dry-run.spec.ts',
        'e2e/account-opening/bahrain-account-opening.dry-run.spec.ts',
        'e2e/account-opening/bahrain-account-opening.spec.ts',
        'e2e/account-opening/singapore-account-opening.spec.ts',
        'e2e/account-opening/us-account-opening.preflight.spec.ts',
        'e2e/account-opening/us-account-opening-resume.preflight.spec.ts',
        'e2e/account-opening/us-account-opening-fee-resume.preflight.spec.ts',
        'e2e/account-opening/us-account-opening-approve.spec.ts',
        'e2e/account-opening/us-account-opening-resume.spec.ts'
      ],
      dependencies: ['opening-client-auth'],
      retries: 0,
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'reporting',
      testMatch: 'reporting/**/*.spec.ts',
      retries: 0,
      use: {
        trace: 'off',
        screenshot: 'off',
        video: 'off'
      }
    },
    {
      name: 'registration-workflows',
      testMatch: 'e2e/registration/**/*.spec.ts',
      retries: 0,
      use: {
        ...devices['Desktop Chrome'],
        storageState: { cookies: [], origins: [] },
        trace: 'off',
        screenshot: 'off',
        video: 'off'
      }
    }
  ],
  outputDir: 'test-results'
});
