import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type CorporateRegistrationStage =
  | 'ACCOUNT_CREATED'
  | 'CORPORATE_SELECTED'
  | 'RECON_IN_PROGRESS'
  | 'RECON_COMPLETED';

export type CorporateRegistrationDraft = {
  schemaVersion: 1;
  runId: string;
  email: string;
  stage: CorporateRegistrationStage;
  accountCreatedAt: string;
  updatedAt: string;
  currentUrl?: string;
  finalSubmissionCount: 0;
};

export const corporateDraftPath = path.resolve('.journey-context/corporate/current.json');
export const corporateAuthPath = path.resolve('auth/corporate-draft.json');

export function loadCorporateDraft(): CorporateRegistrationDraft | undefined {
  try {
    return JSON.parse(readFileSync(corporateDraftPath, 'utf8')) as CorporateRegistrationDraft;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function saveCorporateDraft(draft: CorporateRegistrationDraft): void {
  mkdirSync(path.dirname(corporateDraftPath), { recursive: true });
  writeFileSync(corporateDraftPath, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
}
