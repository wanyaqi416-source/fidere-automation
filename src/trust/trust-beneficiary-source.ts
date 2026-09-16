import { env } from '../config/env';
import { PersonalJourneyContextStore } from '../registration';
import { isValidEmail } from '../utils/runtime-email';
import { trustIdentityHash } from './trust-beneficiary-state';

export type TrustBeneficiarySource = {
  runId: string;
  email: string;
  displayName: string;
};

export function resolveTrustBeneficiarySource(
  expectedRunId?: string,
  expectedUserHash?: string
): TrustBeneficiarySource {
  const email = process.env.TRUST_BENEFICIARY_USER_EMAIL?.trim() || env.client.username?.trim() || '';
  if (!isValidEmail(email)) {
    throw new Error('TRUST_BENEFICIARY_USER_REQUIRED: a valid Client email is required.');
  }

  const journey = new PersonalJourneyContextStore().findByEmail(email);
  if (journey && journey.stage !== 'COMPLETED') {
    throw new Error('Trust Beneficiary requires a completed Personal Client journey.');
  }

  const source = {
    runId: journey?.runId ?? `CLIENT-${trustIdentityHash(email).slice(0, 16)}`,
    email,
    displayName: journey?.displayName ?? 'ENV PERSONAL TEST USER'
  };
  if (expectedRunId && source.runId !== expectedRunId) {
    throw new Error('Resume state does not belong to the configured Client user.');
  }
  if (expectedUserHash && trustIdentityHash(source.email) !== expectedUserHash) {
    throw new Error('Resume state Client identity does not match the configured user.');
  }
  return source;
}
