import type { ProjectRootDO } from "@rhumbatron/coordinator";
import type {
  ChangeClarification,
  ChangeCommandOutcome,
  ChangeStatus,
  ClarifyChangeOutcome,
  ClarifyChangeRequest,
  ReviewChangeOutcome,
  TaskStatus,
} from "@rhumbatron/protocol";
import {
  CANCELLABLE_FROM,
  CHANGE_CANCELLED_REASON,
  canCancel,
  restoreAfterBudgetRaise,
  TERMINAL_CHANGE_STATUSES,
} from "./change-status.ts";
import { dispatchReadyTasks } from "./dispatch.ts";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";
import { answeredRounds, parseAnswers, type StoredAnswer } from "./intake-context.ts";
import { recoverSourceConflicts } from "./rebase.ts";
import { recoverStaleCandidates } from "./recompose.ts";
import { startWorkflowOnce } from "./workflow-commands.ts";

/**
 * A person's cancel, budget raise, and clarification answer on one Change (ADR 0025).
 * Called only
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

/**
 * A Change that waits for an answer (`needs_input`) can be cancelled too: it has no Tasks yet, or
 * its Tasks never started (the cross-request check runs before the Work Graph is stored). So can a
 * `proposed` request: the requester withdraws it before review (ADR 0028).
 */
const CANCEL_FROM: readonly ChangeStatus[] = [...CANCELLABLE_FROM, "needs_input", "proposed"];
/** A system decision (arbiter, same requester, intake) cancels as the system, not as a person. */
const actorKind = (decidedBy: string | undefined) =>
  decidedBy?.startsWith("system:") ? ("system" as const) : ("user" as const);

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
 * can pass the promotion preconditions. History stays: nothing is deleted.
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
            kind: actorKind(selection?.decidedBy),
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
    row.status !== "needs_input" &&
    row.status !== "proposed" &&
    !(selection && ["failed", "completed"].includes(row.status))
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
      JSON.stringify(selection ? [...CANCEL_FROM, "failed", "completed"] : CANCEL_FROM),
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
          kind: actorKind(selection?.decidedBy),
          id: input.actorUserId,
        },
      },
    ),
  ]);
  // A proposed request was never admitted to ProjectRootDO: nothing to release.
  if (row.status !== "proposed") await releaseRequestScope(env, row.project_id, row.id);
  return recorded(after, false);
}

/**
 * Statements that move a `budget_blocked` Change back to work (ADR 0030): its
 * budget-stopped Tasks return to `ready` or `pending` and the Change to `running`. A Change that
 * a budget stopped while planning has no Tasks: it returns to `compiling`, and `replan` asks the
 * caller to start planning again after the batch (`restartPlanning`). Every statement is guarded
 * on `budget_blocked`, so a concurrent resume or cancel applies nothing twice.
 */
