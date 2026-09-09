import 'dotenv/config';

type WebSystemEnv = {
  baseUrl?: string;
  username?: string;
  password?: string;
  otp?: string;
  securityKey?: string;
};

type AccountOpeningEnv = {
  testEmail?: string;
  signerName?: string;
  signatureText?: string;
  initials?: string;
};

type PersonalRegistrationEnv = {
  email?: string;
  otp?: string;
  dataPoolPath: string;
  profilePath?: string;
  addressProofPath: string;
  sequencePath: string;
  generatedEmailDomain?: string;
  generatedPhonePrefix?: string;
  adminApprovalSourceRunId?: string;
  signatureText: string;
  testTitle: string;
};

type CorporateRegistrationEnv = {
  email?: string;
  phone?: string;
  companyName?: string;
  profilePath?: string;
  startNewJourney: boolean;
};

type ExchangeEnv = {
  allowMoneyTests: boolean;
  sourceAccountType?: string;
  targetAccountType?: string;
  fromCurrency?: string;
  toCurrency?: string;
  testAmount?: string;
  reconciliationReceivedAmount?: string;
  reconciliationExecutedFrom?: string;
  reconciliationExecutedTo?: string;
};

type TransferEnv = {
  brokerAccountId?: string;
  brokerName?: string;
  sourceAccountType?: string;
  targetAccountType?: string;
  currency?: string;
  testAmount?: string;
  uniqueAmountBase?: string;
  amountPrecision: number;
  matchWindowMs: number;
  adminUserIdentity?: string;
  dryRunDirection?: string;
  dryRunAmount?: string;
  dryRunClientStatus?: string;
  dryRunAdminStatus?: string;
  reconciliationRecordType?: string;
  reconciliationSourceAccount?: string;
  reconciliationTargetAccount?: string;
  reconciliationCurrency?: string;
  reconciliationAmount?: string;
  reconciliationFee?: string;
  reconciliationNetAmount?: string;
  reconciliationStatus?: string;
  reconciliationSourceBalanceBefore?: string;
  purpose?: string;
};

type DepositEnv = {
  accountType?: string;
  currency?: string;
  currencyLabel?: string;
  testAmount?: string;
  exactAmount?: string;
  uniqueAmountBase?: string;
  amountPrecision: number;
  matchWindowMs: number;
  adminUserIdentity?: string;
  channel?: string;
  purpose?: string;
  sourceOfFunds?: string;
  transferMethod: string;
  supportingDocumentPath: string;
  reconciliationAmount?: string;
  reconciliationAccountType?: string;
  reconciliationCurrency?: string;
  reconciliationCurrencyLabel?: string;
  reconciliationClientStatus?: string;
  reconciliationAdminStatus?: string;
  reconciliationSubmittedAt?: string;
};

type WithdrawalEnv = {
  accountType?: string;
  currency?: string;
  currencyLabel?: string;
  beneficiaryName?: string;
  beneficiaryAccountSuffix?: string;
  purpose?: string;
  transferMethod?: string;
  supportingDocumentPath: string;
  testAmount?: string;
  uniqueAmountBase?: string;
  amountPrecision: number;
  matchWindowMs: number;
  adminUserIdentity?: string;
  paymentChannel?: string;
  paymentBank?: string;
  approvalNote?: string;
  approvalDryRunAccountType?: string;
  approvalDryRunCurrency?: string;
  approvalDryRunAmount?: string;
  approvalDryRunBeneficiary?: string;
  approvalDryRunPurpose?: string;
  approvalDryRunSubmittedAt?: string;
  reconciliationAmount?: string;
  reconciliationAccountType?: string;
  reconciliationCurrency?: string;
  reconciliationBeneficiaryName?: string;
  reconciliationBeneficiarySuffix?: string;
  reconciliationClientStatus?: string;
  reconciliationAdminStatus?: string;
  reconciliationSubmittedAt?: string;
};

type AutomationEnv = {
  client: WebSystemEnv;
  admin: WebSystemEnv;
  accountOpening: AccountOpeningEnv;
  personalRegistration: PersonalRegistrationEnv;
  corporateRegistration: CorporateRegistrationEnv;
  exchange: ExchangeEnv;
  transfer: TransferEnv;
  deposit: DepositEnv;
  withdrawal: WithdrawalEnv;
  flowResultPath?: string;
  allowClientMutationTests: boolean;
  allowAdminMutationTests: boolean;
  testTimeoutMs: number;
  expectTimeoutMs: number;
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
};

