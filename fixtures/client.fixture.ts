import { expect, test as base } from '@playwright/test';
import { env } from '../src/config/env';
import { createBusinessReportContext } from '../src/reporting/business-report.fixture';
import type { BusinessReportApi } from '../src/reporting/business-report.types';
import {
  assertClientMutationTestsAllowed,
  assertClientTestEnvironment
} from '../src/utils/clientSafety';

type ClientAccount = {
  username: string;
  password: string;
  otp: string;
};

type ClientFixtures = {
  clientAccount: ClientAccount;
  clientSafetyGuard: void;
  business: BusinessReportApi;
};

export const test = base.extend<ClientFixtures>({
  clientSafetyGuard: [
    async ({ baseURL }, use, testInfo) => {
      assertClientTestEnvironment(baseURL);
      assertClientMutationTestsAllowed(testInfo.tags);

      await use();
    },
    { auto: true }
  ],

  clientAccount: async ({}, use) => {
    const { username, password, otp } = env.client;

    if (!username || !password || !otp) {
      throw new Error(
        'CLIENT_USERNAME, CLIENT_PASSWORD, and CLIENT_OTP are required for authenticated Client tests.'
      );
    }

    await use({ username, password, otp });
  },

  business: async ({}, use, testInfo) => {
    const business = createBusinessReportContext(testInfo);

    try {
      await use(business);
    } finally {
      await business.finalize();
    }
  }
});

export { expect };