async function budgetResumeStatements(
  env: Env,
  row: Pick<ChangeRow, "id">,
  now: string,
): Promise<{ statements: D1PreparedStatement[]; replan: boolean }> {
  const statements: D1PreparedStatement[] = [];
  const [tasks, deps] = await env.DB.batch([
    env.DB.prepare("SELECT id, status, blocked_limit FROM tasks WHERE change_id = ?").bind(row.id),
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
         attempts_reset_at = CASE WHEN ? = 1 THEN ? ELSE attempts_reset_at END,
         blocked_limit = NULL, blocked_reason = NULL, updated_at = ?
       WHERE id = ? AND status = 'blocked' AND ${blocked}`,
    ).bind(to, restore.newAttemptWindow.includes(id) ? 1 : 0, now, now, id, row.id);
  if (rows.length === 0) {
    statements.push(
      env.DB.prepare(
        `UPDATE changes SET status = 'compiling', blocked_limit = NULL, blocked_reason = NULL,
           updated_at = ? WHERE id = ? AND status = 'budget_blocked'`,
      ).bind(now, row.id),
    );
    return { statements, replan: true };
  }
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
  return { statements, replan: false };
}

/** Starts a new ChangeWorkflow instance for a Change that a budget stopped while planning. */
async function restartPlanning(env: Env, changeId: string) {
  const row = await env.DB.prepare("SELECT status FROM changes WHERE id = ?")
    .bind(changeId)
    .first<{ status: string }>();
  if (row?.status !== "compiling") return;
  await startWorkflowOnce(env.CHANGE_WORKFLOW, `${changeId}_b${Date.now().toString(36)}`, {
    changeId,
  });
}

/**
 * Resumes the Changes that a Project or a user monthly budget stopped (ADR 0030), after a person
 * raised that budget: `project_budget` stops of one Project, or `account_budget` stops of one
 * requester. The same restore as a Change budget raise. The admission checks run again on each
 * start, so a budget that is still used up stops the Change again with its name.
 */
export async function resumeBudgetBlocked(
  env: Env,
  input:
    | { limit: "project_budget"; projectId: string; actorUserId: string }
    | { limit: "account_budget"; userId: string; actorUserId: string },
): Promise<{ resumedChangeIds: string[] }> {
  const rows = await (input.limit === "project_budget"
    ? env.DB.prepare(
        `SELECT c.id, c.project_id, c.status, c.base_generation, c.budget_usd, p.org_id, p.slug
         FROM changes c JOIN projects p ON p.id = c.project_id
         WHERE c.project_id = ? AND c.status = 'budget_blocked' AND c.blocked_limit = 'project_budget'`,
      ).bind(input.projectId)
    : env.DB.prepare(
        `SELECT c.id, c.project_id, c.status, c.base_generation, c.budget_usd, p.org_id, p.slug
         FROM changes c JOIN projects p ON p.id = c.project_id
         WHERE c.created_by = ? AND c.status = 'budget_blocked' AND c.blocked_limit = 'account_budget'`,
      ).bind(input.userId)
  ).all<ChangeRow>();
  const resumedChangeIds: string[] = [];
  for (const row of rows.results ?? []) {
    const now = new Date().toISOString();
    const { statements, replan } = await budgetResumeStatements(env, row, now);
    const results = await env.DB.batch(statements);
    if (replan && results.at(-1)?.meta.changes) await restartPlanning(env, row.id);
    const after = await loadChange(env, row.id);
    if (after?.status === "running")
      await dispatchReadyTasks(env, contextOf(after), after.budget_usd);
    if (after && after.status !== "budget_blocked") resumedChangeIds.push(row.id);
  }
  if (resumedChangeIds.length > 0) {
    console.warn(
      JSON.stringify({
        event: "change.budget_resumed",
        limit: input.limit,
        actorUserId: input.actorUserId,
        changeIds: resumedChangeIds,
      }),
    );
  }
  return { resumedChangeIds };
}

/**
 * Raises a Change budget. A `budget_blocked` Change returns to `running`, the
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
  let replan = false;
  if (row.status === "budget_blocked") {
    const resumed = await budgetResumeStatements(env, row, now);
    statements.push(...resumed.statements);
    replan = resumed.replan;
  }
  const results = await env.DB.batch(statements);
  // Only the resume that moved the Change starts planning again.
  if (replan && results.at(-1)?.meta.changes) await restartPlanning(env, row.id);
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
  const resumed =
    row.status === "budget_blocked" && ["running", "compiling"].includes(after.status);
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

/* ------------------------------------------------------------------------------------------ */
/* Request review (ADR 0028)                                                                  */
/* ------------------------------------------------------------------------------------------ */

type ReviewRow = ChangeRow & { review_state: string | null };

const loadReviewRow = (env: Env, changeId: string) =>
  env.DB.prepare(
    `SELECT c.id, c.project_id, c.status, c.base_generation, c.budget_usd, c.review_state,
            p.org_id, p.slug
     FROM changes c JOIN projects p ON p.id = c.project_id WHERE c.id = ?`,
  )
    .bind(changeId)
    .first<ReviewRow>();

const notProposed = (row: ReviewRow, verb: string): ReviewChangeOutcome => ({
  result: "refused",
  reason: "not_proposed",
  detail: `Change is ${row.status}; only a proposed request can be ${verb}.`,
});

/**
 * Records `change.proposed` for a member's request that waits for review. The API inserted the
 * row as `proposed`; this only writes the fact. The stable event ID makes a repeat harmless.
 */
export async function recordProposal(
  env: Env,
  input: { changeId: string; actorUserId: string },
): Promise<{ recorded: boolean }> {
  const row = await loadReviewRow(env, input.changeId);
  if (!row || row.review_state === null) return { recorded: false };
  const ctx = contextOf(row);
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "change.proposed",
      {},
      { actor: { kind: "user", id: input.actorUserId } },
    ),
  ]);
  return { recorded: true };
}

/**
 * An owner or admin includes a `proposed` request. The guarded update moves it to `created` at the
 * current Canonical Generation and records who decided; then the ChangeWorkflow starts, the same
 * instance as for a request without review (instance ID = Change ID). A repeat, or a retry after a
 * partial failure, finds `review_state = included`, records the same event ID, and starts the
 * workflow only while the Change is still `created` (`startWorkflowOnce` returns the existing one).
 */
export async function includeChange(
  env: Env,
  input: { changeId: string; actorUserId: string },
): Promise<ReviewChangeOutcome> {
  const row = await loadReviewRow(env, input.changeId);
  if (!row) return { result: "refused", reason: "not_found", detail: "Change not found" };
  let moved = false;
  if (row.status === "proposed") {
    const roots = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
    const canonical = await roots.get(roots.idFromName(row.project_id)).getCanonical();
    const now = new Date().toISOString();
    const updated = await env.DB.prepare(
      `UPDATE changes SET status = 'created', review_state = 'included', review_decided_by = ?,
         review_decided_at = ?, base_generation = ?, updated_at = ?
       WHERE id = ? AND status = 'proposed'`,
    )
      .bind(input.actorUserId, now, canonical?.generation ?? row.base_generation, now, row.id)
      .run();
    moved = (updated.meta.changes ?? 0) > 0;
  }
  const after = moved ? await loadReviewRow(env, row.id) : row;
  if (!after) return { result: "refused", reason: "not_found", detail: "Change not found" };
  if (after.review_state !== "included") return notProposed(after, "included");
  const ctx = contextOf(after);
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "change.included",
      {},
      { actor: { kind: "user", id: input.actorUserId } },
    ),
  ]);
  if (after.status === "created") {
    await startWorkflowOnce(env.CHANGE_WORKFLOW, after.id, { changeId: after.id });
  }
  return { result: "recorded", changeId: after.id, status: after.status, repeated: !moved };
}

/**
 * An owner or admin declines a `proposed` request. `declined` is terminal: no workflow, no model
 * call. The reason is the review reason and the `declined` outcome reason. A repeat returns the
 * stored result.
 */
export async function declineChange(
  env: Env,
  input: { changeId: string; actorUserId: string; reason: string | null },
): Promise<ReviewChangeOutcome> {
  const row = await loadReviewRow(env, input.changeId);
  if (!row) return { result: "refused", reason: "not_found", detail: "Change not found" };
  let moved = false;
  if (row.status === "proposed") {
    const now = new Date().toISOString();
    const updated = await env.DB.prepare(
      `UPDATE changes SET status = 'declined', review_state = 'declined', review_decided_by = ?,
         review_decided_at = ?, review_reason = ?, outcome = 'declined', outcome_reason = ?,
         outcome_decided_by = ?, updated_at = ?
       WHERE id = ? AND status = 'proposed'`,
    )
      .bind(input.actorUserId, now, input.reason, input.reason, input.actorUserId, now, row.id)
      .run();
    moved = (updated.meta.changes ?? 0) > 0;
  }
  const after = moved ? await loadReviewRow(env, row.id) : row;
  if (!after) return { result: "refused", reason: "not_found", detail: "Change not found" };
  if (after.status !== "declined") return notProposed(after, "declined");
  const ctx = contextOf(after);
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "change.declined",
      { reason: input.reason },
      { actor: { kind: "user", id: input.actorUserId } },
    ),
  ]);
  return { result: "recorded", changeId: after.id, status: after.status, repeated: !moved };
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

/* ------------------------------------------------------------------------------------------ */
/* Clarification (ADR 0025)                                                                   */
/* ------------------------------------------------------------------------------------------ */

type ClarifyRow = ChangeRow & {
  goal: string;
  clarification_json: string | null;
  clarification_answers_json: string;
};

const loadClarifyRow = (env: Env, changeId: string) =>
  env.DB.prepare(
    `SELECT c.id, c.project_id, c.status, c.base_generation, c.budget_usd, c.goal,
            c.clarification_json, c.clarification_answers_json, p.org_id, p.slug
     FROM changes c JOIN projects p ON p.id = c.project_id WHERE c.id = ?`,
  )
    .bind(changeId)
    .first<ClarifyRow>();

function parseClarification(json: string | null): ChangeClarification | null {
  try {
    return json ? (JSON.parse(json) as ChangeClarification) : null;
  } catch {
    return null;
  }
}

/**
 * Ends a `needs_input` Change as `cancelled` with a reason: the requester withdrew it, or nobody
 * answered within 7 days. A duplicate keeps `outcome = duplicate` and the related Change as winner.
 * Guarded on `needs_input`, so it never cancels a Change that an answer already moved on.
 */
export async function closeNeedsInput(
  env: Env,
  input: { changeId: string; actorUserId: string; reason: string },
): Promise<boolean> {
  const row = await loadClarifyRow(env, input.changeId);
  if (!row) return false;
  const clarification = parseClarification(row.clarification_json);
  const duplicate = clarification?.kind === "duplicate";
  const now = new Date().toISOString();
  const [change] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE changes SET status = 'cancelled', blocked_reason = ?, outcome_reason = ?,
         outcome = CASE WHEN ? THEN 'duplicate' ELSE outcome END,
         outcome_winner_change_id = CASE WHEN ? THEN ? ELSE outcome_winner_change_id END,
         outcome_decided_by = CASE WHEN ? THEN ? ELSE outcome_decided_by END,
         updated_at = ?
       WHERE id = ? AND status = 'needs_input'`,
    ).bind(
      input.reason,
      input.reason,
      duplicate ? 1 : 0,
      duplicate ? 1 : 0,
      clarification?.relatedChangeId ?? null,
      duplicate ? 1 : 0,
      input.actorUserId,
      now,
      row.id,
    ),
    env.DB.prepare(
      `UPDATE tasks SET status = 'cancelled', updated_at = ?
       WHERE change_id = ? AND status IN ('pending', 'ready', 'assigned', 'running', 'blocked')
         AND EXISTS (SELECT 1 FROM changes WHERE id = ? AND status = 'cancelled')`,
    ).bind(now, row.id, row.id),
  ]);
  if (!change?.meta.changes) return false;
  const ctx = contextOf(row);
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "change.cancelled",
      {
        status: "cancelled",
        outcome: duplicate ? "duplicate" : null,
        reason: input.reason,
        fromStatus: "needs_input",
      },
      { actor: { kind: actorKind(input.actorUserId), id: input.actorUserId } },
    ),
  ]);
  await releaseRequestScope(env, row.project_id, row.id);
  return true;
}

