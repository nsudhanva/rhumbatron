import type { ProjectRootDO } from "@rhumbatron/coordinator";
import {
  type ChangeStatus,
  type ChooseOutcome,
  changeTitle,
  type FirstComeChoice,
  firstComeStep,
  type RequestWaitChoice,
} from "@rhumbatron/protocol";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";
import { startWorkflowOnce } from "./workflow-commands.ts";

/**
 * First-come conflicts between requests of different people (ADR 0032). A supported conflict makes
 * the later request `awaiting_choice`; the earlier request keeps working. Only the earlier
 * requester chooses:
 *
 * - `keep_mine`: the later request ends as `not_selected` with a reason that names the choice.
 * - `apply_theirs`: the later request is `queued`. When the earlier request promotes or ends, it
 *   returns to `compiling` at the current Canonical Generation and plans again on the current tree.
 *
 * `advanceFirstCome` is the one writer of these transitions. It is deterministic (`firstComeStep`)
 * and guarded on status, so the API command, the end of the earlier request, and the waiting
 * workflow each call it and reach the same state. The row in `request_choices` is the truth;
 * workflow events only shorten a wait.
 */

/** Workflow event that wakes a later request waiting on a choice or on the earlier request. */
export const FIRST_COME_EVENT = "first_come";
/** Who acts when the system ends or resumes a wait (no person chose). */
const SYSTEM_ACTOR = "system:first_come";
const WAITING: readonly ChangeStatus[] = ["awaiting_choice", "queued"];

type WaitRow = {
  id: string;
  project_id: string;
  first_change_id: string;
  later_change_id: string;
  asked_user_id: string;
  choice: RequestWaitChoice | null;
  chosen_by: string | null;
  workflow_instance_id: string | null;
  created_at: string;
  later_status: string;
  later_base: number;
  org_id: string;
  slug: string;
  first_status: string | null;
  first_goal: string | null;
  first_title: string | null;
  first_promoted: number;
  first_name: string | null;
  first_email: string | null;
};

const WAIT_SELECT = `SELECT w.id, w.project_id, w.first_change_id, w.later_change_id, w.asked_user_id,
    w.choice, w.chosen_by, w.workflow_instance_id, w.created_at,
    l.status AS later_status, l.base_generation AS later_base, p.org_id, p.slug,
    f.status AS first_status, f.goal AS first_goal, f.title AS first_title,
    EXISTS (SELECT 1 FROM candidates c WHERE c.change_id = w.first_change_id AND c.status = 'promoted')
      AS first_promoted,
    u.display_name AS first_name, u.email AS first_email
  FROM request_choices w
  JOIN changes l ON l.id = w.later_change_id
  JOIN projects p ON p.id = w.project_id
  LEFT JOIN changes f ON f.id = w.first_change_id
  LEFT JOIN users u ON u.id = w.asked_user_id`;

/** The newest wait of a later request: a request waits on one earlier request at a time. */
const loadWait = (env: Pick<Env, "DB">, laterChangeId: string) =>
  env.DB.prepare(`${WAIT_SELECT} WHERE w.later_change_id = ? ORDER BY w.created_at DESC LIMIT 1`)
    .bind(laterChangeId)
    .first<WaitRow>();

const contextOf = (row: WaitRow): ChangeContext => ({
  projectId: row.project_id,
  orgId: row.org_id,
  projectSlug: row.slug,
  changeId: row.later_change_id,
  baseGeneration: row.later_base,
});

const firstName = (row: WaitRow) =>
  row.first_name ?? row.first_email?.split("@")[0] ?? "The first requester";
const firstLabel = (row: WaitRow) => changeTitle(row.first_title, row.first_goal ?? "");

/** The reason that the later request shows when it ends without a build. */
function keptReason(name: string, title: string, choice: "keep_mine" | "expired") {
  return choice === "keep_mine"
    ? `Not selected: ${name} chose to keep their version of "${title}".`
    : `Not selected: ${name} did not choose within 7 days, so their version of "${title}" stays.`;
}

/** The reason on a later request that applies after the earlier one. */
const followsReason = (name: string, title: string) =>
  `${name} chose to apply this request after "${title}".`;

