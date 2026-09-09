import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export type PersonalRegistrationProfile = {
  schemaVersion: 1;
  sandboxOnly: true;
  firstName: string;
  lastName: string;
  idType: string;
  idNumberPrefix: string;
  idIssueDate: string;
  idExpiryDate: string;
  dateOfBirth: string;
  placeOfBirth: string;
  gender: string;
  maritalStatus: string;
  citizenship: string;
  accountPurpose: string;
  sourceOfFunds: string;
  sourceOfWealth: string;
  occupation: string;
  careerStatus: string;
  employerName: string;
  industryType: string;
  careerPosition: string;
  annualIncome: string;
  anticipatedAssetClass: string;
  thirdPartyDeposits: string;
  phonePrefix: string;
  streetAddress: string;
  detailedAddress: string;
  city: string;
  stateRegion: string;
  postalCode: string;
  country: string;
  taxNumberPrefix: string;
};

function requiredString(
  value: unknown,
  field: keyof PersonalRegistrationProfile
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Sandbox personal registration profile requires ${field}.`);
  }
  return value.trim();
}

function assertDate(value: string, field: keyof PersonalRegistrationProfile): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Sandbox personal registration profile ${field} must use YYYY-MM-DD.`);
  }
}

export function loadPersonalRegistrationProfile(path: string | undefined): PersonalRegistrationProfile {
  if (!path) throw new Error('PERSONAL_REGISTRATION_PROFILE_PATH is required.');
  const absolutePath = resolve(process.cwd(), path);
  const workspaceRelativePath = relative(process.cwd(), absolutePath);
  if (workspaceRelativePath.startsWith('..') || workspaceRelativePath === '') {
    throw new Error('Personal registration profile must be a file inside the workspace.');
  }
  if (!existsSync(absolutePath)) {
    throw new Error('Sandbox personal registration profile file is missing.');
  }

  const input = JSON.parse(readFileSync(absolutePath, 'utf8')) as Record<string, unknown>;
  if (input.schemaVersion !== 1 || input.sandboxOnly !== true) {
    throw new Error('Personal registration profile must be schemaVersion 1 and sandboxOnly.');
  }

  const profile = { ...input } as unknown as PersonalRegistrationProfile;
  for (const field of [
    'firstName',
    'lastName',
    'idType',
    'idNumberPrefix',
    'idIssueDate',
    'idExpiryDate',
    'dateOfBirth',
    'placeOfBirth',
    'gender',
    'maritalStatus',
    'citizenship',
    'accountPurpose',
    'sourceOfFunds',
    'sourceOfWealth',
    'occupation',
    'careerStatus',
    'employerName',
    'industryType',
    'careerPosition',
    'annualIncome',
    'anticipatedAssetClass',
    'thirdPartyDeposits',
    'phonePrefix',
    'streetAddress',
    'detailedAddress',
    'city',
    'stateRegion',
    'postalCode',
    'country',
    'taxNumberPrefix'
  ] as const) {
    profile[field] = requiredString(profile[field], field);
  }
  assertDate(profile.idIssueDate, 'idIssueDate');
  assertDate(profile.idExpiryDate, 'idExpiryDate');
  assertDate(profile.dateOfBirth, 'dateOfBirth');
  return profile;
}

export function uniqueSyntheticIdentity(prefix: string, phone: string): string {
  const safePrefix = prefix.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const suffix = phone.replace(/\D/g, '').slice(-6);
  const value = `${safePrefix}${suffix}`;
  if (!value || value.length > 24) {
    throw new Error('Synthetic Sandbox identity must be 1-24 uppercase letters or numbers.');
  }
  return value;
}
