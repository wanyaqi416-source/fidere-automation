export type FlowStatus = 'Ready' | 'Mutation Ready' | 'In Progress' | 'Pending' | 'Blocked';

export type FlowScope =
  | 'Admin'
  | 'Client'
  | 'Client+Admin'
  | 'Client/Admin'
  | 'Client+Admin+Third Party';

export type TestLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export type RegressionClass =
  | 'Smoke'
  | 'Validation'
  | 'Readonly'
  | 'Dry Run'
  | 'Money'
  | 'External Sandbox'
  | 'None';

export type AdminAction = 'None' | 'Approve' | 'Reject' | 'Claim';

export type FlowBusinessResult = 'Passed' | 'Failed' | 'Not Run' | 'N/A';

export type FlowAutomationResult =
  | 'Passed'
  | 'Passed With Warning'
  | 'Failed'
  | 'Not Run'
  | 'N/A';

export type BusinessOrderPrefix = 'OTC' | 'TXN' | 'TRF' | 'INV';

export type MoneyExecutionProfile = {
  account: string;
  currency: string;
  mutation: string;
};

export type BusinessFlowDefinition = {
  id: string;
  caseId?: string;
  name: string;
  module: string;
  priority: string;
  level: TestLevel;
  scope: FlowScope;
  type: string;
  status: FlowStatus;
  capabilityStatus: FlowStatus;
  implemented: boolean;
  changesData: boolean;
  affectsMoney: boolean;
  requiresClient: boolean;
  requiresAdmin: boolean;
  requiresThirdParty: boolean;
  requiresSecurityKey: boolean;
  supportsResume: boolean;
  clientAction: string;
  adminAction: AdminAction;
  command: string | null;
  npmScript: string | null;
  safetySwitch: string | null;
  safetySwitches: readonly string[];
  regressionClass: RegressionClass;
  defaultRegression: boolean;
  moneyRegression: boolean;
  realE2EVerified: boolean | null;
  orderIdPrefix: BusinessOrderPrefix | null;
  businessResult: FlowBusinessResult;
  automationResult: FlowAutomationResult;
  primaryOracles: readonly string[];
  secondaryOracles: readonly string[];
  moneyExecution?: MoneyExecutionProfile;
  menuSection: string;
  menuOrder: number;
  description: string;
};
