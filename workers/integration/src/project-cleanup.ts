import { allShardKeys } from "@rhumbatron/coordinator/shard-key";
import { APP_PRODUCTION_CHANNEL } from "@rhumbatron/protocol";
import { isAppTombstone } from "./app-release.ts";
import { policyKey } from "./policy.ts";
import { type ForkRow, forksOwnedBy, isProjectId, type OwnedFork } from "./repo-names.ts";

/**
 * Project deletion cleanup and the fork sweep (AGENTS.md sections 13, 29, 34.4, 43, HOM-195).
 *
 * `project.cleanup`: after `DELETE /v1/projects/:id` archives a Project, everything the Project
 * created is deleted. Every delivery purges the ProjectRootDO and ProjectViewDO again (the API
 * did it once; this makes any archive path safe). Then, in this order, and bounded per message:
 *
 * 1. Artifacts: every Workspace and Candidate fork recorded in D1, then the canonical repo.
 * 2. R2 (EVIDENCE bucket), one prefix per kind of object, all keyed by Project ID:
 *    `source/` (code manifests, blobs, patches, index pointers), `context/` (Context Packets,
 *    tool logs, conflict packets), `apps/` and `app-previews/` (live app bundles), `evidence/`
 *    (check reports, stdout, screenshots), `work-graphs/`, and `workspace/` (manifests).
 * 3. Live apps: waits for `removeApp` (prod) to wipe the app data stores. Without the apps Worker
 *    (local runs) it removes the preview and version rows itself.
 * 4. Task by Task, 25 per message: the AgentDO of each Task is purged, then the Task's D1 rows.
 * 5. The other D1 content rows (see CONTENT_TABLES): Changes with their goal text, plans,
 *    Candidates, ChangeSets, Evidence summaries, approvals, request conflicts, members and
 *    invitations (email addresses), dead letters, releases, policy, agents, activity feed.
 * 6. The 32 ResourceShardDO shards, then the KV policy copy, then the `projects` row is scrubbed
 *    (name and slug replaced) and marked `cleaned_at`.
 *
 * Kept on purpose:
 * - `usage_counters`. The monthly Anthropic budget (ADR 0021, counter `anthropic-usd-micro`) and
 *   the daily and monthly Sandbox, Browser, and build meters are global rows, not Project rows.
 *   Deleting a Project can therefore never free budget. The per-Change and per-Project cost
 *   views read `task_runs`; they go with the Project.
 * - The `projects` row (ID, org, status, generation, timestamps) as the archive record, with the
 *   name and slug scrubbed. The slug is free to reuse. The live-app host does not read it: it
 *   reads `app_deployments.slug`.
 * - One `app_deployments` tombstone (`isAppTombstone`): the app host label and `removed` status,
 *   so the host keeps answering 410. It holds no commit, bundle, Candidate, or Change reference.
 * - The R2 `events/` audit archive (keyed by date and stream, shared by all Projects) and K2
 *   events: they expire by their own retention (R2 lifecycle rule, K2 7 days).
 * - Organization, user, and membership rows (not Project data), `notification_reads` (user read
 *   markers), and `processed_events` (event IDs only, pruned daily).
 * - `index/` objects, Vectorize vectors, `project_indexes`, and `project_vectors`: the indexer
 *   Worker deletes them (`index.purge`, which needs the vector manifest and the MEMORY binding).
 *   The daily maintenance sends it also for a cleaned Project while index rows remain.
 * - The Project Sandbox container (`proj-<id>`): it holds no data after its 2-minute sleep, and
 *   waking it only to destroy it would spend the Sandbox hour cap.
 *
 * `forks.sweep`: for active Projects, deletes the forks that no Candidate can need again, after the
 * retention period. Workspace forks: failed runs, runs without a ChangeSet, and runs of finished
 * Changes. Candidate forks: rejected, stale, and promoted Candidates (promoted only when canonical
 * already holds the composed commit, so a promotion retry never needs the fork).
 *
 * Both are bounded per queue message and idempotent: a fork is deleted at most once
 * (`fork_deleted_at`), `ARTIFACTS.delete` returns false for a repo that is already gone, and every
 * D1 delete and Durable Object purge is safe to repeat.
 */

