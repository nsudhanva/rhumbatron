/**
 * Citation validation (AGENTS.md section 34.4.2). Every model finding must cite Evidence IDs or
 * Context Packet item IDs that the model actually received, for the same Project and Candidate.
 * A finding that fails is kept visible as `unsupported` and can never change Candidate state.
 */

export type Finding = {
  findingId: string;
  projectId: string;
  candidateId: string;
  /** Evidence IDs or Context Packet item IDs. */
  citations: readonly string[];
};

/** The Evidence Snapshot the model received (section 27.5). */
export type EvidenceSnapshot = {
  projectId: string;
  candidateId: string;
  evidence: readonly { evidenceId: string; candidateId: string }[];
  contextItems: readonly { itemId: string }[];
};

export type CitationErrorReason =
  | "no_citations"
  | "unknown_id"
  | "not_in_snapshot"
  | "wrong_project"
  | "wrong_candidate";

export type CitationError = { id: string | null; reason: CitationErrorReason };

export type ValidatedFinding<F extends Finding = Finding> = F & {
  support: "supported" | "unsupported";
  citationErrors: CitationError[];
};

/**
 * `knownIds`, when given, is every Evidence and Context item ID that exists for the Project. It
 * separates an invented ID (`unknown_id`) from a real one the model did not receive.
 */
export function validateCitations<F extends Finding>(
  finding: F,
  snapshot: EvidenceSnapshot,
  knownIds?: ReadonlySet<string>,
): ValidatedFinding<F> {
  const errors: CitationError[] = [];
  if (finding.citations.length === 0) errors.push({ id: null, reason: "no_citations" });
  if (snapshot.projectId !== finding.projectId) errors.push({ id: null, reason: "wrong_project" });
  if (snapshot.candidateId !== finding.candidateId) {
    errors.push({ id: null, reason: "wrong_candidate" });
  }

  const evidence = new Map(snapshot.evidence.map((e) => [e.evidenceId, e]));
  const items = new Set(snapshot.contextItems.map((i) => i.itemId));
  for (const id of finding.citations) {
    const record = evidence.get(id);
    if (record) {
      if (record.candidateId !== finding.candidateId)
        errors.push({ id, reason: "wrong_candidate" });
    } else if (!items.has(id)) {
      errors.push({ id, reason: knownIds && !knownIds.has(id) ? "unknown_id" : "not_in_snapshot" });
    }
  }

  return {
    ...finding,
    support: errors.length === 0 ? "supported" : "unsupported",
    citationErrors: errors,
  };
}

/** Only a validated, fully supported finding may change Candidate state. */
export function canAffectCandidate(finding: {
  support?: string;
  citationErrors?: readonly unknown[];
  citations: readonly string[];
}): boolean {
  return (
    finding.support === "supported" &&
    Array.isArray(finding.citationErrors) &&
    finding.citationErrors.length === 0 &&
    finding.citations.length > 0
  );
}
