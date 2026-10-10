import type { ChangeCommandOutcome, ChangeStatus, TaskStatus } from "@rhumbatron/protocol";
import {
  CANCELLABLE_FROM,
  canCancel,
  restoreAfterBudgetRaise,
  TERMINAL_CHANGE_STATUSES,
} from "./change-status.ts";
import { dispatchReadyTasks } from "./dispatch.ts";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";

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
): Promise<ChangeCommandOutcome> {
  const row = await loadChange(env, input.changeId);
  if (!row) return notFound(input.changeId);
  if (row.status === "cancelled") return recorded(row, true);
  if (!canCancel(row.status)) {
    return {
      status: "refused",
      reason: "not_cancellable",
      detail: `Change is ${row.status}; only a Change that has not started promotion can be cancelled.`,
    };
  }
  const now = new Date().toISOString();
  // One batch is one transaction. The Task and Candidate updates apply only once the Change is
  // cancelled, so a lost race against promotion changes nothing.
  const cancelled = `EXISTS (SELECT 1 FROM changes WHERE id = ? AND status = 'cancelled')`;
  const [change, tasks, candidates] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE changes SET status = 'cancelled', updated_at = ?
       WHERE id = ? AND status IN (SELECT value FROM json_each(?))`,
    ).bind(now, row.id, JSON.stringify(CANCELLABLE_FROM)),
    env.DB.prepare(
      `UPDATE tasks SET status = 'cancelled', updated_at = ?
       WHERE change_id = ? AND status IN ('pending', 'ready', 'assigned', 'running', 'blocked')
         AND ${cancelled}`,
    ).bind(now, row.id, row.id),
    env.DB.prepare(
      `UPDATE candidates SET status = 'rejected', status_reason = 'The Change was cancelled.',
         updated_at = ?
       WHERE change_id = ? AND status IN ('composing', 'composed', 'verifying', 'verified')
         AND ${cancelled}`,
    ).bind(now, row.id, row.id),
  ]);
  const after = await loadChange(env, row.id);
  if (!after) return notFound(row.id);
  if (!change?.meta.changes) {
    // Another request moved the Change first.
    return after.status === "cancelled"
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
        fromStatus: row.status,
        cancelledTasks: tasks?.meta.changes ?? 0,
        rejectedCandidates: candidates?.meta.changes ?? 0,
      },
      { actor: { kind: "user", id: input.actorUserId } },
    ),
  ]);
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
           blocked_limit = NULL, blocked_reason = NULL, updated_at = ?
         WHERE id = ? AND status = 'blocked' AND ${blocked}`,
      ).bind(to, now, id, row.id);
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
  const after = await loadChange(env, row.id);
  if (!after) return notFound(row.id);
  const raised = after.budget_usd > row.budget_usd;
  const resumed = row.status === "budget_blocked" && after.status === "running";
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
