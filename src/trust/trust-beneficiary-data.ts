import { toAlphabeticSuffix } from '../registration/registration-sequence';

export type TrustBeneficiaryTestData = {
  name: string;
  relationship: string;
  idType: string;
  idNumber: string;
  percentage: string;
  phonePrefix: string;
  phone: string;
  email: string;
  address: string;
  bank: {
    accountType: string;
    accountHolder: string;
    bankName: string;
    accountNumber: string;
    country: string;
    currency: string;
    swiftCode: string;
    bankAddress: string;
    stateProvince: string;
    city: string;
    postalCode: string;
  };
};

export function buildTrustBeneficiaryTestData(runId: string): TrustBeneficiaryTestData {
  const trailing = Number(runId.match(/(\d{1,4})$/)?.[1] ?? '1');
  const sequence = Math.max(1, (trailing % 676) || 676);
  const suffix = toAlphabeticSuffix(sequence);
  const digits = String(sequence).padStart(6, '0');
  return {
    name: `TEST BENEFICIARY ${suffix}`,
    relationship: '其他',
    idType: '护照',
    idNumber: `SBOXTB${digits}`,
    percentage: '10',
    phonePrefix: '+852',
    phone: `55${digits}`,
    email: `trust.beneficiary.${runId.toLowerCase().replace(/[^a-z0-9]/g, '.')}@sandbox.fidere.test`,
    address: 'FIDERE SANDBOX BENEFICIARY ADDRESS',
    bank: {
      accountType: '储蓄账户',
      accountHolder: `TEST BENEFICIARY ${suffix}`,
      bankName: `FIDERE SANDBOX BENEFICIARY BANK ${suffix}`,
      accountNumber: `990000${digits}`,
      country: '中国香港特别行政区',
      currency: 'USD',
      swiftCode: 'SBOXHKHH',
      bankAddress: 'FIDERE SANDBOX BENEFICIARY BANK ADDRESS',
      stateProvince: 'HONG KONG',
      city: 'HONG KONG',
      postalCode: '000000'
    }
  };
}
