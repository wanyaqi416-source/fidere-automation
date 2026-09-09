import { expect, test as base } from '@playwright/test';

import { createBusinessReportContext } from '../src/reporting/business-report.fixture';
import type { BusinessReportApi } from '../src/reporting/business-report.types';

type ReportingFixtures = {
  business: BusinessReportApi;
};

export const test = base.extend<ReportingFixtures>({
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
