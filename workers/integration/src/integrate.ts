import { dependsOnPath, type Integration, taskPairKey } from "@rhumbatron/conflict";
import type { ResourceShardDO } from "@rhumbatron/coordinator";
import { shardKey } from "@rhumbatron/coordinator/shard-key";
import type { TaskEdge } from "./candidate-composer.ts";
import { dispatchReadyTasks } from "./dispatch.ts";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";

/**
 * Integrate path for complementary Tasks. A fork conflict between
 * two Tasks of one Change on different semantic resources (`todos:api` and `todos:ui`) is not a
 * choice between designs: each side alone is incomplete. The conflict's fork decision is then
 * `integrate` (packages/conflict integrate.ts), and composition applies it here before any
 * Candidate exists: the dependent Task gets a Work Graph edge to the other Task and re-runs once on
 * a stacked workspace that includes the other Task's ChangeSet. The Change returns to `running`, so
 * no Candidate composes and no `verification.started` fires until the re-run completes.
 * Deterministic: no model call. Once per Task pair: a later conflict on an integrated pair follows
 * the fork rule.
 */

const ACTOR = { kind: "system", id: "candidate-composer" } as const;

/** An open fork conflict whose recorded fork decision is `integrate`. */
export type IntegrateConflict = Integration & { id: string };

/** What `applyIntegration` resets: the dependent Task, the Tasks built on it, and their ChangeSets. */
export type IntegrationPlan = IntegrateConflict & {
  /** The dependent Task and every Task that depends on it, sorted. */
  rerunTaskIds: string[];
  /** Proposed ChangeSets of the re-run Tasks, sorted; they become `rejected`. */
  rejectedChangeSetIds: string[];
};

/**
 * Pure: the first conflict (input order: oldest first) that can integrate now. Both Tasks have a
 * proposed ChangeSet, the pair was not integrated before, and the new edge closes no cycle.
 */
export function pickIntegration(
  conflicts: readonly IntegrateConflict[],
  proposed: readonly { id: string; taskId: string | null }[],
  edges: readonly TaskEdge[],
  integrated: ReadonlySet<string>,
): IntegrationPlan | null {
  const dependsOn: Record<string, string[]> = {};
  for (const e of edges)
    dependsOn[e.task_id] = [...(dependsOn[e.task_id] ?? []), e.depends_on_task_id];
  const hasChangeSet = (taskId: string) => proposed.some((c) => c.taskId === taskId);
  for (const c of conflicts) {
    if (c.dependentTaskId === c.dependsOnTaskId) continue;
    if (integrated.has(taskPairKey(c.dependentTaskId, c.dependsOnTaskId))) continue;
    if (!hasChangeSet(c.dependentTaskId) || !hasChangeSet(c.dependsOnTaskId)) continue;
    if (dependsOnPath(c.dependsOnTaskId, c.dependentTaskId, dependsOn)) continue;
    const rerun = new Set([c.dependentTaskId]);
    let size = 0;
    while (size !== rerun.size) {
      size = rerun.size;
      for (const e of edges) if (rerun.has(e.depends_on_task_id)) rerun.add(e.task_id);
    }
    const rerunTaskIds = [...rerun].sort();
    return {
      ...c,
      rerunTaskIds,
      rejectedChangeSetIds: proposed
        .filter((p) => p.taskId !== null && rerun.has(p.taskId))
        .map((p) => p.id)
        .sort(),
    };
  }
  return null;
}

/** Task pairs that an applied integration already joined (`review_json.integrate` is set). */
export async function loadIntegratedPairs(env: Pick<Env, "DB">, changeId: string) {
  const rows = await env.DB.prepare(
    `SELECT json_extract(fork_decision_json, '$.dependentTaskId') AS a,
            json_extract(fork_decision_json, '$.dependsOnTaskId') AS b
     FROM conflicts WHERE change_id = ? AND json_extract(review_json, '$.integrate.token') IS NOT NULL`,
  )
    .bind(changeId)
    .all<{ a: string | null; b: string | null }>();
  return new Set((rows.results ?? []).flatMap((r) => (r.a && r.b ? [taskPairKey(r.a, r.b)] : [])));
}

/**
 * One D1 transaction: resolves the conflict (fork decision `integrate`, `review_json.integrate`
 * with a token), adds the edge, rejects the re-run Tasks' ChangeSets and the open Candidates that
 * hold them, resolves the other open conflicts of the re-run Tasks (their Intents are replaced),
 * resets the re-run Tasks to `pending` with a new attempt window, moves the Change from
 * `verifying` to `running`, and records the `CONFLICT_INTEGRATION` Decision Receipt. Every
 * statement after the first only applies when the first one took this token. Then delivers the
 * event and the dispatch. Returns false when another run or a state change won.
 */
