import type { ProjectRootDO } from "@rhumbatron/coordinator";
import { requestCannotShip } from "./app-release-model.ts";
import { dispatchReadyTasks } from "./dispatch.ts";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";

const MAX_REBASE_RERUNS = 2;
export const REBASE_BLOCKED_REASON =
  "The request could not be merged with newer changes twice. Submit it again.";
type RebaseEnv = Pick<Env, "DB" | "PROJECT_ROOT" | "RESOURCE_SHARD" | "AGENT_WAKEUPS">;
type Receipt = {
  token: string;
  requested: boolean;
  count: number;
  baseGeneration: number;
  fromGeneration: number;
  resetAt: string;
  taskIds: string[];
  reason: string;
  delivered?: boolean;
};
type Row = {
  id: string;
  change_id: string;
  status: string;
  status_reason: string | null;
  score_json: string | null;
  recomposed_from: string | null;
  rollback_of_generation: number | null;
  change_status: string;
  outcome: string | null;
  project_id: string;
  project_status: string;
  org_id: string;
  slug: string;
  budget_usd: number;
};

/** Only a source merge rejection identifies the work to redo; never retry check or tool errors. */
export function failedMergeChangeSet(reason: string | null): string | null {
  return (
    /^(?:file_conflict|source_conflict): (cs_[\w-]+) does not merge\b/.exec(reason ?? "")?.[1] ??
    null
  );
}

const load = (env: RebaseEnv, candidateId: string) =>
  env.DB.prepare(`SELECT c.id, c.change_id, c.status, c.status_reason, c.score_json,
    c.recomposed_from, c.rollback_of_generation, ch.status AS change_status, ch.outcome,
    ch.project_id, ch.budget_usd, p.status AS project_status, p.org_id, p.slug
    FROM candidates c JOIN changes ch ON ch.id = c.change_id JOIN projects p ON p.id = ch.project_id
    WHERE c.id = ?`)
    .bind(candidateId)
    .first<Row>();

const receiptOf = (row: Row): Receipt | undefined =>
  (JSON.parse(row.score_json ?? "{}") as { rebase?: Receipt }).rebase;

export type RebaseOutcome =
  | { status: "skipped"; reason: string }
  | { status: "running" | "blocked"; repeated: boolean; taskIds: string[]; count: number };

/**
 * One D1 transaction reserves the rerun, invalidates only affected source, and resets Tasks.
 * The Candidate receipt is both the per-Change counter and the retry record: outbox/Queue
 * failures replay delivery, never the reset. No dependence on the eventual event projection.
 */
