import { env } from '../src/config/env';
import { PersonalRegistrationDataPool } from '../src/registration/personal-registration-data';

const pool = new PersonalRegistrationDataPool(env.personalRegistration.dataPoolPath);
const updated = pool.scrubLegacyCredentials();

console.log(JSON.stringify({ updated }));
