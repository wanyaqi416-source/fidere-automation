export type CandidateMatchStage<T> = {
  id: string;
  label: string;
  matches(candidate: T): boolean;
};

export type CandidateStageResult = {
  id: string;
  label: string;
  candidateCount: number;
};

export type CandidateMatchResult<T> = {
  initialCount: number;
  stages: CandidateStageResult[];
  counts: Record<string, number>;
  candidates: T[];
};

export function matchCandidatesByStages<T>(
  candidates: readonly T[],
  stages: readonly CandidateMatchStage<T>[]
): CandidateMatchResult<T> {
  const ids = new Set<string>();
  let current = [...candidates];
  const results: CandidateStageResult[] = [];

  for (const stage of stages) {
    if (!stage.id.trim()) {
      throw new Error('Candidate match stage id cannot be empty.');
    }
    if (ids.has(stage.id)) {
      throw new Error(`Candidate match stage id must be unique: ${stage.id}.`);
    }
    ids.add(stage.id);
    current = current.filter(candidate => stage.matches(candidate));
    results.push({ id: stage.id, label: stage.label, candidateCount: current.length });
  }

  return {
    initialCount: candidates.length,
    stages: results,
    counts: Object.fromEntries(results.map(stage => [stage.id, stage.candidateCount])),
    candidates: current
  };
}

export function requireExactlyOneCandidate<T>(
  candidates: readonly T[],
  flowName: string
): T {
  if (candidates.length !== 1) {
    throw new Error(
      `${flowName} candidateCount must equal 1 before any mutation; received ${candidates.length}.`
    );
  }

  return candidates[0];
}