export async function applyIntegration(
  env: Pick<Env, "DB" | "RESOURCE_SHARD" | "AGENT_WAKEUPS">,
  changeId: string,
  plan: IntegrationPlan,
): Promise<boolean> {
  const now = new Date().toISOString();
  const token = crypto.randomUUID();
  const record = {
    token,
    at: now,
    dependentTaskId: plan.dependentTaskId,
    dependsOnTaskId: plan.dependsOnTaskId,
    reason: plan.reason,
    rerunTaskIds: plan.rerunTaskIds,
    rejectedChangeSetIds: plan.rejectedChangeSetIds,
    delivered: false,
  };
  const decision = {
    kind: "integrate",
    dependentTaskId: plan.dependentTaskId,
    dependsOnTaskId: plan.dependsOnTaskId,
    reason: plan.reason,
  };
  const owned = `EXISTS (SELECT 1 FROM conflicts WHERE id = ? AND json_extract(review_json, '$.integrate.token') = ?)`;
  const rerun = JSON.stringify(plan.rerunTaskIds);
  const rejected = JSON.stringify(plan.rejectedChangeSetIds);
  const receipt = {
    decisionType: "CONFLICT_INTEGRATION",
    conflictId: plan.id,
    changeId,
    decidedBy: "rules",
    dependentTaskId: plan.dependentTaskId,
    dependsOnTaskId: plan.dependsOnTaskId,
    rerunTaskIds: plan.rerunTaskIds,
    rejectedChangeSetIds: plan.rejectedChangeSetIds,
    reason: plan.reason,
    createdAt: now,
  };
  const [taken] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE conflicts SET state = 'resolved', fork_decision_json = ?,
         review_json = json_set(review_json, '$.integrate', json(?)), updated_at = ?
       WHERE id = ? AND change_id = ? AND state IN ('confirmed', 'fork_required')
         AND recommended_action = 'fork_candidates'
         AND json_extract(review_json, '$.integrate') IS NULL
         AND EXISTS (SELECT 1 FROM changes WHERE id = ? AND status = 'verifying')`,
    ).bind(JSON.stringify(decision), JSON.stringify(record), now, plan.id, changeId, changeId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id)
       SELECT ?, ? WHERE ${owned}`,
    ).bind(plan.dependentTaskId, plan.dependsOnTaskId, plan.id, token),
    env.DB.prepare(
      `UPDATE changesets SET status = 'rejected' WHERE change_id = ? AND status = 'proposed'
         AND id IN (SELECT value FROM json_each(?)) AND ${owned}`,
    ).bind(changeId, rejected, plan.id, token),
    env.DB.prepare(
      `UPDATE candidates SET status = 'rejected', status_reason = ?, updated_at = ?
       WHERE change_id = ? AND status IN ('composing', 'composed', 'verifying', 'verified', 'stale')
         AND EXISTS (SELECT 1 FROM json_each(change_set_ids_json) j WHERE j.value IN (SELECT value FROM json_each(?)))
         AND ${owned}`,
    ).bind(
      `Replaced: ${plan.reason}; the Task re-runs on the other Task's ChangeSet.`.slice(0, 500),
      now,
      changeId,
      rejected,
      plan.id,
      token,
    ),
    env.DB.prepare(
      `UPDATE conflicts SET state = 'resolved',
         review_json = json_set(review_json, '$.superseded', json(?)), updated_at = ?
       WHERE change_id = ? AND id != ? AND state IN ('suspected', 'confirmed', 'fork_required')
         AND EXISTS (SELECT 1 FROM json_each(intents_json) j
           WHERE json_extract(j.value, '$.taskId') IN (SELECT value FROM json_each(?)))
         AND ${owned}`,
    ).bind(
      JSON.stringify({ byConflictId: plan.id, at: now, reason: "the Task re-runs (integrate)" }),
      now,
      changeId,
      plan.id,
      rerun,
      plan.id,
      token,
    ),
    ...plan.rerunTaskIds.map((id) =>
      env.DB.prepare(
        `UPDATE tasks SET status = 'pending', assigned_agent_id = NULL, wake_sent_at = NULL,
           attempts_reset_at = ?, blocked_limit = NULL, blocked_reason = NULL,
           route_json = json_set(json_remove(COALESCE(route_json, '{}'), '$.rebase'), '$.integrate', json(?)),
           updated_at = ?
         WHERE id = ? AND change_id = ? AND ${owned}`,
      ).bind(
        now,
        JSON.stringify({
          conflictId: plan.id,
          withTaskId: plan.dependsOnTaskId,
          reason: plan.reason,
        }),
        now,
        id,
        changeId,
        plan.id,
        token,
      ),
    ),
    env.DB.prepare(
      `UPDATE changes SET status = 'running', updated_at = ?
       WHERE id = ? AND status = 'verifying' AND ${owned}`,
    ).bind(now, changeId, plan.id, token),
    env.DB.prepare(
      `INSERT OR IGNORE INTO decision_receipts (id, task_id, agent_id, decision_type, decided_by,
         selected_tier, receipt_json, created_at)
       SELECT ?, ?, ?, 'CONFLICT_INTEGRATION', 'rules', 'haiku', ?, ? WHERE ${owned}`,
    ).bind(
      `rcpt_int_${plan.id.slice(4)}`,
      plan.dependentTaskId,
      ACTOR.id,
      JSON.stringify(receipt),
      now,
      plan.id,
      token,
    ),
  ]);
  if ((taken?.meta.changes ?? 0) === 0) return false;
  await deliverIntegration(env, plan.id);
  return true;
}