/**
 * Wakes the ChangeWorkflow that waits for an answer. The waiting instance reads D1 itself, so the
 * event only shortens the wait; a lost event costs at most one daily re-check. A Change whose first
 * instance already ended continues in a new instance `<changeId>_r<round>`, started once.
 */
async function resumeChangeWorkflow(env: Env, changeId: string, round: number) {
  try {
    const instance = await env.CHANGE_WORKFLOW.get(changeId);
    const { status } = await instance.status();
    if (!["complete", "errored", "terminated"].includes(status)) {
      await instance.sendEvent({ type: "clarification", payload: { round } });
      return;
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "change.clarification_resume_failed",
        changeId,
        message: String(error).slice(0, 200),
      }),
    );
    return;
  }
  await startWorkflowOnce(env.CHANGE_WORKFLOW, `${changeId}_r${round}`, { changeId });
}

/** A repeat of the actor's last command returns it; anything else is refused. */
function notWaiting(
  row: ClarifyRow,
  action: "answers" | "proceed_anyway" | "withdraw",
  actorUserId: string,
): ClarifyChangeOutcome {
  const last = parseAnswers(row.clarification_answers_json).at(-1);
  const repeated =
    (action === "withdraw" && row.status === "cancelled") ||
    (action !== "withdraw" && last?.action === action && last.answeredBy === actorUserId);
  if (repeated)
    return {
      status: "recorded",
      changeId: row.id,
      changeStatus: row.status,
      action,
      round: Math.max(1, Math.min(3, last?.round ?? 1)),
      repeated: true,
    };
  return {
    status: "refused",
    reason: "not_waiting",
    detail: `Change is ${row.status}; it is not waiting for an answer.`,
  };
}

