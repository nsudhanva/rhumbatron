import type { ChangeStatus, ReleaseStatus, TaskStatus } from "@rhumbatron/protocol";

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

/** Task stops that set the Change `budget_blocked` (agents limits.ts `limitStop`). */
const BUDGET_STOP_LIMITS = [
  "daily_model_calls",
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