/**
 * Records the question for a supported conflict between different people and makes the later
 * request wait. Called from the request comparison. Idempotent: one row per pair, and the status
 * moves only from `compiling`. Returns the stored choice (null while open).
 */
export async function askFirstRequester(
  env: Env,
  ctx: ChangeContext,
  input: {
    firstChangeId: string;
    firstRequesterUserId: string;
    laterChangeId: string;
    conflictId: string;
    workflowInstanceId: string;
  },
): Promise<RequestWaitChoice | null> {
  const id = `rw_${input.firstChangeId}_${input.laterChangeId}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO request_choices
       (id, project_id, first_change_id, later_change_id, conflict_id, asked_user_id,
        workflow_instance_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      ctx.projectId,
      input.firstChangeId,
      input.laterChangeId,
      input.conflictId,
      input.firstRequesterUserId,
      input.workflowInstanceId,
      now,
    )
    .run();
  const stored = await env.DB.prepare("SELECT choice FROM request_choices WHERE id = ?")
    .bind(id)
    .first<{ choice: RequestWaitChoice | null }>();
  const choice = stored?.choice ?? null;
  if (choice !== null) return choice;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE request_choices SET workflow_instance_id = ? WHERE id = ? AND choice IS NULL",
    ).bind(input.workflowInstanceId, id),
    env.DB.prepare(
      "UPDATE changes SET status = 'awaiting_choice', updated_at = ? WHERE id = ? AND status = 'compiling'",
    ).bind(now, input.laterChangeId),
  ]);
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "change.choice.requested",
      {
        choiceId: id,
        firstChangeId: input.firstChangeId,
        askedUserId: input.firstRequesterUserId,
        conflictId: input.conflictId,
        status: "awaiting_choice",
      },
      { key: id },
    ),
  ]);
  return null;
}

/** Ends a waiting later request as `not_selected`, the earlier request as the winner. */
async function endKept(env: Env, row: WaitRow, choice: "keep_mine" | "expired") {
  const reason = keptReason(firstName(row), firstLabel(row), choice);
  const decidedBy = choice === "keep_mine" ? (row.chosen_by ?? row.asked_user_id) : SYSTEM_ACTOR;
  const now = new Date().toISOString();
  const ended = await env.DB.prepare(
    `UPDATE changes SET status = 'not_selected', outcome = 'not_selected', outcome_reason = ?,
       outcome_winner_change_id = ?, outcome_decided_by = ?, updated_at = ?
     WHERE id = ? AND status IN ('awaiting_choice', 'queued')`,
  )
    .bind(reason, row.first_change_id, decidedBy, now, row.later_change_id)
    .run();
  const ctx = contextOf(row);
  // The stable event ID makes a repeat after a partial failure harmless.
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "change.cancelled",
      { status: "not_selected", outcome: "not_selected", reason, fromStatus: row.later_status },
      {
        actor: { kind: choice === "keep_mine" ? "user" : "system", id: decidedBy },
        key: row.id,
      },
    ),
  ]);
  const roots = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  await roots.get(roots.idFromName(row.project_id)).release(row.later_change_id);
  if (ended.meta.changes) await wakeAfterFirst(env, row.later_change_id);
}

/** Returns the later request to planning at the current Canonical Generation. */
async function resume(env: Env, row: WaitRow) {
  const roots = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  const canonical = await roots.get(roots.idFromName(row.project_id)).getCanonical();
  const generation = canonical?.generation ?? row.later_base;
  const now = new Date().toISOString();
  const moved = await env.DB.prepare(
    `UPDATE changes SET status = 'compiling', base_generation = ?, updated_at = ?
     WHERE id = ? AND status IN ('awaiting_choice', 'queued')`,
  )
    .bind(generation, now, row.later_change_id)
    .run();
  if (!moved.meta.changes) return;
  const ctx = { ...contextOf(row), baseGeneration: generation };
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "change.resumed",
      { choiceId: row.id, firstChangeId: row.first_change_id, baseGeneration: generation },
      { key: row.id },
    ),
  ]);
}

/** Records a choice without a person (`expired`, `moot`) once, with its event. */
async function recordSystemChoice(env: Env, row: WaitRow, choice: "expired" | "moot") {
  const now = new Date().toISOString();
  const updated = await env.DB.prepare(
    "UPDATE request_choices SET choice = ?, chosen_by = ?, chosen_at = ? WHERE id = ? AND choice IS NULL",
  )
    .bind(choice, SYSTEM_ACTOR, now, row.id)
    .run();
  if (!updated.meta.changes) return;
  const ctx = contextOf(row);
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "change.choice.made",
      {
        choiceId: row.id,
        firstChangeId: row.first_change_id,
        choice,
        status: choice === "moot" ? "compiling" : "not_selected",
      },
      { actor: { kind: "system", id: SYSTEM_ACTOR }, key: row.id },
    ),
  ]);
}

/**
 * Applies the next step for one later request and returns its status after it. Safe to call any
 * number of times, from any caller.
 */
export async function advanceFirstCome(
  env: Env,
  laterChangeId: string,
  now = Date.now(),
): Promise<{ status: string; step: string }> {
  let row = await loadWait(env, laterChangeId);
  if (!row) {
    const change = await env.DB.prepare("SELECT status FROM changes WHERE id = ?")
      .bind(laterChangeId)
      .first<{ status: string }>();
    return { status: change?.status ?? "missing", step: "none" };
  }
  const step = firstComeStep({
    laterStatus: row.later_status,
    choice: row.choice,
    firstStatus: row.first_status,
    firstPromoted: row.first_promoted === 1,
    askedAt: row.created_at,
    now,
  });
  switch (step) {
    case "expire":
      await recordSystemChoice(env, row, "expired");
      await endKept(env, row, "expired");
      break;
    case "end_kept":
      await endKept(env, row, row.choice === "keep_mine" ? "keep_mine" : "expired");
      break;
    case "moot":
      await recordSystemChoice(env, row, "moot");
      await resume(env, row);
      break;
    case "queue":
      await env.DB.prepare(
        "UPDATE changes SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'awaiting_choice'",
      )
        .bind(new Date().toISOString(), row.later_change_id)
        .run();
      break;
    case "resume":
      await resume(env, row);
      break;
    default:
      break;
  }
  row = (await loadWait(env, laterChangeId)) ?? row;
  return { status: row.later_status, step };
}

/**
 * Sends the wake event to the waiting ChangeWorkflow instance. When that instance has ended, a
 * Change that must plan now continues in a new instance `<changeId>_f<n>`, started once.
 */
async function wakeWaiting(env: Env, laterChangeId: string) {
  const row = await loadWait(env, laterChangeId);
  if (!row) return;
  const instanceId = row.workflow_instance_id ?? laterChangeId;
  try {
    const instance = await env.CHANGE_WORKFLOW.get(instanceId);
    const { status } = await instance.status();
    if (!["complete", "errored", "terminated"].includes(status)) {
      await instance.sendEvent({ type: FIRST_COME_EVENT, payload: { choiceId: row.id } });
      return;
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "change.first_come_wake_failed",
        changeId: laterChangeId,
        message: String(error).slice(0, 200),
      }),
    );
  }
  if (row.later_status !== "compiling") return;
  const waits = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM request_choices WHERE later_change_id = ?",
  )
    .bind(laterChangeId)
    .first<{ n: number }>();
  await startWorkflowOnce(env.CHANGE_WORKFLOW, `${laterChangeId}_f${waits?.n ?? 1}`, {
    changeId: laterChangeId,
  });
}

/**
 * Called when a request ends (its scope is released): each later request that waits on it moves
 * on (a moot question, or a queued request that now plans), and its workflow wakes. Errors are
 * logged: the waiting workflow re-checks on its own schedule.
 */
export async function wakeAfterFirst(env: Env, firstChangeId: string) {
  try {
    const rows = await env.DB.prepare(
      `SELECT later_change_id FROM request_choices
       WHERE first_change_id = ? AND (choice IS NULL OR choice = 'apply_theirs')`,
    )
      .bind(firstChangeId)
      .all<{ later_change_id: string }>();
    for (const { later_change_id } of rows.results ?? []) {
      const { status } = await advanceFirstCome(env, later_change_id);
      if (!WAITING.includes(status as ChangeStatus)) await wakeWaiting(env, later_change_id);
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "change.first_come_followers_failed",
        changeId: firstChangeId,
        message: String(error).slice(0, 200),
      }),
    );
  }
}

/**
 * `POST /v1/changes/:changeId/choose`. The API checked that the actor is the earlier requester.
 * The guarded update records one choice; a repeat of the same choice is `repeated`, another choice
 * is refused. Then the transition applies and the waiting workflow wakes.
 */
export async function chooseFirstCome(
  env: Env,
  input: { changeId: string; actorUserId: string; choice: FirstComeChoice },
): Promise<ChooseOutcome> {
  const row = await loadWait(env, input.changeId);
  if (!row)
    return { result: "refused", reason: "not_found", detail: "No choice is open for this request" };
  if (row.asked_user_id !== input.actorUserId)
    return { result: "refused", reason: "not_found", detail: "No choice is open for you" };
  let repeated = false;
  if (row.choice !== null) {
    if (row.choice !== input.choice)
      return {
        result: "refused",
        reason: "already_chosen",
        detail: `The choice is already recorded: ${row.choice}.`,
      };
    repeated = true;
  } else if (!WAITING.includes(row.later_status as ChangeStatus)) {
    return {
      result: "refused",
      reason: "not_waiting",
      detail: `The request is ${row.later_status}; it does not wait for a choice.`,
    };
  } else {
    const now = new Date().toISOString();
    const statements = [
      env.DB.prepare(
        "UPDATE request_choices SET choice = ?, chosen_by = ?, chosen_at = ? WHERE id = ? AND choice IS NULL",
      ).bind(input.choice, input.actorUserId, now, row.id),
    ];
    if (input.choice === "apply_theirs")
      statements.push(
        env.DB.prepare(
          `UPDATE changes SET outcome = 'follows', outcome_reason = ?, outcome_winner_change_id = ?,
             outcome_decided_by = ?, updated_at = ?
           WHERE id = ? AND status IN ('awaiting_choice', 'queued')
             AND EXISTS (SELECT 1 FROM request_choices WHERE id = ? AND choice = 'apply_theirs')`,
        ).bind(
          followsReason(firstName(row), firstLabel(row)),
          row.first_change_id,
          input.actorUserId,
          now,
          row.later_change_id,
          row.id,
        ),
      );
    const [recorded] = await env.DB.batch(statements);
    if (!recorded?.meta.changes) {
      // Another submit recorded first: answer from the stored row.
      const after = await loadWait(env, input.changeId);
      if (after?.choice !== input.choice)
        return {
          result: "refused",
          reason: "already_chosen",
          detail: `The choice is already recorded: ${after?.choice ?? "unknown"}.`,
        };
      repeated = true;
    }
  }
  const ctx = contextOf(row);
  const next = input.choice === "keep_mine" ? "not_selected" : "queued";
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "change.choice.made",
      { choiceId: row.id, firstChangeId: row.first_change_id, choice: input.choice, status: next },
      { actor: { kind: "user", id: input.actorUserId }, key: row.id },
    ),
  ]);
  const { status } = await advanceFirstCome(env, input.changeId);
  await wakeWaiting(env, input.changeId);
  return {
    result: "recorded",
    changeId: input.changeId,
    choice: input.choice,
    status: status as ChangeStatus,
    repeated,
  };
}

/** Number of waits of a Change that ended with a plan (`apply_theirs` or `moot`). */
export async function resumedWaits(env: Pick<Env, "DB">, changeId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM request_choices WHERE later_change_id = ? AND choice IN ('apply_theirs', 'moot')",
  )
    .bind(changeId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** The stored choice of one earlier and later pair, or null when nobody was asked. */
export async function storedChoice(
  env: Pick<Env, "DB">,
  firstChangeId: string,
  laterChangeId: string,
): Promise<RequestWaitChoice | null | undefined> {
  const row = await env.DB.prepare(
    "SELECT choice FROM request_choices WHERE first_change_id = ? AND later_change_id = ?",
  )
    .bind(firstChangeId, laterChangeId)
    .first<{ choice: RequestWaitChoice | null }>();
  return row ? row.choice : undefined;
}
