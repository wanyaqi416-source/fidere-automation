export const FLOW_ERROR_DISPOSITIONS = [
  'RECOVERABLE_PRE_SUBMIT',
  'HARD_STOP'
] as const;

export type FlowErrorDisposition = (typeof FLOW_ERROR_DISPOSITIONS)[number];

export type PreSubmitMutationState = {
  clientFinalSubmissionOccurred: boolean;
  securityKeyVerified: boolean;
  adminMutationOccurred: boolean;
  businessOrderCreated: boolean;
};

export type RecoverPreSubmitInput = {
  id: string;
  mutationState: PreSubmitMutationState;
  needsCorrection: () => boolean | Promise<boolean>;
  correct: () => void | Promise<void>;
  verify: () => boolean | Promise<boolean>;
};

export type RecoverPreSubmitResult = {
  disposition: 'RECOVERABLE_PRE_SUBMIT';
  correctionCount: 0 | 1;
  corrected: boolean;
};

export function classifyFlowError(state: PreSubmitMutationState): FlowErrorDisposition {
  return state.clientFinalSubmissionOccurred ||
    state.securityKeyVerified ||
    state.adminMutationOccurred ||
    state.businessOrderCreated
    ? 'HARD_STOP'
    : 'RECOVERABLE_PRE_SUBMIT';
}

export async function recoverPreSubmitOnce(
  input: RecoverPreSubmitInput
): Promise<RecoverPreSubmitResult> {
  if (classifyFlowError(input.mutationState) !== 'RECOVERABLE_PRE_SUBMIT') {
    throw new Error(`${input.id} cannot be corrected after an irreversible mutation boundary.`);
  }
  if (!(await input.needsCorrection())) {
    return {
      disposition: 'RECOVERABLE_PRE_SUBMIT',
      correctionCount: 0,
      corrected: false
    };
  }

  await input.correct();
  if (!(await input.verify())) {
    throw new Error(`${input.id} deterministic pre-submit correction failed verification.`);
  }
  return {
    disposition: 'RECOVERABLE_PRE_SUBMIT',
    correctionCount: 1,
    corrected: true
  };
}