/** Task kinds that open a Workspace (WORKSPACE_KINDS in workers/agents/src/agent-do.ts). */
const WORKSPACE_TASK_KINDS = ["implement", "migrate", "test"] as const;
const FINAL_CANDIDATE_STATUSES = ["rejected", "stale", "promoted"] as const;
const FINAL_CHANGE_STATUSES = ["completed", "cancelled", "failed"] as const;

/** Artifacts deletes per queue message. Each delete is one Artifacts operation. */
const REPO_DELETES_PER_MESSAGE = 20;
/** R2 objects listed (and deleted) per prefix per message. */
const R2_PAGE = 1000;

const DAY_MS = 86_400_000;

/** Fork retention after a run or Candidate finishes: 30 days (section 43). */
export const FORK_RETENTION_DAYS = 30;

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");

/** The RPC every purgeable Durable Object exposes. Each one refuses a Project that is not its own. */
type Purger = { purge(projectId: string): Promise<{ purged: boolean }> };

type ForkEnv = Pick<Env, "DB" | "ARTIFACTS" | "EVIDENCE">;

type CleanupEnv = ForkEnv &
  Pick<Env, "PROJECT_ROOT" | "PROJECT_VIEW" | "RESOURCE_SHARD" | "AGENT"> & {
    /** Present on prod only. Dev has no live apps. */
    APPS?: unknown;
    CONFIG?: Pick<KVNamespace, "delete">;
  };

/** R2 prefixes in the EVIDENCE bucket that belong to one Project. Never a shared prefix. */
export const projectPrefixes = (projectId: string) => [
  `source/${projectId}/`,
  `context/${projectId}/`,
  `apps/${projectId}/`,
  `app-previews/${projectId}/`,
  `evidence/${projectId}/`,
  `work-graphs/${projectId}/`,
  `workspace/${projectId}/`,
];

/** Tasks (and their AgentDO instances) handled per queue message. */
const TASKS_PER_MESSAGE = 25;
/** Rows per D1 delete statement and statements per message: D1 row writes stay bounded. */
const ROWS_PER_DELETE = 500;
const DELETE_STATEMENTS_PER_MESSAGE = 40;
/** Shard purges per message batch: 32 shards in four waves. */
const DO_PURGES_AT_ONCE = 8;

const AGENT_NAME = /^agt_[A-Za-z0-9_-]+$/;
const agentIdFor = (taskId: string) => `agt_${taskId.slice(4)}`;

const purger = (ns: DurableObjectNamespace, name: string) =>
  ns.get(ns.idFromName(name)) as unknown as Purger;

const CHANGES = "SELECT id FROM changes WHERE project_id = ?";
const CHANGE_CANDIDATES = `SELECT id FROM candidates WHERE change_id IN (${CHANGES})`;

/**
 * D1 content tables of a Project, children before parents (D1 enforces foreign keys). Tasks and
 * their children are not here: step 4 deletes them with their AgentDO. Each `where` takes the
 * Project ID as its one bound value. `usage_counters` is deliberately absent.
 */
export const CONTENT_TABLES: readonly { table: string; where: string }[] = [
  { table: "evidence_index", where: `candidate_id IN (${CHANGE_CANDIDATES})` },
  { table: "approvals", where: "project_id = ?" },
  { table: "conflicts", where: `change_id IN (${CHANGES})` },
  { table: "changesets", where: `change_id IN (${CHANGES})` },
  { table: "candidates", where: `change_id IN (${CHANGES})` },
  { table: "change_decisions", where: `change_id IN (${CHANGES})` },
  { table: "changes", where: "project_id = ?" },
  { table: "request_conflicts", where: "project_id = ?" },
  { table: "goal_suggestions", where: "project_id = ?" },
  { table: "project_policies", where: "project_id = ?" },
  { table: "project_members", where: "project_id = ?" },
  { table: "project_invitations", where: "project_id = ?" },
  { table: "agents", where: "project_id = ?" },
  { table: "dead_letters", where: "project_id = ?" },
  { table: "releases", where: "project_id = ?" },
  { table: "project_events", where: "project_id = ?" },
];