export async function requestCandidateRebase(
  env: RebaseEnv,
  candidateId: string,
): Promise<RebaseOutcome> {
  let row = await load(env, candidateId);
  if (!row) return { status: "skipped", reason: "missing" };
  if (
    requestCannotShip(row.change_status, row.outcome) ||
    ["failed", "completed", "promoting", "releasing"].includes(row.change_status)
  )
    return { status: "skipped", reason: "change_closed" };
  if (row.project_status !== "active" || row.rollback_of_generation !== null)
    return { status: "skipped", reason: "inactive" };
  let receipt = receiptOf(row);
  let repeated = !!receipt;
  if (!receipt) {
    const failedId = failedMergeChangeSet(row.status_reason);
    if (row.status !== "rejected" || !failedId)
      return { status: "skipped", reason: "not_source_conflict" };
    const [sets, edges] = await env.DB.batch([
      env.DB.prepare(`SELECT cs.id, cs.base_generation, cs.status, r.task_id FROM changesets cs
        JOIN task_runs r ON r.id = 'run_' || substr(cs.id, 4)
        WHERE cs.change_id = ?`).bind(row.change_id),
      env.DB.prepare(`SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d
        JOIN tasks t ON t.id = d.task_id WHERE t.change_id = ?`).bind(row.change_id),
    ]);
    const sources = (sets?.results ?? []) as {
      id: string;
      task_id: string;
      base_generation: number;
      status: string;
    }[];
    const failed = sources.find((s) => s.id === failedId);
    if (!failed) return { status: "skipped", reason: "no_task" };
    if (failed.status !== "proposed") return { status: "skipped", reason: "superseded" };
    const roots = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
    const canonical = await roots.get(roots.idFromName(row.project_id)).getCanonical();
    if (!canonical || canonical.artifactRef === "unassigned")
      return { status: "skipped", reason: "no_source" };
    // Also handles first Candidates whose Tasks were built on an older canonical base.
    if (!row.recomposed_from && failed.base_generation >= canonical.generation)
      return { status: "skipped", reason: "base_not_moved" };
    const affected = new Set([failed.task_id]);
    const dependencies = (edges?.results ?? []) as {
      task_id: string;
      depends_on_task_id: string;
    }[];
    let size = 0;
    while (size !== affected.size) {
      size = affected.size;
      for (const e of dependencies) if (affected.has(e.depends_on_task_id)) affected.add(e.task_id);
    }
    const taskIds = [...affected].sort();
    const changeId = row.change_id;
    const rejectedId = row.id;
    const invalidIds = sources.filter((s) => affected.has(s.task_id)).map((s) => s.id);
    const now = new Date().toISOString();
    const token = crypto.randomUUID();
    // The count check runs inside the write, so concurrent rejected siblings share one bound.
    const countSql = `(SELECT COUNT(*) FROM candidates s WHERE s.change_id = candidates.change_id
      AND json_extract(s.score_json, '$.rebase.requested') = 1)`;
    const owned = `EXISTS (SELECT 1 FROM candidates c WHERE c.id = ?
      AND json_extract(c.score_json, '$.rebase.token') = ?)`;
    const requested = `${owned} AND EXISTS (SELECT 1 FROM candidates c WHERE c.id = ?
      AND json_extract(c.score_json, '$.rebase.requested') = 1)`;
    await env.DB.batch([
      env.DB.prepare(`UPDATE candidates SET score_json = json_set(COALESCE(score_json, '{}'),
        '$.rebase', json(?), '$.rebase.requested', json(CASE WHEN ${countSql} < ? THEN 'true' ELSE 'false' END),
        '$.rebase.count', MIN(${countSql} + 1, ?))
        WHERE id = ? AND status = 'rejected' AND json_extract(score_json, '$.rebase') IS NULL
          AND EXISTS (SELECT 1 FROM changes ch JOIN projects p ON p.id = ch.project_id
            WHERE ch.id = candidates.change_id AND ch.status IN ('verifying', 'blocked', 'awaiting_approval', 'running', 'budget_blocked')
              AND COALESCE(ch.outcome, '') NOT IN ('not_selected', 'duplicate') AND p.status = 'active')
          AND NOT EXISTS (SELECT 1 FROM candidates s WHERE s.change_id = candidates.change_id AND s.status = 'promoted')
          AND EXISTS (SELECT 1 FROM changesets cs WHERE cs.id = ? AND cs.change_id = candidates.change_id AND cs.status = 'proposed')
          AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.change_id = candidates.change_id
            AND t.status IN ('ready', 'assigned', 'running', 'pending'))`).bind(
        JSON.stringify({
          token,
          baseGeneration: canonical.generation,
          fromGeneration: failed.base_generation,
          resetAt: now,
          taskIds,
          reason: row.status_reason,
        }),
        MAX_REBASE_RERUNS,
        MAX_REBASE_RERUNS,
        row.id,
        failedId,
      ),
      env.DB.prepare(`UPDATE candidates SET status = 'rejected', status_reason = 'Replaced by work on the current files.', updated_at = ?
        WHERE change_id = ? AND status IN ('composing', 'composed', 'verifying', 'verified', 'stale')
          AND EXISTS (SELECT 1 FROM json_each(change_set_ids_json) j WHERE j.value IN (SELECT value FROM json_each(?)))
          AND ${requested}`).bind(
        now,
        row.change_id,
        JSON.stringify(invalidIds),
        row.id,
        token,
        row.id,
      ),
      env.DB.prepare(`UPDATE changesets SET status = 'rejected' WHERE change_id = ?
        AND id IN (SELECT value FROM json_each(?)) AND ${requested}`).bind(
        row.change_id,
        JSON.stringify(invalidIds),
        row.id,
        token,
        row.id,
      ),
      ...taskIds.map((id) =>
        env.DB.prepare(`UPDATE tasks SET status = ?, assigned_agent_id = NULL,
        wake_sent_at = NULL, attempts_reset_at = ?, blocked_limit = NULL, blocked_reason = NULL,
        route_json = json_set(json_remove(COALESCE(route_json, '{}'), '$.integrate'), '$.rebase', json(?)), updated_at = ?
        WHERE id = ? AND change_id = ? AND ${requested}`).bind(
          dependencies.some((e) => e.task_id === id && affected.has(e.depends_on_task_id))
            ? "pending"
            : "ready",
          now,
          JSON.stringify({
            fromGeneration: failed.base_generation,
            toGeneration: canonical.generation,
          }),
          now,
          id,
          changeId,
          rejectedId,
          token,
          rejectedId,
        ),
      ),
      env.DB.prepare(`UPDATE changes SET status = CASE WHEN
          (SELECT json_extract(score_json, '$.rebase.requested') FROM candidates WHERE id = ?) = 1
          THEN 'running' ELSE 'blocked' END,
        base_generation = ?, blocked_limit = NULL,
        blocked_reason = CASE WHEN (SELECT json_extract(score_json, '$.rebase.requested') FROM candidates WHERE id = ?) = 1
          THEN NULL ELSE ? END, updated_at = ? WHERE id = ? AND ${owned}`).bind(
        row.id,
        canonical.generation,
        row.id,
        REBASE_BLOCKED_REASON,
        now,
        row.change_id,
        row.id,
        token,
      ),
    ]);
    row = await load(env, candidateId);
    if (!row) return { status: "skipped", reason: "missing" };
    receipt = receiptOf(row);
    if (!receipt) return { status: "skipped", reason: "changed" };
    repeated = receipt.token !== token;
  }
  const ctx: ChangeContext = {
    projectId: row.project_id,
    orgId: row.org_id,
    projectSlug: row.slug,
    changeId: row.change_id,
    baseGeneration: receipt.baseGeneration,
  };
  if (!receipt.delivered) {
    await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
      await changeEvent(
        ctx,
        "candidate.rebase_requested",
        {
          candidateId,
          reason: receipt.requested ? receipt.reason : REBASE_BLOCKED_REASON,
          status: receipt.requested ? "running" : "blocked",
          taskIds: receipt.taskIds,
          baseGeneration: receipt.baseGeneration,
          rebaseCount: receipt.count,
          maxRebases: MAX_REBASE_RERUNS,
        },
        { key: candidateId, actor: { kind: "system", id: "candidate-rebase" } },
      ),
    ]);
    if (receipt.requested) await dispatchReadyTasks(env, ctx, row.budget_usd);
    await env.DB.prepare(`UPDATE candidates SET score_json = json_set(score_json, '$.rebase.delivered', json('true'))
      WHERE id = ? AND json_extract(score_json, '$.rebase.token') = ?`)
      .bind(candidateId, receipt.token)
      .run();
  }
  return {
    status: receipt.requested ? "running" : "blocked",
    repeated,
    taskIds: receipt.taskIds,
    count: receipt.count,
  };
}

