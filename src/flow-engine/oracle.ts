export type FlowOracleLevel = 'primary' | 'secondary';
export type FlowOracleStatus = 'passed' | 'failed';

export type FlowOracleResult = {
  id: string;
  name: string;
  level: FlowOracleLevel;
  expected: string;
  actual: string;
  status: FlowOracleStatus;
};

export type FlowOutcome =
  | 'PASS'
  | 'PASS_WITH_WARNING'
  | 'FAIL'
  | 'MANUAL_REVIEW'
  | 'BLOCKED'
  | 'NOT_RUN';

export type OracleAdjudicationInput = {
  oracles: readonly FlowOracleResult[];
  warnings?: readonly string[];
  blocked?: boolean;
  mutationOccurred?: boolean;
  resultUncertain?: boolean;
  technicalFailure?: boolean;
};

export function adjudicateOracles(input: OracleAdjudicationInput): FlowOutcome {
  if (input.blocked) return 'BLOCKED';
  if (input.mutationOccurred && input.resultUncertain) return 'MANUAL_REVIEW';

  const primary = input.oracles.filter(oracle => oracle.level === 'primary');
  const secondary = input.oracles.filter(oracle => oracle.level === 'secondary');
  if (primary.some(oracle => oracle.status === 'failed')) return 'FAIL';

  const allPrimaryPassed =
    primary.length > 0 && primary.every(oracle => oracle.status === 'passed');
  if (allPrimaryPassed) {
    if (
      secondary.some(oracle => oracle.status === 'failed') ||
      (input.warnings?.length ?? 0) > 0
    ) {
      return 'PASS_WITH_WARNING';
    }
    if (!input.technicalFailure) return 'PASS';
  }

  if (input.technicalFailure) return 'FAIL';
  return 'NOT_RUN';
}

