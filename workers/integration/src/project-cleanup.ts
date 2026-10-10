import { type ForkRow, forksOwnedBy, isProjectId, type OwnedFork } from "./repo-names.ts";

/**
 * Artifacts and R2 cleanup (AGENTS.md section 43, HOM-195).
 *
 * `project.cleanup`: an archived Project loses its canonical repo, every Workspace and Candidate
 * fork recorded in D1 for its Changes, and its R2 `source/` and `context/` objects. Evidence stays:
 * the R2 lifecycle rule expires it. D1 rows stay as the archived record.
 *
 * `forks.sweep`: for active Projects, deletes the forks that no Candidate can need again, after the
 * retention period. Workspace forks: failed runs, runs without a ChangeSet, and runs of finished
 * Changes. Candidate forks: rejected, stale, and promoted Candidates (promoted only when canonical
 * already holds the composed commit, so a promotion retry never needs the fork).
 *
 * Both are bounded per queue message and idempotent: a fork is deleted at most once
 * (`fork_deleted_at`), and `ARTIFACTS.delete` returns false for a repo that is already gone.
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

/** Fork retention after a run or Candidate finishes: 7 days in dev (section 43), 30 in prod. */
export const forkRetentionDays = (environment: string) => (environment === "prod" ? 30 : 7);

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");

type CleanupEnv = Pick<Env, "DB" | "ARTIFACTS" | "EVIDENCE">;

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
async function deleteForks(env: CleanupEnv, forks: OwnedFork[]): Promise<DeleteTally> {
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
 * Cleans one archived Project. Order: forks first (a fork needs its canonical repo to exist, so
 * none can appear after the canonical delete), then the canonical repo, then R2, then `cleaned_at`.
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
  // Live apps (ADR 0020): the app host answers 410 at once; its bundles go with the prefixes below.
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
  for (const prefix of [
    `source/${projectId}/`,
    `context/${projectId}/`,
    `apps/${projectId}/`,
    `app-previews/${projectId}/`,
  ]) {
    const cleared = await clearPrefix(env.EVIDENCE, prefix);
    result.objectsDeleted += cleared.n;
    more ||= cleared.more;
  }
  if (more) return result;

  const now = new Date().toISOString();
  // The activity feed rows go with the Project; the retention cap would evict them only later.
  await env.DB.prepare("DELETE FROM project_events WHERE project_id = ?").bind(projectId).run();
  await env.DB.prepare(
    `UPDATE projects SET cleaned_at = ?, updated_at = ?
     WHERE id = ? AND status = 'archived' AND cleaned_at IS NULL`,
  )
    .bind(now, now, projectId)
    .run();
  return { ...result, status: "done" };
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
async function canonicalHas(env: CleanupEnv, projectId: string, commit: string | null | undefined) {
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
  env: CleanupEnv,
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
