import type { JourneyStepId } from '../../config/journey-registry';
import { resolve } from 'node:path';
import {
  PersonalJourneyContextStore,
  RegistrationAdminApprovalJourneyStore,
  registrationStageAtLeast
} from '../registration';
import { readFlowExecutionResult } from '../flow-engine';
import { FreshUserBalanceBootstrapStore } from './fresh-user-balance-bootstrap';
import type { JourneyStepAdapter } from './fresh-user-journey-engine';
import { runRegisteredFlow } from './registered-flow-runner';
import { REGISTRATION_KYC } from '../registration/registration-kyc-contract';

export type FreshUserJourneyAdapterRuntime = {
  headed: boolean;
  liveMonitorUrl?: string;
  liveRunId?: string;
};

export function createFreshUserJourneyAdapters(
  runtime: FreshUserJourneyAdapterRuntime
): Partial<Record<JourneyStepId, JourneyStepAdapter>> {
  return {
    'J-001': async ({ context, definition }) => {
      const store = new PersonalJourneyContextStore();
      const existingIds = new Set(store.list().map(candidate => candidate.runId));
      const originalRunId = context.references.registrationRunId;
      const previousApprovalCount = originalRunId
        ? new RegistrationAdminApprovalJourneyStore('personal', originalRunId).load()?.approvalAttempts?.length ?? 0 : 0;
      const exitCode = await runRegisteredFlow(definition.flowId, {
        headed: runtime.headed,
        liveMonitorUrl: runtime.liveMonitorUrl,
        liveRunId: runtime.liveRunId,
        environment: {
          ALLOW_CLIENT_MUTATION_TESTS: 'true',
          ALLOW_ADMIN_MUTATION_TESTS: process.env.ALLOW_ADMIN_MUTATION_TESTS ?? 'false',
          REGISTRATION_APPROVAL_SOURCE_RUN_ID: originalRunId ?? '',
          PERSONAL_REGISTRATION_EMAIL: ''
        }
      });
      const created = store.list().filter(candidate => !existingIds.has(candidate.runId));
      const original = originalRunId ? store.load(originalRunId) : undefined;
      if ((originalRunId && (!original || created.length !== 0)) || (!originalRunId && created.length !== 1)) {
        return {
          disposition: 'FAIL',
          reason: `REG-P-002 produced ${created.length} new Journey Contexts; exactly one was required.`,
          mutationPerformed: created.some(candidate => registrationStageAtLeast(candidate.stage, 'USER_REGISTERED')),
          unknownMutationState: created.length > 1
        };
      }
      const registration = original ?? created[0];
      const accountCreated = registrationStageAtLeast(registration.stage, 'USER_REGISTERED');
      const approval = new RegistrationAdminApprovalJourneyStore('personal', registration.runId).load();
      const mutatedThisRun = (!original && accountCreated) || (approval?.approvalAttempts?.length ?? 0) > previousApprovalCount;
      if (exitCode !== 0 || registration.stage !== 'COMPLETED') {
        return {
          disposition: 'FAIL',
          reason: `REG-P-002 exitCode=${exitCode}; persisted stage=${registration.stage}. Resume the same account.`,
          mutationPerformed: mutatedThisRun,
          user: {
            accountType: 'PERSONAL',
            displayName: registration.displayName,
            email: registration.email,
            phone: registration.phone,
            userId: registration.userId,
            kycStatus: registration.clientStatus
          },
          references: { registrationRunId: registration.runId }
        };
      }
      return {
        disposition: 'PASS',
        mutationPerformed: mutatedThisRun,
        user: {
          accountType: 'PERSONAL',
          displayName: registration.displayName,
          email: registration.email,
          phone: registration.phone,
          userId: registration.userId,
          kycStatus: registration.clientStatus
        },
        references: { registrationRunId: registration.runId }
      };
    },
    'J-002': async ({ context, definition }) => {
      const sourceRunId = context.references.registrationRunId;
      if (!sourceRunId) {
        return {
          disposition: 'FAIL',
          reason: 'Admin KYC adapter requires the registration runId from J-001.',
          mutationPerformed: false
        };
      }
      const accountType = context.user.accountType ?? 'PERSONAL';
      const config = REGISTRATION_KYC[accountType];
      const store = new RegistrationAdminApprovalJourneyStore(config.storageType, sourceRunId);
      const existing = store.load();
      if (existing?.stage === 'COMPLETED' && existing.kycStage === 'CLIENT_KYC_APPROVED' && existing.kycVerifiedAt &&
          existing.email === context.user.email) {
        return {
          disposition: 'PASS',
          reason: 'The same Journey account has explicit Admin and clean-login Client KYC approval evidence; no duplicate action.',
          mutationPerformed: false,
          user: { kycStatus: existing.clientFinalState ?? 'Approved' }
        };
      }
      const exitCode = await runRegisteredFlow(config.flowId, {
        headed: runtime.headed,
        liveMonitorUrl: runtime.liveMonitorUrl,
        liveRunId: runtime.liveRunId,
        environment: {
          ALLOW_ADMIN_MUTATION_TESTS: process.env.ALLOW_ADMIN_MUTATION_TESTS ?? 'false',
          REGISTRATION_APPROVAL_SOURCE_RUN_ID: sourceRunId
        }
      });
      const result = store.load();
      if (exitCode === 0 && result?.stage === 'COMPLETED' && result.kycStage === 'CLIENT_KYC_APPROVED' && result.kycVerifiedAt) {
        return {
          disposition: 'PASS',
          mutationPerformed: (result.approvalAttempts?.length ?? 0) > (existing?.approvalAttempts?.length ?? 0),
          user: { kycStatus: result.clientFinalState ?? result.adminFinalState ?? 'Approved' }
        };
      }
      if (result?.approvalAttempts?.some(attempt => !attempt.confirmedAt) ||
          (result?.stage === 'ADMIN_APPROVAL_ATTEMPTED' && !result.approvalAttempts?.length)) {
        return {
          disposition: 'MANUAL_REVIEW',
          reason: 'Admin Approve was attempted but the KYC terminal state is not known; resume this sourceRunId.',
          mutationPerformed: true,
          unknownMutationState: true
        };
      }
      return {
        disposition: 'FAIL',
        reason: `REG-P-003 exitCode=${exitCode}; target stage=${result?.stage ?? 'missing'}.`,
        mutationPerformed: false
      };
    },
    'J-003': async ({ context, definition }) => {
      const userEmail = context.user.email;
      const amount = process.env.JOURNEY_INITIAL_USD_BALANCE?.trim();
      if (!userEmail || !amount) {
        return {
          disposition: 'FAIL',
          reason: 'Fresh Balance Bootstrap requires Journey user email and JOURNEY_INITIAL_USD_BALANCE.',
          mutationPerformed: false
        };
      }
      const store = new FreshUserBalanceBootstrapStore();
      let state = store.prepare({ journeyId: context.journeyId, userEmail, bootstrapAmount: amount });
      const resultPath = store.resultPathFor(context.journeyId);
      const existingResult = readFlowExecutionResult(resultPath);
      if (
        state.stage !== 'BOOTSTRAP_COMPLETED' &&
        existingResult?.stage === 'COMPLETED' &&
        existingResult.reference &&
        existingResult.balanceBefore &&
        existingResult.balanceAfter
      ) {
        state = store.recordCompleted(state, {
          depositTxn: existingResult.reference,
          balanceBefore: existingResult.balanceBefore,
          balanceAfter: existingResult.balanceAfter
        });
      } else if (state.stage === 'PREPARED' && existingResult?.stage === 'CLIENT_CREATED') {
        state = store.recordSubmitted(state, {
          depositTxn: existingResult.reference,
          balanceBefore: existingResult.balanceBefore
        });
      }
      if (state.stage === 'BOOTSTRAP_COMPLETED') {
        return {
          disposition: 'PASS',
          reason: 'Fresh User Balance Bootstrap was already completed; duplicate credit was blocked.',
          mutationPerformed: false,
          account: { hongKongUsdBalance: state.balanceAfter },
          references: { bootstrapDepositTxn: state.depositTxn }
        };
      }
      if (state.stage === 'BOOTSTRAP_SUBMITTED') {
        return {
          disposition: 'MANUAL_REVIEW',
          reason: 'Bootstrap Deposit already exists and must be resumed by its original reference; duplicate credit is blocked.',
          mutationPerformed: true,
          unknownMutationState: false,
          account: { hongKongUsdBalance: state.balanceAfter },
          references: { bootstrapDepositTxn: state.depositTxn }
        };
      }
      const exitCode = await runRegisteredFlow(definition.flowId, {
        headed: runtime.headed,
        liveMonitorUrl: runtime.liveMonitorUrl,
        liveRunId: runtime.liveRunId,
        environment: {
          CLIENT_USERNAME: userEmail,
          DEPOSIT_ADMIN_USER_IDENTITY: userEmail,
          DEPOSIT_EXACT_AMOUNT: amount,
          DEPOSIT_TEST_AMOUNT: amount,
          FLOW_EXECUTION_RESULT_PATH: resultPath,
          ALLOW_MONEY_TESTS: 'true',
          ALLOW_ADMIN_MUTATION_TESTS: 'true'
        }
      });
      const result = readFlowExecutionResult(resultPath);
      if (result?.stage === 'COMPLETED' && result.reference && result.balanceBefore && result.balanceAfter) {
        state = store.recordCompleted(state, {
          depositTxn: result.reference,
          balanceBefore: result.balanceBefore,
          balanceAfter: result.balanceAfter
        });
        return {
          disposition: 'PASS',
          mutationPerformed: true,
          account: { hongKongUsdBalance: state.balanceAfter },
          references: { bootstrapDepositTxn: state.depositTxn }
        };
      }
      if (result?.stage === 'CLIENT_CREATED') {
        state = store.recordSubmitted(state, {
          depositTxn: result.reference,
          balanceBefore: result.balanceBefore
        });
        return {
          disposition: 'MANUAL_REVIEW',
          reason: 'Bootstrap Client Deposit exists but the Admin claim/final balance is incomplete; resume the same TXN.',
          mutationPerformed: true,
          unknownMutationState: false,
          references: { bootstrapDepositTxn: state.depositTxn }
        };
      }
      return {
        disposition: 'FAIL',
        reason: `Fresh Balance Bootstrap exitCode=${exitCode}; no Client Deposit was created.`,
        mutationPerformed: false
      };
    },
    'J-006': async ({ context, definition }) => {
      const userEmail = context.user.email;
      if (!userEmail) {
        return {
          disposition: 'FAIL',
          reason: 'Deposit Fresh adapter requires the Journey user email.',
          mutationPerformed: false
        };
      }
      const resultPath = resolve(
        '.journey-context/fresh-user/flow-results',
        `${context.journeyId}.deposit.json`
      );
      const existing = readFlowExecutionResult(resultPath);
      if (existing?.stage === 'COMPLETED') {
        return {
          disposition: 'PASS',
          reason: 'Journey Deposit already completed; duplicate submission was blocked.',
          mutationPerformed: false,
          account: { hongKongUsdBalance: existing.balanceAfter },
          references: { depositTxn: existing.reference }
        };
      }
      if (existing?.stage === 'CLIENT_CREATED') {
        return {
          disposition: 'MANUAL_REVIEW',
          reason: 'Journey Deposit already has a Client TXN; resume that TXN instead of submitting again.',
          mutationPerformed: true,
          references: { depositTxn: existing.reference }
        };
      }
      const exitCode = await runRegisteredFlow(definition.flowId, {
        headed: runtime.headed,
        liveMonitorUrl: runtime.liveMonitorUrl,
        liveRunId: runtime.liveRunId,
        environment: {
          CLIENT_USERNAME: userEmail,
          DEPOSIT_ADMIN_USER_IDENTITY: userEmail,
          DEPOSIT_EXACT_AMOUNT: '',
          FLOW_EXECUTION_RESULT_PATH: resultPath,
          ALLOW_MONEY_TESTS: 'true',
          ALLOW_ADMIN_MUTATION_TESTS: 'true'
        }
      });
      const result = readFlowExecutionResult(resultPath);
      if (result?.stage === 'COMPLETED') {
        return {
          disposition: 'PASS',
          mutationPerformed: true,
          account: { hongKongUsdBalance: result.balanceAfter },
          references: { depositTxn: result.reference }
        };
      }
      if (result?.stage === 'CLIENT_CREATED') {
        return {
          disposition: 'MANUAL_REVIEW',
          reason: 'Deposit Client TXN exists but the Admin/final balance result is incomplete.',
          mutationPerformed: true,
          references: { depositTxn: result.reference }
        };
      }
      return {
        disposition: 'FAIL',
        reason: `Deposit Fresh Happy Path exitCode=${exitCode}; no Client TXN was created.`,
        mutationPerformed: false
      };
    }
  };
}