function readBoolean(name: string, fallback: boolean): boolean {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  if (rawValue !== 'true' && rawValue !== 'false') {
    throw new Error(`${name} must be either true or false.`);
  }

  return rawValue === 'true';
}

function readNumber(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, received: ${rawValue}`);
  }

  return value;
}

function readOptionalUrl(name: string): string | undefined {
  const rawValue = process.env[name];

  if (!rawValue) {
    return undefined;
  }

  try {
    return new URL(rawValue).toString().replace(/\/$/, '');
  } catch {
    throw new Error(`${name} must be a valid absolute URL, received: ${rawValue}`);
  }
}

export const env: AutomationEnv = {
  flowResultPath: process.env.FLOW_EXECUTION_RESULT_PATH,
  client: {
    baseUrl: readOptionalUrl('CLIENT_BASE_URL'),
    username: process.env.CLIENT_USERNAME,
    password: process.env.CLIENT_PASSWORD,
    otp: process.env.CLIENT_OTP,
    securityKey: process.env.CLIENT_SECURITY_KEY
  },
  admin: {
    baseUrl: readOptionalUrl('ADMIN_BASE_URL'),
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
    otp: process.env.ADMIN_OTP
  },
  accountOpening: {
    testEmail: process.env.OPENING_TEST_EMAIL,
    signerName: process.env.OPENING_SIGNER_NAME,
    signatureText: process.env.OPENING_SIGNATURE_TEXT,
    initials: process.env.OPENING_INITIALS
  },
  personalRegistration: {
    email: process.env.PERSONAL_REGISTRATION_EMAIL,
    otp: process.env.CLIENT_REGISTER_OTP,
    dataPoolPath:
      process.env.PERSONAL_REGISTRATION_DATA_POOL_PATH ??
      'test-data/personal-registration-pool.local.json',
    profilePath: process.env.PERSONAL_REGISTRATION_PROFILE_PATH,
    addressProofPath:
      process.env.PERSONAL_REGISTRATION_ADDRESS_PROOF_PATH ??
      'test-assets/personal-registration/address-proof_SANDBOX.png',
    sequencePath:
      process.env.PERSONAL_REGISTRATION_SEQUENCE_PATH ??
      'test-data/registration-sequence.json',
    generatedEmailDomain: process.env.PERSONAL_REGISTRATION_GENERATED_EMAIL_DOMAIN,
    generatedPhonePrefix: process.env.PERSONAL_REGISTRATION_GENERATED_PHONE_PREFIX,
    adminApprovalSourceRunId: process.env.REGISTRATION_APPROVAL_SOURCE_RUN_ID,
    signatureText: process.env.REGISTRATION_SIGNATURE_TEXT ?? 'TEST',
    testTitle: process.env.REGISTRATION_TEST_TITLE ?? 'TEST'
  },
  corporateRegistration: {
    email: process.env.CORPORATE_REGISTRATION_EMAIL,
    phone: process.env.CORPORATE_REGISTRATION_PHONE,
    companyName: process.env.CORPORATE_REGISTRATION_COMPANY_NAME,
    profilePath: process.env.CORPORATE_REGISTRATION_PROFILE_PATH,
    startNewJourney: readBoolean('CORPORATE_REGISTRATION_START_NEW', false)
  },
  exchange: {
    allowMoneyTests: readBoolean('ALLOW_MONEY_TESTS', false),
    sourceAccountType: process.env.EXCHANGE_SOURCE_ACCOUNT_TYPE,
    targetAccountType: process.env.EXCHANGE_TARGET_ACCOUNT_TYPE,
    fromCurrency: process.env.EXCHANGE_FROM_CURRENCY,
    toCurrency: process.env.EXCHANGE_TO_CURRENCY,
    testAmount: process.env.EXCHANGE_TEST_AMOUNT,
    reconciliationReceivedAmount: process.env.EXCHANGE_RECONCILIATION_RECEIVED_AMOUNT,
    reconciliationExecutedFrom: process.env.EXCHANGE_RECONCILIATION_EXECUTED_FROM,
    reconciliationExecutedTo: process.env.EXCHANGE_RECONCILIATION_EXECUTED_TO
  },
  transfer: {
    brokerAccountId: process.env.TRANSFER_BROKER_ACCOUNT_ID,
    brokerName: process.env.TRANSFER_BROKER_NAME,
    sourceAccountType: process.env.TRANSFER_SOURCE_ACCOUNT_TYPE,
    targetAccountType: process.env.TRANSFER_TARGET_ACCOUNT_TYPE,
    currency: process.env.TRANSFER_CURRENCY,
    testAmount: process.env.TRANSFER_TEST_AMOUNT,
    uniqueAmountBase: process.env.TRANSFER_UNIQUE_AMOUNT_BASE,
    amountPrecision: readNumber('TRANSFER_AMOUNT_PRECISION', 2),
    matchWindowMs: readNumber('TRANSFER_MATCH_WINDOW_MS', 300_000),
    adminUserIdentity: process.env.TRANSFER_ADMIN_USER_IDENTITY,
    dryRunDirection: process.env.TRANSFER_DRY_RUN_DIRECTION,
    dryRunAmount: process.env.TRANSFER_DRY_RUN_AMOUNT,
    dryRunClientStatus: process.env.TRANSFER_DRY_RUN_CLIENT_STATUS,
    dryRunAdminStatus: process.env.TRANSFER_DRY_RUN_ADMIN_STATUS,
    reconciliationRecordType: process.env.TRANSFER_RECONCILIATION_RECORD_TYPE,
    reconciliationSourceAccount: process.env.TRANSFER_RECONCILIATION_SOURCE_ACCOUNT,
    reconciliationTargetAccount: process.env.TRANSFER_RECONCILIATION_TARGET_ACCOUNT,
    reconciliationCurrency: process.env.TRANSFER_RECONCILIATION_CURRENCY,
    reconciliationAmount: process.env.TRANSFER_RECONCILIATION_AMOUNT,
    reconciliationFee: process.env.TRANSFER_RECONCILIATION_FEE,
    reconciliationNetAmount: process.env.TRANSFER_RECONCILIATION_NET_AMOUNT,
    reconciliationStatus: process.env.TRANSFER_RECONCILIATION_STATUS,
    reconciliationSourceBalanceBefore:
      process.env.TRANSFER_RECONCILIATION_SOURCE_BALANCE_BEFORE,
    purpose: process.env.TRANSFER_PURPOSE
  },
  deposit: {
    accountType: process.env.DEPOSIT_ACCOUNT_TYPE,
    currency: process.env.DEPOSIT_CURRENCY,
    currencyLabel: process.env.DEPOSIT_CURRENCY_LABEL,
    testAmount: process.env.DEPOSIT_TEST_AMOUNT,
    exactAmount: process.env.DEPOSIT_EXACT_AMOUNT,
    uniqueAmountBase: process.env.DEPOSIT_UNIQUE_AMOUNT_BASE,
    amountPrecision: readNumber('DEPOSIT_AMOUNT_PRECISION', 2),
    matchWindowMs: readNumber('DEPOSIT_MATCH_WINDOW_MS', 300_000),
    adminUserIdentity: process.env.DEPOSIT_ADMIN_USER_IDENTITY,
    channel: process.env.DEPOSIT_CHANNEL,
    purpose: process.env.DEPOSIT_PURPOSE,
    sourceOfFunds: process.env.DEPOSIT_SOURCE_OF_FUNDS,
    transferMethod: process.env.DEPOSIT_TRANSFER_METHOD ?? 'SWIFT',
    supportingDocumentPath:
      process.env.DEPOSIT_SUPPORTING_DOCUMENT_PATH ??
      'test-assets/withdrawal/client-supporting-document_SANDBOX.png',
    reconciliationAmount: process.env.DEPOSIT_RECONCILIATION_AMOUNT,
    reconciliationAccountType: process.env.DEPOSIT_RECONCILIATION_ACCOUNT_TYPE,
    reconciliationCurrency: process.env.DEPOSIT_RECONCILIATION_CURRENCY,
    reconciliationCurrencyLabel: process.env.DEPOSIT_RECONCILIATION_CURRENCY_LABEL,
    reconciliationClientStatus: process.env.DEPOSIT_RECONCILIATION_CLIENT_STATUS,
    reconciliationAdminStatus: process.env.DEPOSIT_RECONCILIATION_ADMIN_STATUS,
    reconciliationSubmittedAt: process.env.DEPOSIT_RECONCILIATION_SUBMITTED_AT
  },
  withdrawal: {
    accountType: process.env.WITHDRAWAL_ACCOUNT_TYPE,
    currency: process.env.WITHDRAWAL_CURRENCY,
    currencyLabel: process.env.WITHDRAWAL_CURRENCY_LABEL,
    beneficiaryName: process.env.WITHDRAWAL_BENEFICIARY_NAME,
    beneficiaryAccountSuffix: process.env.WITHDRAWAL_BENEFICIARY_ACCOUNT_SUFFIX,
    purpose: process.env.WITHDRAWAL_PURPOSE,
    transferMethod: process.env.WITHDRAWAL_TRANSFER_METHOD ?? 'SWIFT',
    supportingDocumentPath:
      process.env.WITHDRAWAL_SUPPORTING_DOCUMENT_PATH ??
      'test-assets/withdrawal/client-supporting-document_SANDBOX.png',
    testAmount: process.env.WITHDRAWAL_TEST_AMOUNT,
    uniqueAmountBase: process.env.WITHDRAWAL_UNIQUE_AMOUNT_BASE,
    amountPrecision: readNumber('WITHDRAWAL_AMOUNT_PRECISION', 2),
    matchWindowMs: readNumber('WITHDRAWAL_MATCH_WINDOW_MS', 300_000),
    adminUserIdentity:
      process.env.WITHDRAWAL_ADMIN_USER_IDENTITY ??
      process.env.CLIENT_USERNAME ??
      process.env.DEPOSIT_ADMIN_USER_IDENTITY,
    paymentChannel: process.env.WITHDRAWAL_PAYMENT_CHANNEL,
    paymentBank: process.env.WITHDRAWAL_PAYMENT_BANK,
    approvalNote: process.env.WITHDRAWAL_APPROVAL_NOTE,
    approvalDryRunAccountType: process.env.WITHDRAWAL_APPROVAL_DRY_RUN_ACCOUNT_TYPE,
    approvalDryRunCurrency: process.env.WITHDRAWAL_APPROVAL_DRY_RUN_CURRENCY,
    approvalDryRunAmount: process.env.WITHDRAWAL_APPROVAL_DRY_RUN_AMOUNT,
    approvalDryRunBeneficiary: process.env.WITHDRAWAL_APPROVAL_DRY_RUN_BENEFICIARY,
    approvalDryRunPurpose: process.env.WITHDRAWAL_APPROVAL_DRY_RUN_PURPOSE,
    approvalDryRunSubmittedAt: process.env.WITHDRAWAL_APPROVAL_DRY_RUN_SUBMITTED_AT,
    reconciliationAmount: process.env.WITHDRAWAL_RECONCILIATION_AMOUNT,
    reconciliationAccountType: process.env.WITHDRAWAL_RECONCILIATION_ACCOUNT_TYPE,
    reconciliationCurrency: process.env.WITHDRAWAL_RECONCILIATION_CURRENCY,
    reconciliationBeneficiaryName:
      process.env.WITHDRAWAL_RECONCILIATION_BENEFICIARY_NAME,
    reconciliationBeneficiarySuffix:
      process.env.WITHDRAWAL_RECONCILIATION_BENEFICIARY_SUFFIX,
    reconciliationClientStatus: process.env.WITHDRAWAL_RECONCILIATION_CLIENT_STATUS,
    reconciliationAdminStatus: process.env.WITHDRAWAL_RECONCILIATION_ADMIN_STATUS,
    reconciliationSubmittedAt: process.env.WITHDRAWAL_RECONCILIATION_SUBMITTED_AT
  },
  allowClientMutationTests: readBoolean('ALLOW_CLIENT_MUTATION_TESTS', false),
  allowAdminMutationTests: readBoolean('ALLOW_ADMIN_MUTATION_TESTS', false),
  testTimeoutMs: readNumber('TEST_TIMEOUT_MS', 60_000),
  expectTimeoutMs: readNumber('EXPECT_TIMEOUT_MS', 10_000),
  actionTimeoutMs: readNumber('ACTION_TIMEOUT_MS', 15_000),
  navigationTimeoutMs: readNumber('NAVIGATION_TIMEOUT_MS', 30_000)
};
