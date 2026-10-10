import type { ProjectRootDO } from "@rhumbatron/coordinator";
import type { ChangeCommandOutcome, ChangeStatus, TaskStatus } from "@rhumbatron/protocol";
import {
  CANCELLABLE_FROM,
  CHANGE_CANCELLED_REASON,
  canCancel,
  restoreAfterBudgetRaise,
  TERMINAL_CHANGE_STATUSES,
} from "./change-status.ts";
import { dispatchReadyTasks } from "./dispatch.ts";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";
import { recoverSourceConflicts } from "./rebase.ts";
import { recoverStaleCandidates } from "./recompose.ts";
import { startWorkflowOnce } from "./workflow-commands.ts";

/**
 * A person's cancel and budget raise on one Change (AGENTS.md sections 16.1, 44, 60). Called only
 * by the API over the `INTEGRATION` service binding, after it authenticated the user and checked
 * project membership. Deterministic and idempotent: every write is guarded by the from-states in
 * change-status.ts, and a repeat returns the stored result.
 */

type ChangeRow = {
  id: string;
  project_id: string;
  status: ChangeStatus;
  base_generation: number;
  budget_usd: number;
  org_id: string;
  slug: string;
};

const loadChange = (env: Env, changeId: string) =>
  env.DB.prepare(
    `SELECT c.id, c.project_id, c.status, c.base_generation, c.budget_usd, p.org_id, p.slug
     FROM changes c JOIN projects p ON p.id = c.project_id WHERE c.id = ?`,
  )
    .bind(changeId)
    .first<ChangeRow>();

const contextOf = (row: ChangeRow): ChangeContext => ({
  projectId: row.project_id,
  orgId: row.org_id,
  projectSlug: row.slug,
  changeId: row.id,
  baseGeneration: row.base_generation,
});

const notFound = (changeId: string): ChangeCommandOutcome => ({
  status: "refused",
  reason: "not_found",
  detail: `Change ${changeId} not found`,
});

const recorded = (
  row: ChangeRow,
  repeated: boolean,
  dispatchedTaskIds: string[] = [],
): ChangeCommandOutcome => ({
  status: "recorded",
  changeId: row.id,
  changeStatus: row.status,
  budgetUsd: row.budget_usd,
  repeated,
  dispatchedTaskIds,
});

/**
 * Cancels a Change before promotion starts. Open Tasks become `cancelled`, so no new dispatch or
 * wake starts them (dispatch.ts reads only `running` Changes; a wake for a cancelled Task is stale),
 * and a running agent run stops at its next run check. Open Candidates become `rejected`, so none
 * can pass the section 36 preconditions. History stays: nothing is deleted.
 */
