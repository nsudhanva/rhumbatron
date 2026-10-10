import {
  type ChangeStatus,
  RELEASE_STUCK_AFTER_MS,
  type ReleaseStatus,
  type TaskStatus,
} from "@rhumbatron/protocol";

/**
 * Change status transitions after the Work Graph (AGENTS.md sections 21.1, 36, 37, 44). Pure and
 * deterministic: the writers in promotion.ts, release.ts, verification-workflow.ts, and
 * change-commands.ts guard each D1 update with these from-states, so a retry or a race applies a
 * transition at most once and never moves a Change out of a terminal state.
 */

/** No transition leaves these. */
export const TERMINAL_CHANGE_STATUSES: readonly ChangeStatus[] = [
  "completed",
  "cancelled",
  "failed",
];

/**
 * A verified Candidate can promote while its Change is open (a person can verify a Candidate before
 * the Work Graph finishes). `promoting` is listed so a retried request after a lost reply proceeds.
 */
export const PROMOTABLE_FROM: readonly ChangeStatus[] = [
  "running",
  "verifying",
  "awaiting_approval",
  "budget_blocked",
  "promoting",
];

/**
 * A person can cancel a Change until promotion starts. From `promoting` on, the canonical
 * transition may already have happened, and a canonical transition is never undone (section 42.10).
 */
export const CANCELLABLE_FROM: readonly ChangeStatus[] = [
  "created",
  "compiling",
  "running",
  "verifying",
  "awaiting_approval",
  "budget_blocked",
];

export const canCancel = (status: string) =>
  (CANCELLABLE_FROM as readonly string[]).includes(status);

/**
 * Status after `canonical.advanced`. With a release target, the Change is `releasing` until its
 * release finishes. Without one, promotion is the end of the Change, as before (ADR 0013).
 */
export const changeAfterPromotion = (hasReleaseTarget: boolean): ChangeStatus =>
  hasReleaseTarget ? "releasing" : "completed";

/**
 * Status of a `releasing` Change when its release reaches a final status. A superseded release
 * still promoted its Change: the newer generation's release owns the deployment. Null while the
 * release is in flight.
 */
export function changeAfterRelease(status: ReleaseStatus): "completed" | "failed" | null {
  switch (status) {
    case "deployed":
    case "superseded":
      return "completed";
    case "failed":
    case "smoke_failed":
      return "failed";
    case "queued":
    case "building":
      return null;
  }
}

/** What the stuck-release sweep does with one `releasing` Change (section 42.10). */
export type ReleaseRecovery =
  /** Not stuck yet. */
  | { kind: "wait" }
  /** The release finished but the Change was not settled: settle it as the release did. */
  | { kind: "settle"; change: "completed" | "failed" }
  /** No release target and no release: promotion is the end of the Change (ADR 0013). */
  | { kind: "complete"; reason: string }
  /** The release is still queued or building: mark it failed, which fails the Change. */
  | { kind: "fail_release"; reason: string }
  /** No release row exists although the Project has a release target: record a failed one. */
  | { kind: "fail_unstarted"; reason: string };

const minutes = (ms: number) => Math.round(ms / 60_000);

/**
 * Deterministic recovery of a Change stuck in `releasing`. Never reopens a canonical transition:
 * the generation stays promoted, and recovery is a later promotion (section 42.10). A timestamp
 * that does not parse counts as old, so a bad row cannot hold a Change forever.
 */
