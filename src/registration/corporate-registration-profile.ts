import type { CorporateRegistrationJourney } from './corporate-registration-journey';

export type CorporateNaturalPersonProfile = {
  nationality: string;
  gender: string;
  lastName: string;
  firstName: string;
  idType: string;
  idNumber: string;
  idIssueDate: string;
  idExpiryDate: string;
  dateOfBirth: string;
  mobile: string;
  email: string;
  residentialAddress: string;
  country: string;
  city: string;
  street: string;
  stateProvince: string;
  postalCode: string;
  mailingAddress: string;
  mailingCountry: string;
  mailingCity: string;
  mailingStreet: string;
  mailingStateProvince: string;
  mailingPostalCode: string;
};

export type CorporateRegistrationProfile = {
  companyName: string;
  registrationNumber: string;
  incorporationDate: string;
  registrationCountry: string;
  registeredStreet: string;
  registeredCity: string;
  registeredState: string;
  registeredPostalCode: string;
  businessNature: string;
  sourceOfAssets: string;
  accountPurpose: string;
  representative: CorporateNaturalPersonProfile;
  naturalDirector: CorporateNaturalPersonProfile;
  legalDirector: {
    companyName: string;
    registrationNumber: string;
    incorporationDate: string;
    registrationCountry: string;
    street: string;
    city: string;
    stateProvince: string;
    postalCode: string;
    mobile: string;
    email: string;
    businessNature: string;
  };
  shareholder: CorporateNaturalPersonProfile;
};

function relatedEmail(role: string, journey: CorporateRegistrationJourney): string {
  return `regc.${role}.${journey.nameSuffix.toLowerCase()}.${journey.runId.slice(-6).toLowerCase()}@sandbox.fidere.test`;
}

function relatedPhone(journey: CorporateRegistrationJourney, offset: number): string {
  const base = Number(journey.phone.slice(-8));
  return `166${String((base + offset) % 100_000_000).padStart(8, '0')}`;
}

function naturalPerson(
  role: string,
  firstName: string,
  lastName: string,
  journey: CorporateRegistrationJourney,
  offset: number
): CorporateNaturalPersonProfile {
  return {
    nationality: '中国香港特别行政区',
    gender: '男',
    lastName,
    firstName,
    idType: '护照',
    idNumber: `SBX${journey.nameSuffix}${String(offset).padStart(2, '0')}`,
    idIssueDate: '2022-01-10',
    idExpiryDate: '2032-01-10',
    dateOfBirth: '1990-01-10',
    mobile: relatedPhone(journey, offset),
    email: relatedEmail(role, journey),
    residentialAddress: `${offset} SANDBOX TEST ADDRESS`,
    country: '中国香港特别行政区',
    city: 'HONG KONG',
    street: `${offset} TEST STREET`,
    stateProvince: 'HONG KONG',
    postalCode: `0000${offset}`,
    mailingAddress: `${offset} SANDBOX MAILING ADDRESS`,
    mailingCountry: '中国香港特别行政区',
    mailingCity: 'HONG KONG',
    mailingStreet: `${offset} TEST MAILING STREET`,
    mailingStateProvince: 'HONG KONG',
    mailingPostalCode: `1000${offset}`
  };
}

export function corporateProfileForJourney(
  journey: CorporateRegistrationJourney
): CorporateRegistrationProfile {
  return {
    companyName: journey.companyName ?? journey.displayName,
    registrationNumber: `SBXREG${journey.nameSuffix}`,
    incorporationDate: '2020-01-10',
    registrationCountry: '中国香港特别行政区',
    registeredStreet: '1 SANDBOX CORPORATE STREET',
    registeredCity: 'HONG KONG',
    registeredState: 'HONG KONG',
    registeredPostalCode: '000001',
    businessNature: '信息技术',
    sourceOfAssets: '营业收入',
    accountPurpose: '作为隔离的独立载体进行商业或投资活动',
    representative: naturalPerson('representative', 'CORP', 'REPRESENTATIVE', journey, 1),
    naturalDirector: naturalPerson('director', 'NATURAL', 'DIRECTOR', journey, 2),
    legalDirector: {
      companyName: `TEST CORPORATE DIRECTOR ${journey.nameSuffix}`,
      registrationNumber: `SBXDIR${journey.nameSuffix}`,
      incorporationDate: '2019-02-10',
      registrationCountry: '中国香港特别行政区',
      street: '2 SANDBOX DIRECTOR STREET',
      city: 'HONG KONG',
      stateProvince: 'HONG KONG',
      postalCode: '000002',
      mobile: relatedPhone(journey, 3),
      email: relatedEmail('legal-director', journey),
      businessNature: '信息技术'
    },
    shareholder: naturalPerson('shareholder', 'NATURAL', 'SHAREHOLDER', journey, 4)
  };
}
