import {
  type ChangeStatus,
  RELEASE_STUCK_AFTER_MS,
  type ReleaseStatus,
  type TaskStatus,
} from "@rhumbatron/protocol";

/**
 * Change status transitions after the Work Graph. Pure and
 * deterministic: the writers in promotion.ts, release.ts, verification-workflow.ts, and
 * change-commands.ts guard each D1 update with these from-states, so a retry or a race applies a
 * transition at most once and never moves a Change out of a terminal state.
 */

/** No transition leaves these. */
export const TERMINAL_CHANGE_STATUSES: readonly ChangeStatus[] = [
  "completed",
  "cancelled",
  "failed",
  "not_selected",
  "declined",
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
 * transition may already have happened, and a canonical transition is never undone.
 */
export const CANCELLABLE_FROM: readonly ChangeStatus[] = [
  "created",
  "compiling",
  "running",
  "verifying",
  "awaiting_approval",
  "budget_blocked",
  "blocked",
];

/**
 * Status after `canonical.advanced`. With a live app, the Change is `releasing` until its
 * release finishes. Without one, promotion is the end of the Change (ADR 0013, ADR 0020).
 */
export const changeAfterPromotion = (hasLiveApp: boolean): ChangeStatus =>
  hasLiveApp ? "releasing" : "completed";

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

/** What the stuck-release sweep does with one `releasing` Change. */
export type ReleaseRecovery =
  /** Not stuck yet. */
  | { kind: "wait" }
  /** The release finished but the Change was not settled: settle it as the release did. */
  | { kind: "settle"; change: "completed" | "failed" }
  /** No live app and no release: promotion is the end of the Change (ADR 0013). */
  | { kind: "complete"; reason: string }
  /** The release is still queued or building: mark it failed, which fails the Change. */
  | { kind: "fail_release"; reason: string }
  /** No release row exists although the Project has a live app: record a failed one. */
  | { kind: "fail_unstarted"; reason: string };

const minutes = (ms: number) => Math.round(ms / 60_000);

/**
 * Deterministic recovery of a Change stuck in `releasing`. Never reopens a canonical transition:
 * the generation stays promoted, and recovery is a later promotion. A timestamp
 * that does not parse counts as old, so a bad row cannot hold a Change forever.
 */
export function releaseRecovery(input: {
  hasLiveApp: boolean;
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
  if (!input.hasLiveApp) {
    return {
      kind: "complete",
      reason: "The Project has no live app; promotion completed the Change.",
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
 * Whether an in-flight CandidateVerificationWorkflow stops before its next step (stop new
 * expensive work). A cancelled Change stops it first; then a Candidate that is already
 * final (stale after `canonical.advanced`, rejected, promoted) or gone has nothing left to verify.
 */
export function verificationHalt(
  changeStatus: string | null,
  candidateStatus: string | null,
): "change_cancelled" | "candidate_final" | null {
  if (changeStatus && ["cancelled", "not_selected", "needs_input"].includes(changeStatus))
    return "change_cancelled";
  if (candidateStatus === null || ["rejected", "stale", "promoted"].includes(candidateStatus)) {
    return "candidate_final";
  }
  return null;
}

/** Candidate statuses from which the Change can still ship. */
const LIVE_CANDIDATE_STATUSES = ["composing", "composed", "verifying", "verified", "promoted"];
/** A source merge rejection: rebase.ts re-runs the Tasks on the current files. */
const SOURCE_CONFLICT = /^(?:file_conflict|source_conflict):/;

/**
 * Why a `verifying` Change can never ship, or null while it still can. Its Candidates on the
 * newest base are all `rejected`, none of the Change's Candidates is live, and no rejection is a
 * cancel. A source conflict (rebase.ts re-runs its Tasks) waits only while it is the newest
 * Candidate of the group: a later Candidate on that base is the re-run's result. The candidates
 * come in creation order. A `stale` Candidate on the newest base
 * waits for its recompose. Without this end, the Change would show `verifying` with nothing
 * left to verify; the planning failure path ends the same way (`failed`, `change.failed`).
 */
export function verificationDeadEnd(
  candidates: readonly { status: string; statusReason: string | null; baseGeneration: number }[],
): string | null {
  if (candidates.length === 0) return null;
  if (candidates.some((c) => LIVE_CANDIDATE_STATUSES.includes(c.status))) return null;
  const newest = Math.max(...candidates.map((c) => c.baseGeneration));
  const group = candidates.filter((c) => c.baseGeneration === newest);
  if (!group.every((c) => c.status === "rejected")) return null;
  if (
    group.some((c) => c.statusReason === CHANGE_CANCELLED_REASON) ||
    SOURCE_CONFLICT.test(group.at(-1)?.statusReason ?? "")
  ) {
    return null;
  }
  const reasons = [
    ...new Set(group.map((c) => (c.statusReason ?? "rejected").replace(/\.$/, ""))),
  ].join("; ");
  const text = `No Candidate passed its required checks: ${reasons}`;
  return `${text.length > 400 ? `${text.slice(0, 399)}…` : text}. Submit the request again.`;
}

/** Task stops that set the Change `budget_blocked` (agents limits.ts `limitStop`). */
const BUDGET_STOP_LIMITS = [
  "daily_model_calls",
  "monthly_model_spend",
  // Rows blocked before ADR 0021 (Gemini on Vertex) keep their limit name.
  "vertex_spend_limit",
  // Rows blocked before ADR 0030 name the Change budget `max_cost_usd_per_change`.
  "max_cost_usd_per_change",
  "change_budget",
  "project_budget",
  "account_budget",
  "max_attempts_per_tier",
] as const;

/** Budget stops after which a raise opens a new attempt window for the Task. */
const ATTEMPT_WINDOW_LIMITS = [
  "max_attempts_per_tier",
  "max_cost_usd_per_change",
  "change_budget",
  "project_budget",
  "account_budget",
] as const;

export type RestorableTask = {
  id: string;
  status: TaskStatus;
  blockedLimit: string | null;
  dependsOn: readonly string[];
};

/**
 * Tasks to restore when a person raises the budget of a `budget_blocked` Change.
 * A budget-stopped Task returns to `ready` when its dependencies are complete, else to
 * `pending`. A Task blocked without a limit was blocked by a stopped dependency (`blockedByFailure`)
 * and returns to `pending` only when every blocked ancestor is restored here; a Task below a
 * failed, cancelled, or dead-lettered Task stays blocked. The admission checks run again on the
 * next start, so a limit that is still reached stops the Task again with its exact name.
 *
 * `newAttemptWindow` lists the restored Tasks whose earlier runs must not count against the
 * attempt limit: a repeated-failure stop, and a Change, Project, or requester budget stop. A run
 * that hits its share of a too-small budget ends as `run_cost_cap`, and a run whose call a budget
 * refused ends as that budget, so the old history alone would stop the Task again before any new
 * run (`nextAttempt` in agents limits.ts).
 */
export function restoreAfterBudgetRaise(tasks: readonly RestorableTask[]): {
  ready: string[];
  pending: string[];
  newAttemptWindow: string[];
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
  const newAttemptWindow = [...ready, ...pending].filter((id) =>
    (ATTEMPT_WINDOW_LIMITS as readonly string[]).includes(byId.get(id)?.blockedLimit ?? ""),
  );
  return { ready, pending, newAttemptWindow };
}
