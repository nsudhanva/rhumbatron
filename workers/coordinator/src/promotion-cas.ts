/**
 * Canonical promotion compare-and-swap (AGENTS.md sections 13.1 and 36).
 * Pure decision logic. ProjectRootDO applies the decision inside one SQLite transaction.
 */

export type CanonicalState = {
  generation: number;
  artifactRef: string;
  treeSha: string;
  /** Candidate that produced the current generation, for idempotent retries. */
  lastPromotedCandidateId: string | null;
};

export type PromotionAttempt = {
  candidateId: string;
  expectedGeneration: number;
  /** Optional tree check (section 36, rule 7). */
  expectedTreeSha?: string;
  candidateArtifactRef: string;
  candidateTreeSha: string;
};

export type PromotionDecision =
  | { kind: "advance"; next: Omit<CanonicalState, "lastPromotedCandidateId"> }
  | { kind: "already_promoted"; generation: number }
  | {
      kind: "stale";
      reason: "generation_mismatch" | "tree_mismatch";
      current: { generation: number; treeSha: string };
    };

export function decidePromotion(
  current: CanonicalState,
  attempt: PromotionAttempt,
): PromotionDecision {
  // Retry of a promotion that already succeeded (idempotency key: candidate + expected generation).
  if (
    current.lastPromotedCandidateId === attempt.candidateId &&
    current.generation === attempt.expectedGeneration + 1
  ) {
    return { kind: "already_promoted", generation: current.generation };
  }

  const stale = (reason: "generation_mismatch" | "tree_mismatch") => ({
    kind: "stale" as const,
    reason,
    current: { generation: current.generation, treeSha: current.treeSha },
  });

  if (current.generation !== attempt.expectedGeneration) return stale("generation_mismatch");
  if (attempt.expectedTreeSha !== undefined && current.treeSha !== attempt.expectedTreeSha) {
    return stale("tree_mismatch");
  }

  return {
    kind: "advance",
    next: {
      generation: current.generation + 1,
      artifactRef: attempt.candidateArtifactRef,
      treeSha: attempt.candidateTreeSha,
    },
  };
}
