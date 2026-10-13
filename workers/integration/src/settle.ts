import type { ProjectRootDO } from "@rhumbatron/coordinator";
import { requestAcceptanceRepair } from "./acceptance-repair.ts";
import { releaseRequestScope } from "./change-commands.ts";
import { dispatchReadyTasks } from "./dispatch.ts";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";
import { recoverSourceConflicts } from "./rebase.ts";

/**
 * Settles a Change that has no Task left to run. Two dead ends end here:
 *
 * - A Task fails with `dependency_merge_conflict`: two of its dependencies were built in parallel
 *   on the same base, and their ChangeSets do not merge. The dependency that did not merge gets
 *   Work Graph edges to the dependencies before it and re-runs on a workspace stacked on their
 *   ChangeSets, with the Tasks built on it. Same mechanism as integrate.ts. When the ChangeSet
 *   does not merge with the canonical base (another request promoted while this Change ran), it
 *   and the Tasks built on it re-run on the current canonical state instead, and the Change takes
 *   the new base generation. At most MAX_TASK_RESTACKS of both per Change.
 * - Any other failed Task, or a restack that is not possible: when no Task is pending, ready,
 *   assigned, or running, the Change ends `failed` with the Task's reason, and `change.failed`
 *   records it. A `verifying` Change whose Candidates are all rejected by a merge that no rebase
 *   re-runs ends the same way.
 *
 * Deterministic: no model call. Triggered by `task.failed` (event router) and by the stuck-Change
 * sweep. Safe to repeat: each write is conditional and the receipt ID is stable per restack.
 */

export const MAX_TASK_RESTACKS = 2;
const ACTIVE = new Set(["pending", "ready", "assigned", "running"]);
const LIVE_CANDIDATE = new Set([
  "composing",
  "composed",
  "verifying",
  "verified",
  "promoted",
  "stale",
]);
/** A `verifying` Change settles only after this quiet time: composition may still be on its way. */
const VERIFYING_QUIET_MS = 2 * 60_000;
const ACTOR = { kind: "system", id: "change-settle" } as const;

type SettleEnv = Env;
type Edge = { task_id: string; depends_on_task_id: string };