export type CleanupResult = {
  /** `done`: nothing left. `partial`: more work remains; deliver the command again. */
  status: "done" | "partial" | "skipped";
  reposDeleted: number;
  reposMissing: number;
  objectsDeleted: number;
  detail?: string;
};

type DeleteTally = { deleted: number; missing: number };

/**
 * Deletes forks one by one and marks each in D1 as soon as the batch ends, also after a failure,
 * so a retry does not spend an Artifacts operation on a fork that is already gone.
 */
async function deleteForks(env: ForkEnv, forks: OwnedFork[]): Promise<DeleteTally> {
  const tally: DeleteTally = { deleted: 0, missing: 0 };
  const done: OwnedFork[] = [];
  try {
    for (const fork of forks) {
      if (await env.ARTIFACTS.delete(fork.name)) tally.deleted += 1;
      else tally.missing += 1;
      done.push(fork);
    }
  } finally {
    await markForksDeleted(env.DB, done);
  }
  return tally;
}

async function markForksDeleted(db: D1Database, forks: OwnedFork[]) {
  if (forks.length === 0) return;
  const now = new Date().toISOString();
  const ids = (kind: OwnedFork["kind"]) =>
    JSON.stringify(forks.filter((f) => f.kind === kind).map((f) => f.id));
  await db.batch([
    db
      .prepare(
        `UPDATE task_runs SET fork_deleted_at = ?
         WHERE id IN (SELECT value FROM json_each(?)) AND fork_deleted_at IS NULL`,
      )
      .bind(now, ids("workspace")),
    db
      .prepare(
        `UPDATE candidates SET fork_deleted_at = ?
         WHERE id IN (SELECT value FROM json_each(?)) AND fork_deleted_at IS NULL`,
      )
      .bind(now, ids("candidate")),
  ]);
}

/** Forks of one Project that are not deleted yet. Scoped by Project ID in SQL and again in code. */
async function pendingProjectForks(
  db: D1Database,
  projectId: string,
  limit: number,
): Promise<OwnedFork[]> {
  const [runs, candidates] = await db.batch<ForkRow>([
    db
      .prepare(
        `SELECT 'workspace' AS kind, r.id, c.project_id
         FROM task_runs r JOIN tasks t ON t.id = r.task_id JOIN changes c ON c.id = t.change_id
         WHERE c.project_id = ? AND r.fork_deleted_at IS NULL
           AND t.kind IN (${sqlList(WORKSPACE_TASK_KINDS)})
         ORDER BY r.id LIMIT ?`,
      )
      .bind(projectId, limit),
    db
      .prepare(
        `SELECT 'candidate' AS kind, ca.id, c.project_id
         FROM candidates ca JOIN changes c ON c.id = ca.change_id
         WHERE c.project_id = ? AND ca.fork_deleted_at IS NULL
         ORDER BY ca.id LIMIT ?`,
      )
      .bind(projectId, limit),
  ]);
  return forksOwnedBy(projectId, [...(runs?.results ?? []), ...(candidates?.results ?? [])]);
}

/** Deletes up to one page of objects under `prefix`. True when more objects remain. */
async function clearPrefix(
  bucket: R2Bucket,
  prefix: string,
): Promise<{ n: number; more: boolean }> {
  const listed = await bucket.list({ prefix, limit: R2_PAGE });
  const keys = listed.objects.map((o) => o.key).filter((k) => k.startsWith(prefix));
  if (keys.length > 0) await bucket.delete(keys);
  return { n: keys.length, more: listed.truncated };
}

/**
 * Cleans one archived Project; the file header lists what goes and what stays. Order: Durable
 * Objects of the live read model, forks first (a fork needs its canonical repo to exist, so none
 * can appear after the canonical delete), the canonical repo, R2, app rows, Tasks with their
 * agents, the other D1 rows, the shards, and `cleaned_at` last. A `partial` result means the
 * message budget ended: deliver the command again.
 */
