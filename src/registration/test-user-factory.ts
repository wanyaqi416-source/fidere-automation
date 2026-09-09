import {
  PersonalRegistrationDataPool,
  type RegistrationPoolEntry
} from './personal-registration-data';
import { PersonalJourneyContextStore } from './personal-registration-state';
import {
  RegistrationSequenceStore,
  type RegistrationTestName
} from './registration-sequence';

export type FreshPersonalIdentityPreview = Pick<
  RegistrationPoolEntry,
  'id' | 'email' | 'phone' | 'sandboxOnly'
>;

export type FreshPersonalTestIdentity = FreshPersonalIdentityPreview & RegistrationTestName;

export type FreshIdentityGenerationConfig = {
  emailDomain?: string;
  phonePrefix?: string;
};

export class TestUserFactory {
  private readonly pool: PersonalRegistrationDataPool;

  constructor(
    poolPath: string,
    private readonly journeyStore = new PersonalJourneyContextStore(),
    private readonly sequenceStore = new RegistrationSequenceStore(),
    private readonly generation: FreshIdentityGenerationConfig = {
      emailDomain: process.env.PERSONAL_REGISTRATION_GENERATED_EMAIL_DOMAIN,
      phonePrefix: process.env.PERSONAL_REGISTRATION_GENERATED_PHONE_PREFIX
    }
  ) {
    this.pool = new PersonalRegistrationDataPool(poolPath);
  }

  readiness() {
    const pool = this.pool.readiness();
    const canGenerate = this.canGenerateIdentity();
    return {
      ...pool,
      ready: pool.ready || canGenerate,
      canGenerate,
      blockers: pool.ready || canGenerate ? [] : pool.blockers
    };
  }

  previewFreshIdentity(emailOverride?: string): FreshPersonalIdentityPreview | undefined {
    const candidate = this.pool.peekAvailable(emailOverride) ?? this.generateAvailableIdentity(emailOverride);
    if (!candidate) return undefined;
    this.assertJourneyIsFresh(candidate.email);
    return this.identity(candidate);
  }

  reserveFreshIdentity(
    runId: string,
    expectedEntryId: string,
    emailOverride?: string
  ): FreshPersonalTestIdentity {
    const candidate = this.pool.peekAvailable(emailOverride) ?? this.generateAvailableIdentity(emailOverride);
    if (!candidate || candidate.id !== expectedEntryId) {
      throw new Error('The preflighted Sandbox registration identity is no longer available.');
    }
    this.assertJourneyIsFresh(candidate.email);
    const reserved = this.pool.reserve(runId, expectedEntryId, emailOverride);
    return {
      ...this.identity(reserved),
      ...this.sequenceStore.reserveNext(runId)
    };
  }

  markConsumed(runId: string): FreshPersonalIdentityPreview {
    return this.identity(this.pool.markConsumed(runId));
  }

  findByRunId(runId: string): FreshPersonalIdentityPreview | undefined {
    const entry = this.pool.findByRunId(runId);
    return entry ? this.identity(entry) : undefined;
  }

  private assertJourneyIsFresh(email: string): void {
    if (this.journeyStore.findByEmail(email)) {
      throw new Error(
        'The next Sandbox registration identity already has a Journey Context; Fresh execution is forbidden.'
      );
    }
  }

  private canGenerateIdentity(): boolean {
    const domain = this.generation.emailDomain?.trim().toLowerCase();
    const prefix = this.generation.phonePrefix?.replace(/\D/g, '');
    return Boolean(domain && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) && prefix && /^1\d{2,9}$/.test(prefix));
  }

  private generateAvailableIdentity(emailOverride?: string): RegistrationPoolEntry | undefined {
    if (!this.canGenerateIdentity()) return undefined;
    const sequence = this.sequenceStore.nextSequence();
    const suffix = String(sequence).padStart(6, '0');
    const domain = this.generation.emailDomain!.trim().toLowerCase();
    const prefix = this.generation.phonePrefix!.replace(/\D/g, '');
    const remainingDigits = 11 - prefix.length;
    if (remainingDigits < 1 || sequence >= 10 ** remainingDigits) {
      throw new Error('Sandbox registration phone sequence is exhausted for the configured prefix.');
    }
    const entry = this.pool.addAvailable({
      id: `golden-personal-${suffix}`,
      email: `golden-regp-${suffix}@${domain}`,
      phone: `${prefix}${String(sequence).padStart(remainingDigits, '0')}`,
      sandboxOnly: true
    });
    if (!emailOverride) return entry;
    return this.pool.peekAvailable(emailOverride);
  }

  private identity(entry: RegistrationPoolEntry): FreshPersonalIdentityPreview {
    return {
      id: entry.id,
      email: entry.email,
      phone: entry.phone,
      sandboxOnly: entry.sandboxOnly
    };
  }
}
