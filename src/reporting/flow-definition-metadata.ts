import {
  getFlowDefinition,
  type FlowDefinition
} from '../../config/flow-registry';
import type { BusinessCaseMetadata } from './business-report.types';

export type FlowCaseOverrides = Partial<BusinessCaseMetadata>;

export function metadataFromFlowDefinition(
  definition: FlowDefinition,
  overrides: FlowCaseOverrides = {}
): BusinessCaseMetadata {
  return {
    caseId: definition.caseId ?? definition.id,
    module: definition.module,
    name: definition.name,
    description: definition.description,
    priority: definition.priority,
    level: definition.level,
    type: definition.type.split('/').map(value => value.trim()).filter(Boolean),
    scope: definition.scope.replace('Client+Admin', 'Client + Admin'),
    preconditions: [],
    expectedResult: definition.primaryOracles.length > 0
      ? definition.primaryOracles.join('；')
      : definition.description,
    changesData: definition.changesData,
    affectsMoney: definition.affectsMoney,
    dependsOnAdmin: definition.requiresAdmin,
    dependsOnThirdParty: definition.requiresThirdParty,
    safetySwitches: [...definition.safetySwitches],
    ...overrides,
    flowId: definition.id
  };
}

export function metadataForFlow(
  flowId: string,
  overrides: FlowCaseOverrides = {}
): BusinessCaseMetadata {
  return metadataFromFlowDefinition(getFlowDefinition(flowId), overrides);
}