export async function cleanupProject(env: CleanupEnv, projectId: string): Promise<CleanupResult> {
  const result: CleanupResult = {
    status: "partial",
    reposDeleted: 0,
    reposMissing: 0,
    objectsDeleted: 0,
  };
  if (!isProjectId(projectId)) return { ...result, status: "skipped", detail: "invalid id" };
  const project = await env.DB.prepare("SELECT status, cleaned_at FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{ status: string; cleaned_at: string | null }>();
  if (!project) return { ...result, status: "skipped", detail: "not found" };
  if (project.status !== "archived")
    return { ...result, status: "skipped", detail: "not archived" };
  if (project.cleaned_at) return { ...result, status: "done", detail: "already cleaned" };
  // The API purged these when it archived the Project. Repeating it covers any other archive path.
  await purger(env.PROJECT_ROOT, projectId).purge(projectId);
  await purger(env.PROJECT_VIEW, projectId).purge(projectId);
  // Live apps (ADR 0020): the app host answers 410 within the router's 10 s pointer cache; its bundles go with the prefixes below.
  await env.DB.prepare(
    "UPDATE app_deployments SET status = 'removed', updated_at = ? WHERE project_id = ? AND status != 'removed'",
  )
    .bind(new Date().toISOString(), projectId)
    .run();

  const budget = REPO_DELETES_PER_MESSAGE;
  const forks = await pendingProjectForks(env.DB, projectId, budget + 1);
  const batch = forks.slice(0, budget);
  const tally = await deleteForks(env, batch);
  result.reposDeleted += tally.deleted;
  result.reposMissing += tally.missing;
  if (forks.length > batch.length || batch.length === budget) return result;

  if (await env.ARTIFACTS.delete(projectId)) result.reposDeleted += 1;
  else result.reposMissing += 1;
  // A Task run that forked between the fork query and the canonical delete.
  if ((await pendingProjectForks(env.DB, projectId, 1)).length > 0) return result;

  let more = false;
  for (const prefix of projectPrefixes(projectId)) {
    const cleared = await clearPrefix(env.EVIDENCE, prefix);
    result.objectsDeleted += cleared.n;
    more ||= cleared.more;
  }
  if (more) return result;

  // Live apps: prod's `removeApp` wipes the data stores first and leaves one tombstone row.
  if (!(await appsSettled(env, projectId))) return result;

  const tasks = await deleteTasks(env, projectId);
  if (tasks.more) return result;
  const rows = await deleteContentRows(env.DB, projectId);
  if (rows.more) return result;

  // Last: a late Claim from a still-running Workflow could refill a shard before this point.
  const shards = allShardKeys(projectId);
  for (let i = 0; i < shards.length; i += DO_PURGES_AT_ONCE) {
    await Promise.all(
      shards
        .slice(i, i + DO_PURGES_AT_ONCE)
        .map((name) => purger(env.RESOURCE_SHARD, name).purge(projectId)),
    );
  }
  await env.CONFIG?.delete(policyKey(projectId)).catch(() => undefined);

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE projects SET name = 'Deleted project', slug = 'deleted-' || substr(id, 6),
       cleaned_at = ?, updated_at = ?
     WHERE id = ? AND status = 'archived' AND cleaned_at IS NULL`,
  )
    .bind(now, now, projectId)
    .run();
  return { ...result, status: "done" };
}

/**
 * True when the Project's app rows are down to nothing or one tombstone. With the apps Worker
 * bound, `removeApp` (same delivery, before this) does the work, so anything else means wait.
 * Without it (local runs) there are no data stores: the preview and version rows go here and the
 * production row is reduced to the tombstone, as `removeApp` does.
 */
async function appsSettled(env: CleanupEnv, projectId: string): Promise<boolean> {
  const { results } = await env.DB.prepare(
    "SELECT channel, status, commit_sha, bundle_key FROM app_deployments WHERE project_id = ? LIMIT 3",
  )
    .bind(projectId)
    .all<{
      channel: string;
      status: string;
      commit_sha: string | null;
      bundle_key: string | null;
    }>();
  const rows = results ?? [];
  if (rows.length === 0 || (rows.length === 1 && rows[0] && isAppTombstone(rows[0]))) return true;
  if (env.APPS) return false;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM app_deployments WHERE project_id = ? AND channel != ?").bind(
      projectId,
      APP_PRODUCTION_CHANNEL,
    ),
    env.DB.prepare(
      `UPDATE app_deployments SET commit_sha = NULL, generation = NULL, bundle_key = NULL,
         failure_reason = NULL, bundle_bytes = NULL, candidate_id = NULL, change_id = NULL,
         status = 'removed', updated_at = ?
       WHERE project_id = ? AND channel = ?`,
    ).bind(new Date().toISOString(), projectId, APP_PRODUCTION_CHANNEL),
  ]);
  return true;
}

/**
 * Purges the AgentDO of up to TASKS_PER_MESSAGE Tasks, then deletes those Tasks and their runs,
 * receipts, and dependency edges. The Task rows are the cursor: a Task is deleted only after its
 * agents are purged, so a retry never loses one. `more` when Tasks remain.
 */
async function deleteTasks(env: CleanupEnv, projectId: string): Promise<{ more: boolean }> {
  const { results } = await env.DB.prepare(
    `SELECT id, assigned_agent_id FROM tasks WHERE change_id IN (${CHANGES}) ORDER BY id LIMIT ?`,
  )
    .bind(projectId, TASKS_PER_MESSAGE + 1)
    .all<{ id: string; assigned_agent_id: string | null }>();
  const found = results ?? [];
  const batch = found.slice(0, TASKS_PER_MESSAGE);
  if (batch.length === 0) return { more: false };
  const ids = JSON.stringify(batch.map((t) => t.id));
  const runs = await env.DB.prepare(
    "SELECT DISTINCT agent_id FROM task_runs WHERE task_id IN (SELECT value FROM json_each(?))",
  )
    .bind(ids)
    .all<{ agent_id: string }>();
  const agents = new Set<string>();
  for (const task of batch) {
    agents.add(agentIdFor(task.id));
    if (task.assigned_agent_id) agents.add(task.assigned_agent_id);
  }
  for (const run of runs.results ?? []) agents.add(run.agent_id);
  const names = [...agents].filter((name) => AGENT_NAME.test(name));
  for (let i = 0; i < names.length; i += DO_PURGES_AT_ONCE) {
    await Promise.all(
      names.slice(i, i + DO_PURGES_AT_ONCE).map((name) => purger(env.AGENT, name).purge(projectId)),
    );
  }
  const inBatch = "task_id IN (SELECT value FROM json_each(?))";
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM task_dependencies WHERE ${inBatch}`).bind(ids),
    env.DB.prepare(`DELETE FROM decision_receipts WHERE ${inBatch}`).bind(ids),
    env.DB.prepare(`DELETE FROM task_runs WHERE ${inBatch}`).bind(ids),
    env.DB.prepare("DELETE FROM tasks WHERE id IN (SELECT value FROM json_each(?))").bind(ids),
  ]);
  return { more: found.length > batch.length };
}