/** The ChangeSet that did not merge and the ChangeSets before it (agents workspace.ts message). */
export function dependencyConflict(
  reason: string | null,
): { changeSetId: string; before: string[] } | null {
  const m = /^dependency_merge_conflict: (cs_[\w-]+) does not merge with (.+?) \(/.exec(
    reason ?? "",
  );
  if (!m?.[1] || !m[2]) return null;
  return {
    changeSetId: m[1],
    before: m[2].split(", ").filter((id) => /^cs_[\w-]+$/.test(id)),
  };
}

/**
 * Pure: the restack of `rootTaskId` onto `ontoTaskIds`. The re-run set is the root and every Task
 * built on it. A target in the re-run set would close a cycle, so it is left out. Null when no
 * target remains.
 */
export function planTaskRestack(
  rootTaskId: string,
  ontoTaskIds: readonly string[],
  edges: readonly Edge[],
): { rerunTaskIds: string[]; onto: string[] } | null {
  const rerun = withDependents(rootTaskId, edges);
  const onto = [...new Set(ontoTaskIds)].filter((t) => !rerun.includes(t)).sort();
  if (onto.length === 0) return null;
  return { rerunTaskIds: rerun, onto };
}

/** The Task and every Task built on it, sorted. */
function withDependents(rootTaskId: string, edges: readonly Edge[]): string[] {
  const rerun = new Set([rootTaskId]);
  let size = 0;
  while (size !== rerun.size) {
    size = rerun.size;
    for (const e of edges) if (rerun.has(e.depends_on_task_id)) rerun.add(e.task_id);
  }
  return [...rerun].sort();
}

type ChangeRow = {
  id: string;
  status: string;
  project_id: string;
  base_generation: number;
  budget_usd: number;
  updated_at: string;
  org_id: string;
  slug: string;
  project_status: string;
};
type TaskRow = { id: string; status: string; semantic_resource: string | null };

export type SettleOutcome =
  | "skipped"
  | "waiting"
  | "dispatched"
  | "restacked"
  | "rebased"
  | "failed"
  | "nothing";

export async function settleChange(env: SettleEnv, changeId: string): Promise<SettleOutcome> {
  const change = await env.DB.prepare(
    `SELECT ch.id, ch.status, ch.project_id, ch.base_generation, ch.budget_usd, ch.updated_at,
            p.org_id, p.slug, p.status AS project_status
     FROM changes ch JOIN projects p ON p.id = ch.project_id WHERE ch.id = ?`,
  )
    .bind(changeId)
    .first<ChangeRow>();
  if (change?.project_status !== "active") return "skipped";
  const ctx: ChangeContext = {
    projectId: change.project_id,
    orgId: change.org_id,
    projectSlug: change.slug,
    changeId,
    baseGeneration: change.base_generation,
  };
  if (change.status === "verifying") return settleVerifying(env, change, ctx);
  if (change.status !== "running") return "skipped";

  const [taskRows, edgeRows] = await env.DB.batch([
    env.DB.prepare("SELECT id, status, semantic_resource FROM tasks WHERE change_id = ?").bind(
      changeId,
    ),
    env.DB.prepare(
      `SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d
       JOIN tasks t ON t.id = d.task_id WHERE t.change_id = ?`,
    ).bind(changeId),
  ]);
  const tasks = (taskRows?.results ?? []) as TaskRow[];
  const edges = (edgeRows?.results ?? []) as Edge[];
  const busy = tasks.some((t) => t.status === "assigned" || t.status === "running");
  const failed = tasks.filter((t) => t.status === "failed");

  for (const task of failed) {
    const run = await lastRun(env, task.id);
    if (run?.failure_kind !== "dependency_merge_conflict") continue;
    const restacked = await restack(env, ctx, change, task.id, run.reason, edges);
    if (restacked) return "restacked";
  }
  if (busy) return "waiting";
  // A reset or a deferred wake left Tasks that can run but no wake in flight.
  if (failed.length === 0) {
    if (!tasks.some((t) => t.status === "pending" || t.status === "ready")) return "nothing";
    const woke = await dispatchReadyTasks(env, ctx, change.budget_usd);
    return woke.length > 0 ? "dispatched" : "nothing";
  }
  if (tasks.some((t) => ACTIVE.has(t.status) && t.status !== "pending")) return "waiting";
  // Pending Tasks below a failed Task never become ready.
  const first = failed[0] as TaskRow;
  const run = await lastRun(env, first.id);
  const what = (run?.reason ?? "it stopped").replace(/\.$/, "");
  const name = first.semantic_resource?.split(":").slice(-2).join(":") ?? first.id;
  const text = `The Task on ${name} failed: ${what}`;
  const reason = `${text.length > 400 ? `${text.slice(0, 399)}…` : text}. Submit the request again.`;
  return endFailed(env, ctx, "running", reason, "tasks");
}

async function lastRun(env: SettleEnv, taskId: string) {
  const row = await env.DB.prepare(
    `SELECT failure_kind, outcome_json FROM task_runs WHERE task_id = ?
     ORDER BY attempt DESC, started_at DESC LIMIT 1`,
  )
    .bind(taskId)
    .first<{ failure_kind: string | null; outcome_json: string | null }>();
  if (!row) return null;
  let reason: string | null = null;
  try {
    const outcome = JSON.parse(row.outcome_json ?? "{}") as { reason?: unknown };
    reason = typeof outcome.reason === "string" ? outcome.reason : null;
  } catch {
    reason = null;
  }
  return { failure_kind: row.failure_kind, reason };
}

async function restack(
  env: SettleEnv,
  ctx: ChangeContext,
  change: ChangeRow,
  failedTaskId: string,
  reason: string | null,
  edges: readonly Edge[],
): Promise<boolean> {
  const conflict = dependencyConflict(reason);
  if (!conflict) return false;
  const sets = await env.DB.prepare(
    `SELECT cs.id, cs.status, r.task_id FROM changesets cs
     JOIN task_runs r ON r.id = 'run_' || substr(cs.id, 4) WHERE cs.change_id = ?`,
  )
    .bind(change.id)
    .all<{ id: string; status: string; task_id: string }>();
  const byId = new Map((sets.results ?? []).map((s) => [s.id, s]));
  const root = byId.get(conflict.changeSetId)?.task_id;
  if (!root) return false;
  // No ChangeSet before it: the ChangeSet does not merge with the canonical base, which moved.
  let rebase: { fromGeneration: number; toGeneration: number } | null = null;
  let plan: { rerunTaskIds: string[]; onto: string[] } | null;
  if (conflict.before.length === 0) {
    const roots = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
    const canonical = await roots.get(roots.idFromName(change.project_id)).getCanonical();
    if (!canonical || canonical.generation <= change.base_generation) return false;
    rebase = { fromGeneration: change.base_generation, toGeneration: canonical.generation };
    plan = { rerunTaskIds: withDependents(root, edges), onto: [] };
  } else {
    plan = planTaskRestack(
      root,
      conflict.before.flatMap((id) => byId.get(id)?.task_id ?? []),
      edges,
    );
  }
  if (!plan?.rerunTaskIds.includes(failedTaskId)) return false;
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM decision_receipts WHERE decision_type = 'TASK_RESTACK'
       AND json_extract(receipt_json, '$.changeId') = ?`,
  )
    .bind(change.id)
    .first<{ n: number }>();
  const n = count?.n ?? 0;
  if (n >= MAX_TASK_RESTACKS) return false;

  const now = new Date().toISOString();
  const token = crypto.randomUUID();
  const receiptId = `rcpt_rst_${change.id.slice(4)}_${n + 1}`;
  const rejected = (sets.results ?? [])
    .filter((s) => s.status === "proposed" && plan.rerunTaskIds.includes(s.task_id))
    .map((s) => s.id)
    .sort();
  const withTaskId = plan.onto[plan.onto.length - 1] as string;
  const why = `its ChangeSet did not merge with the work of ${plan.onto.length === 1 ? "that Task" : `${plan.onto.length} other Tasks`} built in parallel; build on top of it`;
  const receipt = {
    decisionType: "TASK_RESTACK",
    token,
    changeId: change.id,
    decidedBy: "rules",
    dependentTaskId: root,
    dependsOnTaskIds: plan.onto,
    rerunTaskIds: plan.rerunTaskIds,
    rejectedChangeSetIds: rejected,
    ...(rebase ? { rebase } : {}),
    reason,
    createdAt: now,
  };
  const owned = `EXISTS (SELECT 1 FROM decision_receipts WHERE id = ? AND json_extract(receipt_json, '$.token') = ?)`;
  const rerun = JSON.stringify(plan.rerunTaskIds);
  const [taken] = await env.DB.batch([
    // The receipt is the lock: one restack per number, never over a Task that is still working.
    env.DB.prepare(
      `INSERT OR IGNORE INTO decision_receipts (id, task_id, agent_id, decision_type, decided_by,
         selected_tier, receipt_json, created_at)
       SELECT ?, ?, ?, 'TASK_RESTACK', 'rules', 'haiku', ?, ?
       WHERE EXISTS (SELECT 1 FROM changes WHERE id = ? AND status = 'running')
         AND NOT EXISTS (SELECT 1 FROM tasks WHERE change_id = ? AND status IN ('assigned', 'running')
           AND id IN (SELECT value FROM json_each(?)))`,
    ).bind(receiptId, root, ACTOR.id, JSON.stringify(receipt), now, change.id, change.id, rerun),
    ...plan.onto.map((dependsOn) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id)
         SELECT ?, ? WHERE ${owned}`,
      ).bind(root, dependsOn, receiptId, token),
    ),
    env.DB.prepare(
      `UPDATE changesets SET status = 'rejected' WHERE change_id = ? AND status = 'proposed'
         AND id IN (SELECT value FROM json_each(?)) AND ${owned}`,
    ).bind(change.id, JSON.stringify(rejected), receiptId, token),
    env.DB.prepare(
      `UPDATE conflicts SET state = 'resolved',
         review_json = json_set(COALESCE(review_json, '{}'), '$.superseded', json(?)), updated_at = ?
       WHERE change_id = ? AND state IN ('suspected', 'confirmed', 'fork_required')
         AND EXISTS (SELECT 1 FROM json_each(intents_json) j
           WHERE json_extract(j.value, '$.taskId') IN (SELECT value FROM json_each(?)))
         AND ${owned}`,
    ).bind(
      JSON.stringify({ byReceiptId: receiptId, at: now, reason: "the Task re-runs (restack)" }),
      now,
      change.id,
      rerun,
      receiptId,
      token,
    ),
    // Instructions (agents agent-do.ts): a moved base gives every re-run Task the rebase
    // instruction; a stack gives the root the integrate instruction.
    ...(rebase
      ? [
          env.DB.prepare(
            `UPDATE tasks SET route_json = json_set(json_remove(COALESCE(route_json, '{}'), '$.integrate'),
               '$.rebase', json(?)) WHERE change_id = ? AND id IN (SELECT value FROM json_each(?)) AND ${owned}`,
          ).bind(JSON.stringify(rebase), change.id, rerun, receiptId, token),
        ]
      : [
          env.DB.prepare(
            `UPDATE tasks SET route_json = json_set(json_remove(COALESCE(route_json, '{}'), '$.rebase'),
               '$.integrate', json(?)) WHERE id = ? AND change_id = ? AND ${owned}`,
          ).bind(JSON.stringify({ withTaskId, reason: why }), root, change.id, receiptId, token),
        ]),
    ...plan.rerunTaskIds.map((id) =>
      env.DB.prepare(
        `UPDATE tasks SET status = 'pending', assigned_agent_id = NULL, wake_sent_at = NULL,
           attempts_reset_at = ?, blocked_limit = NULL, blocked_reason = NULL,
           route_json = ${rebase || id === root ? "route_json" : "json_remove(COALESCE(route_json, '{}'), '$.integrate', '$.rebase')"},
           updated_at = ?
         WHERE id = ? AND change_id = ? AND ${owned}`,
      ).bind(now, now, id, change.id, receiptId, token),
    ),
    env.DB.prepare(
      `UPDATE changes SET base_generation = ?, updated_at = ? WHERE id = ? AND ${owned}`,
    ).bind(rebase?.toGeneration ?? change.base_generation, now, change.id, receiptId, token),
  ]);
  if ((taken?.meta.changes ?? 0) === 0) return false;
  if (rebase) {
    const moved = { ...ctx, baseGeneration: rebase.toGeneration };
    await appendChangeEvents(env.RESOURCE_SHARD, moved, [
      await changeEvent(
        moved,
        "candidate.rebase_requested",
        {
          trigger: "dependency_merge_conflict",
          reason,
          status: "running",
          taskIds: plan.rerunTaskIds,
          baseGeneration: rebase.toGeneration,
          rebaseCount: n + 1,
          maxRebases: MAX_TASK_RESTACKS,
        },
        { taskId: root, key: receiptId, actor: ACTOR },
      ),
    ]);
    await dispatchReadyTasks(env, moved, change.budget_usd);
    return true;
  }
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "conflict.integrated",
      {
        trigger: "dependency_merge_conflict",
        dependentTaskId: root,
        dependsOnTaskId: withTaskId,
        dependsOnTaskIds: plan.onto,
        rerunTaskIds: plan.rerunTaskIds,
        rejectedChangeSetIds: rejected,
        reason: why,
        status: "running",
      },
      { taskId: root, key: receiptId, actor: ACTOR },
    ),
  ]);
  await dispatchReadyTasks(env, ctx, change.budget_usd);
  return true;
}