/**
 * `POST /v1/changes/:changeId/clarify`. The API authenticated the actor and checked that the actor
 * is the requester or the Project owner. Answers append to `clarification_answers_json` (the goal
 * context of the next intake and planning), `proceed_anyway` plans without another question this
 * round, `withdraw` cancels. Guarded on the open round: a second submit of the same round is
 * `repeated`, and only one answer per round is stored.
 */
export async function clarifyChange(
  env: Env,
  input: { changeId: string; actorUserId: string; request: ClarifyChangeRequest },
): Promise<ClarifyChangeOutcome> {
  const row = await loadClarifyRow(env, input.changeId);
  if (!row) return { status: "refused", reason: "not_found", detail: "Change not found" };
  const action =
    "answers" in input.request
      ? ("answers" as const)
      : input.request.action === "withdraw"
        ? ("withdraw" as const)
        : ("proceed_anyway" as const);
  const clarification = parseClarification(row.clarification_json);
  const answers = parseAnswers(row.clarification_answers_json);
  if (row.status !== "needs_input" || !clarification)
    return notWaiting(row, action, input.actorUserId);
  const round = clarification.round;
  const ctx = contextOf(row);
  if (action === "withdraw") {
    await closeNeedsInput(env, {
      changeId: row.id,
      actorUserId: input.actorUserId,
      reason: "Withdrawn by the requester",
    });
    await resumeChangeWorkflow(env, row.id, round);
    const after = await loadChange(env, row.id);
    return {
      status: "recorded",
      changeId: row.id,
      changeStatus: after?.status ?? "cancelled",
      action,
      round,
      repeated: false,
    };
  }
  const now = new Date().toISOString();
  let entries: StoredAnswer[];
  if ("answers" in input.request) {
    const questions = new Map(clarification.questions.map((q) => [q.id, q.text]));
    const unknown = input.request.answers.find((a) => !questions.has(a.questionId));
    if (unknown)
      return {
        status: "refused",
        reason: "unknown_question",
        detail: `Question ${unknown.questionId} is not part of round ${round}.`,
      };
    entries = input.request.answers.map((a) => ({
      round,
      action: "answers",
      questionId: a.questionId,
      question: questions.get(a.questionId) ?? "",
      text: a.text,
      answeredBy: input.actorUserId,
      answeredAt: now,
    }));
  } else {
    entries = [{ round, action: "proceed_anyway", answeredBy: input.actorUserId, answeredAt: now }];
  }
  // Read-modify-write guarded on the open round: of two concurrent answers, one applies.
  const updated = await env.DB.prepare(
    `UPDATE changes SET status = 'compiling', clarification_json = NULL,
       clarification_answers_json = ?, updated_at = ?
     WHERE id = ? AND status = 'needs_input' AND clarification_answers_json = ?
       AND json_extract(clarification_json, '$.round') = ?`,
  )
    .bind(
      JSON.stringify([...answers, ...entries]),
      now,
      row.id,
      row.clarification_answers_json,
      round,
    )
    .run();
  if (!updated.meta.changes) {
    const after = await loadClarifyRow(env, row.id);
    if (!after) return { status: "refused", reason: "not_found", detail: "Change not found" };
    return notWaiting(after, action, input.actorUserId);
  }
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "change.clarification.answered",
      {
        round,
        action,
        kind: clarification.kind,
        questionIds: entries.flatMap((e) => (e.questionId ? [e.questionId] : [])),
        answeredRounds: answeredRounds([...answers, ...entries]),
      },
      { key: `answer-${round}`, actor: { kind: "user", id: input.actorUserId } },
    ),
  ]);
  await resumeChangeWorkflow(env, row.id, round);
  return {
    status: "recorded",
    changeId: row.id,
    changeStatus: "compiling",
    action,
    round,
    repeated: false,
  };
}