export async function cancelChange(
  env: Env,
  input: { changeId: string; actorUserId: string },
  selection?: { reason: string; winnerChangeId: string; decidedBy: string },
): Promise<ChangeCommandOutcome> {
  const row = await loadChange(env, input.changeId);
  if (!row) return notFound(input.changeId);
  const target = selection ? "not_selected" : "cancelled";
  if (row.status === target) {
    const ctx = contextOf(row);
    // Repair an event delivery that failed after the guarded D1 batch committed.
    await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
      await changeEvent(
        ctx,
        "change.cancelled",
        {
          status: target,
          outcome: selection ? "not_selected" : null,
          reason: selection?.reason ?? CHANGE_CANCELLED_REASON,
        },
        {
          actor: {
            kind: selection?.decidedBy === "policy:priority_wins" ? "system" : "user",
            id: input.actorUserId,
          },
        },
      ),
    ]);
    await releaseRequestScope(env, row.project_id, row.id);
    return recorded(row, true);
  }
  if (
    !canCancel(row.status) &&
    !(selection && ["awaiting_owner", "failed", "completed"].includes(row.status))
  ) {
    return {
      status: "refused",
      reason: "not_cancellable",
      detail: `Change is ${row.status}; only a Change that has not started promotion can be cancelled.`,
    };
  }
  const now = new Date().toISOString();
  // One batch is one transaction. The Task and Candidate updates apply only once the Change is
  // cancelled, so a lost race against promotion changes nothing.
  const cancelled = `EXISTS (SELECT 1 FROM changes WHERE id = ? AND status = '${target}')`;
  const [change, tasks, candidates] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE changes SET status = ?, updated_at = ?,
         outcome = CASE WHEN ? THEN 'not_selected' ELSE outcome END,
         outcome_reason = CASE WHEN ? THEN ? ELSE outcome_reason END,
         outcome_winner_change_id = CASE WHEN ? THEN ? ELSE outcome_winner_change_id END,
         outcome_decided_by = CASE WHEN ? THEN ? ELSE outcome_decided_by END
       WHERE id = ? AND status IN (SELECT value FROM json_each(?))
         AND NOT EXISTS (SELECT 1 FROM candidates WHERE change_id = changes.id AND status = 'promoted')`,
    ).bind(
      target,
      now,
      selection ? 1 : 0,
      selection ? 1 : 0,
      selection?.reason ?? null,
      selection ? 1 : 0,
      selection?.winnerChangeId ?? null,
      selection ? 1 : 0,
      selection?.decidedBy ?? null,
      row.id,
      JSON.stringify(
        selection
          ? [...CANCELLABLE_FROM, "awaiting_owner", "failed", "completed"]
          : CANCELLABLE_FROM,
      ),
    ),
    env.DB.prepare(
      `UPDATE tasks SET status = 'cancelled', updated_at = ?
       WHERE change_id = ? AND status IN ('pending', 'ready', 'assigned', 'running', 'blocked')
         AND ${cancelled}`,
    ).bind(now, row.id, row.id),
    env.DB.prepare(
      `UPDATE candidates SET status = 'rejected', status_reason = ?, updated_at = ?
       WHERE change_id = ? AND status IN ('composing', 'composed', 'verifying', 'verified', 'stale')
         AND ${cancelled}`,
    ).bind(selection?.reason ?? CHANGE_CANCELLED_REASON, now, row.id, row.id),
  ]);
  const after = await loadChange(env, row.id);
  if (!after) return notFound(row.id);
  if (!change?.meta.changes) {
    // Another request moved the Change first.
    return after.status === target
      ? recorded(after, true)
      : {
          status: "refused",
          reason: "not_cancellable",
          detail: `Change is ${after.status}; only a Change that has not started promotion can be cancelled.`,
        };
  }
  const ctx = contextOf(row);
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "change.cancelled",
      {
        status: target,
        outcome: selection ? "not_selected" : null,
        reason: selection?.reason ?? CHANGE_CANCELLED_REASON,
        fromStatus: row.status,
        cancelledTasks: tasks?.meta.changes ?? 0,
        rejectedCandidates: candidates?.meta.changes ?? 0,
      },
      {
        actor: {
          kind: selection?.decidedBy === "policy:priority_wins" ? "system" : "user",
          id: input.actorUserId,
        },
      },
    ),
  ]);
  await releaseRequestScope(env, row.project_id, row.id);
  return recorded(after, false);
}

/**
 * Raises a Change budget (section 44 rule 5). A `budget_blocked` Change returns to `running`, the
 * status that every budget stop leaves (agents limits.ts), and its ready Tasks are dispatched the
 * normal way. The admission checks run again on each start. A repeat of the same amount changes
 * nothing and re-dispatches only Tasks that are still ready and not woken.
 */
export async function raiseChangeBudget(
  env: Env,
  input: { changeId: string; budgetUsd: number; actorUserId: string },
): Promise<ChangeCommandOutcome> {
  const row = await loadChange(env, input.changeId);
  if (!row) return notFound(input.changeId);
  if (TERMINAL_CHANGE_STATUSES.includes(row.status)) {
    return { status: "refused", reason: "change_closed", detail: `Change is ${row.status}` };
  }
  if (input.budgetUsd < row.budget_usd) {
    return {
      status: "refused",
      reason: "budget_lower",
      detail: `The budget is $${row.budget_usd.toFixed(2)}; it can only be raised.`,
    };
  }
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE changes SET budget_usd = MAX(budget_usd, ?), updated_at = ?
       WHERE id = ? AND status NOT IN ('completed', 'cancelled', 'failed')`,
    ).bind(input.budgetUsd, now, row.id),
  ];
  if (row.status === "budget_blocked") {
    const [tasks, deps] = await env.DB.batch([
      env.DB.prepare("SELECT id, status, blocked_limit FROM tasks WHERE change_id = ?").bind(
        row.id,
      ),
      env.DB.prepare(
        `SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d
         JOIN tasks t ON t.id = d.task_id WHERE t.change_id = ?`,
      ).bind(row.id),
    ]);
    const rows = (tasks?.results ?? []) as {
      id: string;
      status: TaskStatus;
      blocked_limit: string | null;
    }[];
    const edges = (deps?.results ?? []) as { task_id: string; depends_on_task_id: string }[];
    const restore = restoreAfterBudgetRaise(
      rows.map((t) => ({
        id: t.id,
        status: t.status,
        blockedLimit: t.blocked_limit,
        dependsOn: edges.filter((e) => e.task_id === t.id).map((e) => e.depends_on_task_id),
      })),
    );
    // Guarded on the Change: a concurrent raise or cancel restores nothing twice.
    const blocked = `EXISTS (SELECT 1 FROM changes WHERE id = ? AND status = 'budget_blocked')`;
    const moveTask = (id: string, to: "ready" | "pending") =>
      env.DB.prepare(
        `UPDATE tasks SET status = ?, assigned_agent_id = NULL, wake_sent_at = NULL,
           attempts_reset_at = CASE WHEN blocked_limit = 'max_attempts_per_tier' THEN ?
             ELSE attempts_reset_at END,
           blocked_limit = NULL, blocked_reason = NULL, updated_at = ?
         WHERE id = ? AND status = 'blocked' AND ${blocked}`,
      ).bind(to, now, now, id, row.id);
    statements.push(
      ...restore.ready.map((id) => moveTask(id, "ready")),
      ...restore.pending.map((id) => moveTask(id, "pending")),
      // A dead-letter note on the Change is not a budget stop; it stays until its own resolution.
      env.DB.prepare(
        `UPDATE changes SET status = 'running',
           blocked_limit = CASE WHEN blocked_limit = 'dead_letter' THEN blocked_limit ELSE NULL END,
           blocked_reason = CASE WHEN blocked_limit = 'dead_letter' THEN blocked_reason ELSE NULL END,
           updated_at = ?
         WHERE id = ? AND status = 'budget_blocked'`,
      ).bind(now, row.id),
    );
  }
  await env.DB.batch(statements);
  // An owner can repair a source-conflicted Change through the existing budget API, even with
  // the current budget unchanged. The same bound and guarded reset apply as automatic recovery.
  if (["verifying", "blocked", "awaiting_approval"].includes(row.status)) {
    await recoverSourceConflicts(env, row.id);
    // The same owner action composes a Change's stale Candidate again when nothing else runs.
    await recoverStaleCandidates(env, row.id);
  }
  const after = await loadChange(env, row.id);
  if (!after) return notFound(row.id);
  const raised = after.budget_usd > row.budget_usd;
  const resumed = row.status !== "running" && after.status === "running";
  // Dispatch reads only `running` Changes and wakes only ready Tasks not woken yet: safe to repeat.
  const dispatched =
    after.status === "running"
      ? await dispatchReadyTasks(env, contextOf(after), after.budget_usd)
      : [];
  if (raised || resumed) {
    console.warn(
      JSON.stringify({
        event: "change.budget_raised",
        changeId: row.id,
        actorUserId: input.actorUserId,
        fromUsd: row.budget_usd,
        toUsd: after.budget_usd,
        resumed,
        dispatched: dispatched.length,
      }),
    );
  }
  return recorded(after, !raised && !resumed, dispatched);
}