type DeliveryRow = {
  id: string;
  change_id: string;
  challenge_id: string | null;
  integrate_json: string;
  project_id: string;
  org_id: string;
  slug: string;
  base_generation: number;
  budget_usd: number;
};

/**
 * Records `conflict.integrated`, resolves the conflict's Challenge, and dispatches the re-run
 * Tasks, then marks the integration delivered. Safe to repeat: the event ID is stable, a resolved
 * Challenge stays resolved, and dispatch is idempotent.
 */
async function deliverIntegration(
  env: Pick<Env, "DB" | "RESOURCE_SHARD" | "AGENT_WAKEUPS">,
  conflictId: string,
) {
  const row = await env.DB.prepare(
    `SELECT cf.id, cf.change_id, cf.challenge_id, json_extract(cf.review_json, '$.integrate') AS integrate_json,
            ch.project_id, ch.base_generation, ch.budget_usd, p.org_id, p.slug
     FROM conflicts cf JOIN changes ch ON ch.id = cf.change_id JOIN projects p ON p.id = ch.project_id
     WHERE cf.id = ?`,
  )
    .bind(conflictId)
    .first<DeliveryRow>();
  if (!row?.integrate_json) return;
  const record = JSON.parse(row.integrate_json) as {
    token: string;
    dependentTaskId: string;
    dependsOnTaskId: string;
    reason: string;
    rerunTaskIds: string[];
    rejectedChangeSetIds: string[];
  };
  const ctx: ChangeContext = {
    projectId: row.project_id,
    orgId: row.org_id,
    projectSlug: row.slug,
    changeId: row.change_id,
    baseGeneration: row.base_generation,
  };
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "conflict.integrated",
      {
        conflictId,
        dependentTaskId: record.dependentTaskId,
        dependsOnTaskId: record.dependsOnTaskId,
        rerunTaskIds: record.rerunTaskIds,
        rejectedChangeSetIds: record.rejectedChangeSetIds,
        reason: record.reason,
        status: "running",
      },
      { taskId: record.dependentTaskId, key: conflictId, actor: ACTOR },
    ),
  ]);
  if (row.challenge_id) {
    const ns = env.RESOURCE_SHARD as DurableObjectNamespace<ResourceShardDO>;
    const shard = ns.get(ns.idFromName(shardKey(ctx.projectId, `change:${ctx.changeId}`)));
    try {
      await shard.resolveChallenge(row.challenge_id, {
        outcome: "upheld",
        summary: `Integrated: ${record.reason}.`.slice(0, 2000),
        resolvedBy: ACTOR,
      });
    } catch {
      // The Challenge is a record for people; the integration stands without it.
    }
  }
  await dispatchReadyTasks(env, ctx, row.budget_usd);
  await env.DB.prepare(
    `UPDATE conflicts SET review_json = json_set(review_json, '$.integrate.delivered', json('true'))
     WHERE id = ? AND json_extract(review_json, '$.integrate.token') = ?`,
  )
    .bind(conflictId, record.token)
    .run();
}

/** Re-delivers applied integrations whose event or dispatch did not finish. Bounded. */
export async function recoverIntegrations(
  env: Pick<Env, "DB" | "RESOURCE_SHARD" | "AGENT_WAKEUPS">,
  changeId: string,
) {
  const rows = await env.DB.prepare(
    `SELECT id FROM conflicts WHERE change_id = ?
       AND json_extract(review_json, '$.integrate.token') IS NOT NULL
       AND COALESCE(json_extract(review_json, '$.integrate.delivered'), 0) = 0
     ORDER BY updated_at, id LIMIT 5`,
  )
    .bind(changeId)
    .all<{ id: string }>();
  for (const row of rows.results ?? []) await deliverIntegration(env, row.id);
}
