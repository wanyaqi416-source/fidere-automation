import { env } from '../src/config/env';
import {
  PersonalJourneyContextStore,
  PersonalRegistrationDataPool
} from '../src/registration';

const pool = new PersonalRegistrationDataPool(env.personalRegistration.dataPoolPath);
const journeys = new PersonalJourneyContextStore();
const releasable = pool.reservedRunIds().filter(runId => !journeys.load(runId));

if (releasable.length !== 1) {
  throw new Error(
    `Expected exactly one unsubmitted registration reservation; received ${releasable.length}.`
  );
}

pool.releaseUnsubmitted(releasable[0]);
process.stdout.write('Released one local pre-account registration reservation.\n');
