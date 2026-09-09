import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import {
  FreshUserBalanceBootstrapStore,
  FreshUserJourneyContextStore,
  FreshUserJourneyEngine
} from '../../src/journey';
import {
  PersonalJourneyContextStore,
  RegistrationSequenceStore,
  TestUserFactory
} from '../../src/registration';

test('@platform @readonly @L2 Fresh User Journey context rejects credentials', async ({}, testInfo) => {
  const store = new FreshUserJourneyContextStore(testInfo.outputPath('journey-context'));
  const context = store.create({ journeyId: 'JOURNEY-UNIT-001', runId: 'RUN-UNIT-001' });
  expect(readFileSync(store.pathFor(context.journeyId), 'utf8')).not.toMatch(
    /password|otp|securityKey|cookie|token|authorization/i
  );

  const unsafe = {
    ...context,
    user: { ...context.user, password: 'forbidden' }
  };
  expect(() => store.save(unsafe)).toThrow('forbidden field');
});

test('@platform @readonly @L2 Fresh User Journey skips unavailable optional flows', async ({}, testInfo) => {
  const store = new FreshUserJourneyContextStore(testInfo.outputPath('journey-engine'));
  const initial = store.create({ journeyId: 'JOURNEY-UNIT-002', runId: 'RUN-UNIT-002' });
  const engine = new FreshUserJourneyEngine({
    'J-001': async () => ({
      disposition: 'PASS',
      mutationPerformed: true,
      user: {
        displayName: 'TEST SANDBOX ZZ',
        email: 'unit@sandbox.example.test',
        phone: '15500000000',
        kycStatus: 'Submitted'
      },
      references: { registrationRunId: 'REG-UNIT-001' }
    }),
    'J-002': async () => ({
      disposition: 'PASS',
      mutationPerformed: true,
      user: { kycStatus: 'Approved' }
    }),
    'J-003': async () => ({
      disposition: 'PASS',
      mutationPerformed: true,
      account: { hongKongUsdBalance: '2000' },
      references: { bootstrapDepositTxn: 'TXN-UNIT-001' }
    }),
    'J-006': async () => ({
      disposition: 'PASS',
      mutationPerformed: true,
      account: { hongKongUsdBalance: '2011.23' },
      references: { depositTxn: 'TXN-UNIT-002' }
    })
  }, store);

  const result = await engine.execute(initial);
  expect(result.flows.find(flow => flow.id === 'J-001')?.disposition).toBe('PASS');
  expect(result.flows.find(flow => flow.id === 'J-002')?.disposition).toBe('PASS');
  expect(result.flows.find(flow => flow.id === 'J-003')?.disposition).toBe('PASS');
  expect(result.flows.find(flow => flow.id === 'J-004')).toMatchObject({
    disposition: 'SKIPPED_PREREQUISITE'
  });
  expect(result.flows.find(flow => flow.id === 'J-008')).toMatchObject({
    disposition: 'SKIPPED_NOT_READY'
  });
  expect(result.flows.find(flow => flow.id === 'J-006')?.disposition).toBe('PASS');
  expect(result.totalMutationCount).toBe(4);
  expect(result.stage).toBe('COMPLETED');
});

test('@platform @readonly @L2 Fresh identity generation does not reuse abandoned data', async ({}, testInfo) => {
  const personalStore = new PersonalJourneyContextStore(testInfo.outputPath('personal-contexts'));
  const factory = new TestUserFactory(
    testInfo.outputPath('personal-pool.json'),
    personalStore,
    new RegistrationSequenceStore(testInfo.outputPath('sequence.json')),
    { emailDomain: 'sandbox.example.test', phonePrefix: '15591' }
  );
  expect(factory.readiness()).toMatchObject({ ready: true, availableCount: 0, canGenerate: true });
  const preview = factory.previewFreshIdentity();
  expect(preview).toBeDefined();
  const reserved = factory.reserveFreshIdentity('REGP-UNIT-001', preview!.id);
  expect(reserved.displayName).toBe('TEST SANDBOX AA');
  expect(reserved.phone).toHaveLength(11);
});

test('@platform @readonly @L2 Fresh Balance Bootstrap Resume blocks duplicate credit', async ({}, testInfo) => {
  const store = new FreshUserBalanceBootstrapStore(testInfo.outputPath('bootstrap'));
  let state = store.prepare({
    journeyId: 'JOURNEY-UNIT-003',
    userEmail: 'unit@sandbox.example.test',
    bootstrapAmount: '2000'
  });
  state = store.recordCompleted(state, {
    depositTxn: 'TXN-UNIT-BOOTSTRAP',
    balanceBefore: '0',
    balanceAfter: '2000'
  });
  expect(state.stage).toBe('BOOTSTRAP_COMPLETED');
  expect(store.prepare({
    journeyId: state.journeyId,
    userEmail: state.userEmail,
    bootstrapAmount: state.bootstrapAmount
  }).stage).toBe('BOOTSTRAP_COMPLETED');
});