/** Deletes CONTENT_TABLES rows in bounded statements. `more` when the message budget ran out. */
async function deleteContentRows(db: D1Database, projectId: string): Promise<{ more: boolean }> {
  let statements = 0;
  for (const { table, where } of CONTENT_TABLES) {
    for (;;) {
      if (statements >= DELETE_STATEMENTS_PER_MESSAGE) return { more: true };
      statements += 1;
      const done = await db
        .prepare(
          `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ?)`,
        )
        .bind(projectId, ROWS_PER_DELETE)
        .run();
      if ((done.meta?.changes ?? 0) < ROWS_PER_DELETE) break;
    }
  }
  return { more: false };
}

/** A sweep row: a fork plus the state that decides whether it is still needed. */
export type SweepRow = ForkRow & {
  project_status: string;
  /** Run `ended_at` or Candidate `updated_at`. */
  finished_at: string | null;
  run_status?: string | null;
  task_kind?: string | null;
  change_status?: string | null;
  has_change_set?: number | null;
  candidate_status?: string | null;
  composed_commit?: string | null;
};

const includes = (list: readonly string[], value: string | null | undefined) =>
  value !== null && value !== undefined && list.includes(value);

/**
 * True when no Candidate can need the fork again. The SQL applies the same rule; this check keeps a
 * query mistake from turning into a delete. Promoted Candidates also need the canonical check.
 */
