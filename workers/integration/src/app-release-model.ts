import {
  type AppDeploymentStatus,
  MAX_PREVIEWS_PER_CHANGE,
  previewChannel,
  previewIdFor,
  type RiskTier,
  type RollbackRefusal,
  type VerificationPlan,
} from "@rhumbatron/protocol";

/**
 * Live app release decisions (ADR 0020). Pure: the integration Worker reads
 * D1 and ProjectRootDO, then applies these decisions with guarded writes. Deterministic; no model
 * decides whether an app version is served. Unit tested in
 * app-release-model.critical.test.ts.
 */

/* ------------------------------------------------------------------------------------------ */
/* Previews                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** One preview row of a Change, with the state of its Candidate. */
export type PreviewSlot = {
  channel: string;
  candidateId: string | null;
  candidateStatus: string | null;
  updatedAt: string;
};

export type PreviewPlan =
  /** The Candidate already has its preview channel: build into it again (idempotent). */
  | { kind: "reuse"; channel: string }
  /** A new channel; `evict` lists older preview channels to remove first (oldest first). */
  | { kind: "new"; channel: string; evict: string[] }
  /** Every slot holds a Candidate that can still ship: no preview for this one. */
  | { kind: "skip"; reason: "limit" };

/** Candidates whose preview nobody needs: they cannot ship from it. */
const EVICTABLE: ReadonlySet<string> = new Set(["stale", "rejected", "promoted"]);

/**
 * Preview channel selection. A Change keeps at most `max` previews (the Candidate limit). When
 * full, the oldest previews of stale, rejected, or promoted Candidates make room; previews of
 * Candidates that can still ship are never evicted.
 */
export function planPreview(input: {
  candidateId: string;
  previews: readonly PreviewSlot[];
  max?: number;
}): PreviewPlan {
  const max = input.max ?? MAX_PREVIEWS_PER_CHANGE;
  const channel = previewChannel(previewIdFor(input.candidateId));
  const own = input.previews.find(
    (p) => p.candidateId === input.candidateId || p.channel === channel,
  );
  if (own) return { kind: "reuse", channel: own.channel };
  const need = input.previews.length - max + 1;
  if (need <= 0) return { kind: "new", channel, evict: [] };
  const evictable = input.previews
    .filter((p) => p.candidateStatus === null || EVICTABLE.has(p.candidateStatus))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.channel.localeCompare(b.channel));
  if (evictable.length < need) return { kind: "skip", reason: "limit" };
  return { kind: "new", channel, evict: evictable.slice(0, need).map((p) => p.channel) };
}

/* ------------------------------------------------------------------------------------------ */
/* Production pointer                                                                          */
/* ------------------------------------------------------------------------------------------ */

/** What the production row serves. */
export type PointerTarget = { commit: string; bundleKey: string; generation: number };

export type PointerState = {
  commit: string | null;
  bundleKey: string | null;
  generation: number | null;
  status: AppDeploymentStatus;
} | null;

export type PointerMove =
  /** A promoted generation's release points production at its bundle. */
  | { kind: "release"; to: PointerTarget }
  /**
   * The release of `failed` did not pass its smoke check: production goes back to `to`, the
   * version it served before, as a new recorded transition.
   */
  | { kind: "revert"; failed: { commit: string; generation: number }; to: PointerTarget | null };

export type PointerDecision =
  | { kind: "move"; to: PointerTarget }
  | { kind: "noop"; reason: "current" }
  | {
      kind: "refuse";
      reason: "no_app" | "removed" | "newer" | "moved_on" | "nothing_to_restore";
    };

/**
 * Decides one production pointer transition. A release never moves the pointer back to an older
 * generation (a late release lost to a newer one). A revert happens only while production still
 * serves the failed release, so it can never undo a newer release.
 */