/** A `verifying` Change whose Candidates are all rejected by a merge that no rebase re-runs. */
async function settleVerifying(
  env: SettleEnv,
  change: ChangeRow,
  ctx: ChangeContext,
): Promise<SettleOutcome> {
  if (Date.now() - Date.parse(change.updated_at) < VERIFYING_QUIET_MS) return "waiting";
  const outcomes = await recoverSourceConflicts(env, change.id);
  if (outcomes.some((o) => o.status !== "skipped")) return "rebased";
  const rows = await env.DB.prepare(
    "SELECT status, status_reason FROM candidates WHERE change_id = ? ORDER BY created_at DESC",
  )
    .bind(change.id)
    .all<{ status: string; status_reason: string | null }>();
  const candidates = rows.results ?? [];
  if (candidates.length === 0 || candidates.some((c) => LIVE_CANDIDATE.has(c.status)))
    return "waiting";
  // A person rejected the newest Candidate with a reason: its repair runs before any end.
  const asked = await env.DB.prepare(
    `SELECT a.candidate_id, a.reason FROM approvals a JOIN candidates c ON c.id = a.candidate_id
     WHERE c.change_id = ? AND a.decision = 'rejected' AND COALESCE(a.reason, '') != ''
     ORDER BY c.created_at DESC LIMIT 1`,
  )
    .bind(change.id)
    .first<{ candidate_id: string; reason: string }>();
  if (
    asked &&
    (await requestAcceptanceRepair(env, {
      candidateId: asked.candidate_id,
      reason: asked.reason,
      trigger: "approver",
    }))
  )
    return "restacked";
  // The newest Candidate says why the Change ends; an earlier merge rejection may be repaired.
  const newest = candidates[0] as { status: string; status_reason: string | null };
  const why = (newest.status_reason ?? "rejected").replace(/\.$/, "");
  const text = /^(?:file_conflict|source_conflict):/.test(why)
    ? `The agents' work did not merge (${why})`
    : `No Candidate passed its required checks: ${why}`;
  const reason = `${text.length > 400 ? `${text.slice(0, 399)}…` : text}. Submit the request again.`;
  return endFailed(env, ctx, "verifying", reason, "verification");
}

async function endFailed(
  env: SettleEnv,
  ctx: ChangeContext,
  from: "running" | "verifying",
  reason: string,
  phase: "tasks" | "verification",
): Promise<SettleOutcome> {
  const now = new Date().toISOString();
  const guard =
    from === "running"
      ? `AND NOT EXISTS (SELECT 1 FROM tasks WHERE change_id = changes.id
           AND status IN ('ready', 'assigned', 'running'))`
      : "";
  const result = await env.DB.prepare(
    `UPDATE changes SET status = 'failed', blocked_reason = ?, updated_at = ?
     WHERE id = ? AND status = ? ${guard}`,
  )
    .bind(reason, now, ctx.changeId, from)
    .run();
  if ((result.meta.changes ?? 0) === 0) return "waiting";
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "change.failed",
      { status: "failed", phase, reason },
      { key: `settle-${phase}`, actor: ACTOR },
    ),
  ]);
  await releaseRequestScope(env, ctx.projectId, ctx.changeId);
  return "failed";
}