export function isSweepable(row: SweepRow, cutoffIso: string): boolean {
  if (row.project_status !== "active") return false;
  if (!row.finished_at || row.finished_at >= cutoffIso) return false;
  if (row.kind === "workspace") {
    if (row.run_status !== "completed" && row.run_status !== "failed") return false;
    if (!includes(WORKSPACE_TASK_KINDS, row.task_kind)) return false;
    // A completed run's ChangeSet can be composed again until its Change finishes.
    return (
      row.run_status === "failed" ||
      !row.has_change_set ||
      includes(FINAL_CHANGE_STATUSES, row.change_status)
    );
  }
  return includes(FINAL_CANDIDATE_STATUSES, row.candidate_status);
}

/** True when canonical `main` already received the promoted commit (fast-forward, ADR 0013). */
async function canonicalHas(env: ForkEnv, projectId: string, commit: string | null | undefined) {
  if (!commit || !isProjectId(projectId)) return false;
  try {
    using canonical = await env.ARTIFACTS.get(projectId);
    return (await canonical.readCommit(commit)) !== null;
  } catch {
    return false;
  }
}

export type SweepResult = { deleted: number; missing: number; kept: number; more: boolean };

/** Deletes up to REPO_DELETES_PER_MESSAGE forks that are past retention. */
export async function sweepForks(
  env: ForkEnv,
  input: { now: number; retentionDays: number },
): Promise<SweepResult> {
  const cutoff = new Date(input.now - input.retentionDays * DAY_MS).toISOString();
  const limit = REPO_DELETES_PER_MESSAGE + 1;
  const [runs, candidates] = await env.DB.batch<SweepRow>([
    env.DB.prepare(
      `SELECT 'workspace' AS kind, r.id, c.project_id, p.status AS project_status,
              r.ended_at AS finished_at, r.status AS run_status, t.kind AS task_kind,
              c.status AS change_status,
              EXISTS (SELECT 1 FROM changesets cs WHERE cs.id = 'cs_' || substr(r.id, 5)) AS has_change_set
       FROM task_runs r JOIN tasks t ON t.id = r.task_id JOIN changes c ON c.id = t.change_id
       JOIN projects p ON p.id = c.project_id
       WHERE p.status = 'active' AND r.fork_deleted_at IS NULL
         AND r.status IN ('completed', 'failed') AND r.ended_at < ?
         AND t.kind IN (${sqlList(WORKSPACE_TASK_KINDS)})
         AND (r.status = 'failed' OR c.status IN (${sqlList(FINAL_CHANGE_STATUSES)})
              OR NOT EXISTS (SELECT 1 FROM changesets cs WHERE cs.id = 'cs_' || substr(r.id, 5)))
       ORDER BY r.ended_at LIMIT ?`,
    ).bind(cutoff, limit),
    env.DB.prepare(
      `SELECT 'candidate' AS kind, ca.id, c.project_id, p.status AS project_status,
              ca.updated_at AS finished_at, ca.status AS candidate_status, ca.composed_commit
       FROM candidates ca JOIN changes c ON c.id = ca.change_id
       JOIN projects p ON p.id = c.project_id
       WHERE p.status = 'active' AND ca.fork_deleted_at IS NULL
         AND ca.status IN (${sqlList(FINAL_CANDIDATE_STATUSES)}) AND ca.updated_at < ?
       ORDER BY ca.updated_at LIMIT ?`,
    ).bind(cutoff, limit),
  ]);
  const rows = [...(runs?.results ?? []), ...(candidates?.results ?? [])];
  const selected = rows.slice(0, REPO_DELETES_PER_MESSAGE);
  const result: SweepResult = { deleted: 0, missing: 0, kept: 0, more: false };

  const forks: OwnedFork[] = [];
  for (const row of selected) {
    const [fork] = forksOwnedBy(row.project_id, [row]);
    if (!fork || !isSweepable(row, cutoff)) {
      result.kept += 1;
      continue;
    }
    if (
      row.candidate_status === "promoted" &&
      !(await canonicalHas(env, row.project_id, row.composed_commit))
    ) {
      result.kept += 1;
      continue;
    }
    forks.push(fork);
  }
  const tally = await deleteForks(env, forks);
  // Rows kept here stay first in the next query, so continue only while deletes make progress.
  const more = rows.length > selected.length && forks.length > 0;
  return { ...result, deleted: tally.deleted, missing: tally.missing, more };
}
