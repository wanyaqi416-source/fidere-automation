import type { Page } from '@playwright/test';

import {
  JurisdictionAccountOpeningApplicationPage,
  type JurisdictionOpeningCreationEvidence,
  type JurisdictionOpeningSummary
} from './JurisdictionAccountOpeningApplicationPage';

export type SingaporeOpeningSummary = JurisdictionOpeningSummary;
export type SingaporeOpeningCreationEvidence = JurisdictionOpeningCreationEvidence;

export class SingaporeAccountOpeningPage extends JurisdictionAccountOpeningApplicationPage {
  constructor(page: Page) {
    super(page, { region: 'SG', accountName: '新加坡账户' });
  }
}
