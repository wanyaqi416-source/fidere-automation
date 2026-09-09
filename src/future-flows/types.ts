import {
  getFlowDefinition,
  type FlowDefinition
} from '../../config/flow-registry';

export type FutureFlowSkeleton = {
  definition: FlowDefinition;
  validationScenarios: readonly string[];
  dryRunStages: readonly string[];
  testDataRequirements: readonly string[];
};

export function defineFutureFlowSkeleton(input: {
  flowId: string;
  validationScenarios: readonly string[];
  dryRunStages: readonly string[];
  testDataRequirements: readonly string[];
}): FutureFlowSkeleton {
  const definition = getFlowDefinition(input.flowId);
  if (definition.status === 'Ready' || definition.npmScript) {
    throw new Error(`Future Flow skeleton ${input.flowId} must not be executable.`);
  }
  return { definition, ...input };
}