/** Remove a terminal request from future scope registrations. Safe on a repeat. */
export async function releaseRequestScope(
  env: Pick<Env, "PROJECT_ROOT">,
  projectId: string,
  changeId: string,
) {
  const roots = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  await roots.get(roots.idFromName(projectId)).release(changeId);
}

export type OverrideRequestOutcome =
  | { status: "recorded"; changeId: string; repeated: boolean }
  | { status: "refused"; reason: "not_found" | "not_overridable"; detail: string };

/** Fixed-length identity, stable across retries and concurrent owner choices. */
async function overrideChangeId(changeId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`owner-override:${changeId}`)),
  );
  return `chg_${[...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Internal RPC. The API must authorize the owner before calling this command. */
export async function overrideRequest(
  env: Env,
  input: { changeId: string; actorUserId: string },
): Promise<OverrideRequestOutcome> {
  const old = await env.DB.prepare(
    `SELECT c.*, p.org_id, p.slug FROM changes c JOIN projects p ON p.id = c.project_id WHERE c.id = ?`,
  )
    .bind(input.changeId)
    .first<
      ChangeRow & {
        goal: string;
        created_by: string;
        requester_rank: number | null;
        outcome: string | null;
      }
    >();
  if (!old) return { status: "refused", reason: "not_found", detail: "Request not found" };
  const changeId = await overrideChangeId(old.id);
  const existing = await env.DB.prepare(
    "SELECT id FROM changes WHERE id = ? AND supersedes_change_id = ?",
  )
    .bind(changeId, old.id)
    .first<{ id: string }>();
  if (!existing && !["not_selected", "awaiting_owner"].includes(old.status))
    return { status: "refused", reason: "not_overridable", detail: `Request is ${old.status}` };
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO changes (id, project_id, goal, status, base_generation, budget_usd,
      created_by, requester_rank, supersedes_change_id, outcome, outcome_decided_by, created_at, updated_at)
      SELECT ?, project_id, goal, 'created', (SELECT canonical_generation FROM projects WHERE id = changes.project_id),
        budget_usd, created_by, requester_rank, id, 'selected', ?, ?, ? FROM changes
      WHERE id = ? AND status IN ('not_selected', 'awaiting_owner')`).bind(
      changeId,
      input.actorUserId,
      now,
      now,
      old.id,
    ),
    env.DB.prepare(`UPDATE changes AS old SET status = 'not_selected', outcome = 'overridden', outcome_decided_by = ?, updated_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM changes WHERE id = ? AND supersedes_change_id = old.id)`).bind(
      input.actorUserId,
      now,
      old.id,
      changeId,
    ),
  ]);
  const created = await env.DB.prepare(
    "SELECT id, base_generation FROM changes WHERE id = ? AND supersedes_change_id = ?",
  )
    .bind(changeId, old.id)
    .first<{ id: string; base_generation: number }>();
  if (!created)
    return {
      status: "refused",
      reason: "not_overridable",
      detail: "Request changed before the owner choice was recorded",
    };
  const conflicts =
    await env.DB.prepare(`SELECT COALESCE(winner_change_id, CASE WHEN change_a = ? THEN change_b ELSE change_a END) AS winner_change_id FROM request_conflicts WHERE (change_a = ? OR change_b = ?)
    AND verdict = 'conflicting' AND (loser_change_id = ? OR winner_change_id IS NULL)`)
      .bind(old.id, old.id, old.id, old.id)
      .all<{ winner_change_id: string | null }>();
  for (const conflict of conflicts.results) {
    if (!conflict.winner_change_id) continue;
    const [first, second] = [changeId, conflict.winner_change_id].sort();
    const conflictId = `rc_${first}_${second}`;
    // Record the human decision as a new pair. The original pair remains immutable history.
    await env.DB.prepare(`INSERT OR IGNORE INTO request_conflicts
      (id, project_id, change_a, change_b, verdict, criteria_json, review_json, policy,
       winner_change_id, loser_change_id, decided_by, decided_at, created_at)
      VALUES (?, ?, ?, ?, 'conflicting', '[]', ?, 'owner_override', ?, ?, ?, ?, ?)`)
      .bind(
        conflictId,
        old.project_id,
        first,
        second,
        JSON.stringify({
          review: { verdict: "conflicting", conflicts: [], supported: true },
          receipt: {
            method: "owner-override",
            supersedesChangeId: old.id,
            actorUserId: input.actorUserId,
          },
          costUsd: 0,
        }),
        changeId,
        conflict.winner_change_id,
        input.actorUserId,
        now,
        now,
      )
      .run();
    await cancelChange(
      env,
      { changeId: conflict.winner_change_id, actorUserId: input.actorUserId },
      {
        reason: "Replaced by the owner's choice",
        winnerChangeId: changeId,
        decidedBy: input.actorUserId,
      },
    );
  }
  await releaseRequestScope(env, old.project_id, old.id);
  await appendChangeEvents(env.RESOURCE_SHARD, contextOf(old), [
    await changeEvent(
      contextOf(old),
      "conflict.reviewed",
      {
        status: "not_selected",
        outcome: "overridden",
        supersededBy: changeId,
        decidedBy: input.actorUserId,
      },
      { key: "owner-override", actor: { kind: "user", id: input.actorUserId } },
    ),
  ]);
  const nextCtx = { ...contextOf(old), changeId, baseGeneration: created.base_generation };
  await appendChangeEvents(env.RESOURCE_SHARD, nextCtx, [
    await changeEvent(
      nextCtx,
      "change.created",
      {
        goal: old.goal,
        supersedesChangeId: old.id,
        requesterUserId: old.created_by,
        requesterRank: old.requester_rank,
      },
      { actor: { kind: "user", id: input.actorUserId } },
    ),
  ]);
  await startWorkflowOnce(env.CHANGE_WORKFLOW, changeId, { changeId });
  return { status: "recorded", changeId, repeated: !!existing };
}
