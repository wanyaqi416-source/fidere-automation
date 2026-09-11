import type { Page } from '@playwright/test';

import {
  JurisdictionAccountOpeningApplicationPage,
  type JurisdictionOpeningCreationEvidence,
  type JurisdictionOpeningSummary
} from './JurisdictionAccountOpeningApplicationPage';

export type BahrainOpeningSummary = JurisdictionOpeningSummary;
export type BahrainOpeningCreationEvidence = JurisdictionOpeningCreationEvidence;

export class BahrainAccountOpeningPage extends JurisdictionAccountOpeningApplicationPage {
  constructor(page: Page) {
    super(page, { region: 'BH', accountName: '巴林账户' });
  }
}