export function decidePointerMove(current: PointerState, move: PointerMove): PointerDecision {
  if (!current) return { kind: "refuse", reason: "no_app" };
  if (current.status === "removed") return { kind: "refuse", reason: "removed" };
  if (move.kind === "release") {
    if (current.generation !== null && current.generation > move.to.generation) {
      return { kind: "refuse", reason: "newer" };
    }
    if (
      current.status === "ready" &&
      current.commit === move.to.commit &&
      current.bundleKey === move.to.bundleKey &&
      current.generation === move.to.generation
    ) {
      return { kind: "noop", reason: "current" };
    }
    return { kind: "move", to: move.to };
  }
  if (current.commit !== move.failed.commit || current.generation !== move.failed.generation) {
    return { kind: "refuse", reason: "moved_on" };
  }
  if (!move.to) return { kind: "refuse", reason: "nothing_to_restore" };
  return { kind: "move", to: move.to };
}

/** The pointer the failed release replaced, from the row before the move. Null without a bundle. */
export function restorableTarget(previous: PointerState): PointerTarget | null {
  if (!previous?.commit || !previous.bundleKey || previous.generation === null) return null;
  return {
    commit: previous.commit,
    bundleKey: previous.bundleKey,
    generation: previous.generation,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Rollback                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export type RollbackFacts = {
  current: { generation: number; treeSha: string };
  expectedGeneration: number;
  targetGeneration: number;
  /** The resolved earlier generation, or null when it is not a known canonical version. */
  target: { generation: number; treeSha: string; commit: string } | null;
};

export type RollbackDecision =
  | {
      kind: "proceed";
      /** The new generation: a rollback is a forward transition, never a deletion. */
      nextGeneration: number;
      baseGeneration: number;
      baseTree: string;
      tree: string;
      targetCommit: string;
    }
  | {
      kind: "refuse";
      reason: Extract<RollbackRefusal, "stale" | "not_earlier" | "unknown_target" | "same_tree">;
      detail: string;
    };

/**
 * Rollback transition rule. Rolling back to Sk from Sn is the new
 * transition Sn -> Sn+1 whose tree equals Sk's tree. Allowed only from the generation the caller
 * saw, only to an earlier, known generation, and only when the tree changes. History is
 * never deleted: Sn stays in the log, and Sn+1 is a new version.
 */
export function decideRollback(facts: RollbackFacts): RollbackDecision {
  const { current } = facts;
  if (facts.expectedGeneration !== current.generation) {
    return {
      kind: "refuse",
      reason: "stale",
      detail: `Canonical is S${current.generation}, not S${facts.expectedGeneration}. Reload and try again.`,
    };
  }
  if (facts.targetGeneration >= current.generation) {
    return {
      kind: "refuse",
      reason: "not_earlier",
      detail: `S${facts.targetGeneration} is not earlier than the live S${current.generation}.`,
    };
  }
  const target = facts.target;
  if (!target || target.generation !== facts.targetGeneration) {
    return {
      kind: "refuse",
      reason: "unknown_target",
      detail: `S${facts.targetGeneration} has no recorded tree to roll back to.`,
    };
  }
  if (target.treeSha === current.treeSha) {
    return {
      kind: "refuse",
      reason: "same_tree",
      detail: `S${current.generation} already has the tree of S${target.generation}.`,
    };
  }
  return {
    kind: "proceed",
    nextGeneration: current.generation + 1,
    baseGeneration: current.generation,
    baseTree: current.treeSha,
    tree: target.treeSha,
    targetCommit: target.commit,
  };
}

const RISK_ORDER: readonly RiskTier[] = ["low", "medium", "high", "critical"];

/**
 * Risk of a rollback: the highest risk tier among the Changes it undoes (Sk+1..Sn). Undoing an
 * authorization change is as risky as making it. Medium when none is known.
 */
export function rollbackRiskTier(undone: readonly (string | null)[]): RiskTier {
  let index = -1;
  for (const tier of undone) {
    index = Math.max(index, RISK_ORDER.indexOf(tier as RiskTier));
  }
  return RISK_ORDER[index] ?? "medium";
}

/** The rollback's one required check: the new commit's tree equals Sk's tree. */
export const ROLLBACK_CHECK_ID = "rollback-tree";

export function rollbackPlan(input: {
  candidateId: string;
  targetGeneration: number;
  policyVersion: string;
  humanApprovalRequired: boolean;
}): VerificationPlan {
  return {
    candidateId: input.candidateId,
    checks: [
      {
        checkId: ROLLBACK_CHECK_ID,
        kind: "static-analysis",
        reason: `A rollback ships exactly the tree that S${input.targetGeneration} verified and promoted.`,
        procedure: `Read the rollback commit from Artifacts and compare its tree with S${input.targetGeneration}'s tree.`,
        timeoutMs: 60_000,
        required: true,
        expected: {
          kind: "procedure",
          description: `Tree equals S${input.targetGeneration}'s tree`,
        },
        evidenceOutput: ["report.json", "stdout.txt"],
      },
    ],
    requiredCheckIds: [ROLLBACK_CHECK_ID],
    humanApprovalRequired: input.humanApprovalRequired,
    policyVersion: input.policyVersion,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Stale Candidate recomposition                                                               */
/* ------------------------------------------------------------------------------------------ */

/**
 * Recompositions per Candidate lineage; then the Candidate is blocked (needs a person). Each
 * recomposition follows a promotion of another request, so a request that waits behind up to
 * this many others still lands. A recomposition makes no agent model call: one merge, the
 * checks, and the acceptance call.
 */
export const MAX_RECOMPOSES = 6;

const CLOSED_CHANGE: ReadonlySet<string> = new Set([
  "cancelled",
  "not_selected",
  "needs_input",
  "failed",
  "completed",
  "promoting",
  "releasing",
]);

export const requestCannotShip = (status: string, outcome?: string | null) =>
  ["not_selected", "cancelled", "needs_input"].includes(status) ||
  ["not_selected", "duplicate"].includes(outcome ?? "");

export type RecomposeDecision =
  | { kind: "recompose"; nextCount: number }
  | { kind: "blocked" }
  | {
      kind: "skip";
      reason: "not_stale" | "change_closed" | "not_behind" | "rollback" | "promoted_sibling";
    };

/**
 * A stale Candidate is composed again on the new canonical state and verified again, at most
 * MAX_RECOMPOSES times per lineage. A Change that already promoted a sibling, a closed Change,
 * and a rollback Candidate (its target tree is fixed) never recompose.
 */
export function recomposeDecision(input: {
  candidateStatus: string;
  recomposeCount: number;
  changeStatus: string;
  changeOutcome?: string | null;
  baseGeneration: number;
  canonicalGeneration: number;
  isRollback: boolean;
  siblingPromoted: boolean;
}): RecomposeDecision {
  if (input.candidateStatus !== "stale") return { kind: "skip", reason: "not_stale" };
  if (input.isRollback) return { kind: "skip", reason: "rollback" };
  if (input.siblingPromoted) return { kind: "skip", reason: "promoted_sibling" };
  if (
    CLOSED_CHANGE.has(input.changeStatus) ||
    requestCannotShip(input.changeStatus, input.changeOutcome)
  )
    return { kind: "skip", reason: "change_closed" };
  if (input.canonicalGeneration <= input.baseGeneration) {
    return { kind: "skip", reason: "not_behind" };
  }
  if (input.recomposeCount >= MAX_RECOMPOSES) return { kind: "blocked" };
  return { kind: "recompose", nextCount: input.recomposeCount + 1 };
}

/** Status reason of a Candidate that reached the recomposition bound. */
export const recomposeBlockedReason = (canonicalGeneration: number) =>
  `Blocked: recomposed ${MAX_RECOMPOSES} times and canonical moved again (now S${canonicalGeneration}). Create a new Candidate to try again.`;