export function releaseRecovery(input: {
  hasReleaseTarget: boolean;
  release: { status: ReleaseStatus; startedAt: string } | null;
  /** `changes.updated_at`: the promotion wrote `releasing` and nothing else moves it. */
  releasingSince: string;
  now: number;
}): ReleaseRecovery {
  const { release } = input;
  const settled = release ? changeAfterRelease(release.status) : null;
  if (settled) return { kind: "settle", change: settled };
  const since = [input.releasingSince, release?.startedAt]
    .map((at) => (at ? Date.parse(at) : Number.NaN))
    .filter(Number.isFinite);
  if (since.length > 0 && input.now - Math.max(...since) < RELEASE_STUCK_AFTER_MS) {
    return { kind: "wait" };
  }
  const after = minutes(RELEASE_STUCK_AFTER_MS);
  if (release) {
    return {
      kind: "fail_release",
      reason: `The release stayed ${release.status} for more than ${after} minutes; its ReleaseWorkflow did not finish.`,
    };
  }
  if (!input.hasReleaseTarget) {
    return {
      kind: "complete",
      reason: "The Project has no release target; promotion completed the Change.",
    };
  }
  return {
    kind: "fail_unstarted",
    reason: `No release started within ${after} minutes of promotion: the canonical source sync or the release start failed.`,
  };
}

/** Candidate reason when a cancel stops it (cancelChange and the verification workflow). */
export const CHANGE_CANCELLED_REASON = "change cancelled";

/**
 * Whether an in-flight CandidateVerificationWorkflow stops before its next step (section 44:
 * stop new expensive work). A cancelled Change stops it first; then a Candidate that is already
 * final (stale after `canonical.advanced`, rejected, promoted) or gone has nothing left to verify.
 */
export function verificationHalt(
  changeStatus: string | null,
  candidateStatus: string | null,
): "change_cancelled" | "candidate_final" | null {
  if (changeStatus === "cancelled") return "change_cancelled";
  if (candidateStatus === null || ["rejected", "stale", "promoted"].includes(candidateStatus)) {
    return "candidate_final";
  }
  return null;
}

/** Task stops that set the Change `budget_blocked` (agents limits.ts `limitStop`). */
const BUDGET_STOP_LIMITS = [
  "daily_model_calls",
  "monthly_model_spend",
  // Rows blocked before ADR 0021 (Gemini on Vertex) keep their limit name.
  "vertex_spend_limit",
  "max_cost_usd_per_change",
  "max_attempts_per_tier",
] as const;

export type RestorableTask = {
  id: string;
  status: TaskStatus;
  blockedLimit: string | null;
  dependsOn: readonly string[];
};

/**
 * Tasks to restore when a person raises the budget of a `budget_blocked` Change (section 44
 * rule 5). A budget-stopped Task returns to `ready` when its dependencies are complete, else to
 * `pending`. A Task blocked without a limit was blocked by a stopped dependency (`blockedByFailure`)
 * and returns to `pending` only when every blocked ancestor is restored here; a Task below a
 * failed, cancelled, or dead-lettered Task stays blocked. The admission checks run again on the
 * next start, so a limit that is still reached stops the Task again with its exact name.
 */
export function restoreAfterBudgetRaise(tasks: readonly RestorableTask[]): {
  ready: string[];
  pending: string[];
} {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const stopped = (t: RestorableTask) =>
    t.status === "blocked" &&
    (BUDGET_STOP_LIMITS as readonly string[]).includes(t.blockedLimit ?? "");
  const memo = new Map<string, boolean>();
  // True when the Task can run again after the restore: it is not blocked, or it is blocked only
  // because of restored budget stops above it.
  const clear = (id: string, seen: Set<string>): boolean => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const task = byId.get(id);
    let ok: boolean;
    if (!task || seen.has(id)) ok = false;
    else if (stopped(task)) ok = depsClear(task, seen);
    else if (task.status === "blocked") ok = task.blockedLimit === null && depsClear(task, seen);
    else ok = !["failed", "cancelled"].includes(task.status);
    memo.set(id, ok);
    return ok;
  };
  const depsClear = (task: RestorableTask, seen: Set<string>) => {
    const next = new Set(seen).add(task.id);
    return task.dependsOn.every((d) => clear(d, next));
  };

  const ready: string[] = [];
  const pending: string[] = [];
  for (const task of tasks) {
    if (task.status !== "blocked" || !clear(task.id, new Set())) continue;
    const depsDone = task.dependsOn.every((d) => byId.get(d)?.status === "completed");
    if (stopped(task) && depsDone) ready.push(task.id);
    else pending.push(task.id);
  }
  return { ready, pending };
}