/** Existing maintenance and owner API recovery. Bounded; rejected history is never deleted. */
export async function recoverSourceConflicts(env: RebaseEnv, changeId?: string) {
  const rows =
    await env.DB.prepare(`SELECT c.id FROM changes ch JOIN projects p ON p.id = ch.project_id
    JOIN candidates c ON c.change_id = ch.id WHERE ch.status IN ('verifying', 'blocked', 'running', 'awaiting_approval', 'budget_blocked')
      AND p.status = 'active' AND COALESCE(ch.outcome, '') NOT IN ('not_selected', 'duplicate')
      AND c.status = 'rejected' AND (c.status_reason LIKE 'file_conflict:%' OR c.status_reason LIKE 'source_conflict:%')
      AND (json_extract(c.score_json, '$.rebase') IS NULL OR COALESCE(json_extract(c.score_json, '$.rebase.delivered'), 0) = 0)
      AND (? IS NULL OR ch.id = ?) ORDER BY c.created_at DESC, c.id LIMIT 20`)
      .bind(changeId ?? null, changeId ?? null)
      .all<{ id: string }>();
  const outcomes: RebaseOutcome[] = [];
  for (const row of rows.results ?? []) outcomes.push(await requestCandidateRebase(env, row.id));
  return outcomes;
}

/** Persist the source result before the Workflow's rejection step; only unmerged paths retry. */
export async function recordSourceConflict(
  env: Pick<Env, "DB"> & Partial<Pick<Env, "VERIFICATION_COMMANDS">>,
  input: { candidateId: string; projectId: string; changeSetId: string; sourceConflict?: boolean },
) {
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE candidates SET status = 'rejected', status_reason = ?, updated_at = ?
    WHERE id = ? AND status IN ('composing', 'composed', 'verifying')`)
    .bind(
      `${input.sourceConflict === false ? "source_error" : "file_conflict"}: ${input.changeSetId} does not merge`,
      now,
      input.candidateId,
    )
    .run();
  const row = await env.DB.prepare("SELECT change_id FROM candidates WHERE id = ?")
    .bind(input.candidateId)
    .first<{ change_id: string }>();
  if (row && env.VERIFICATION_COMMANDS && input.sourceConflict !== false)
    await env.VERIFICATION_COMMANDS.send({
      commandId: `cmd_${input.candidateId}_rebase`,
      commandType: "candidate.create",
      projectId: input.projectId,
      changeId: row.change_id,
      attempt: 0,
      createdAt: now,
      payload: {},
    });
}
