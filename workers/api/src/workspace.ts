import type { ProjectRootDO } from "@rhumbatron/coordinator";
import { apiData } from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

/**
 * Workspace read model (AGENTS.md sections 29, 38.5): the canonical Artifact, the Task Workspace
 * forks (`ws-*`) and Candidate forks (`cand-*`) of the Project's recent Changes, and the file index
 * of a canonical tree. Reads only: D1 rows, ProjectRootDO, and the R2 file index the integration
 * Worker writes (`source/<project>/<tree>/index.json`). This Worker has no Artifacts binding, so
 * fork contents and file bodies are not served here.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const ProjectIdParam = z.object({ projectId: z.string().regex(/^proj_[a-z0-9-]+$/) });
const FilesQuery = z.object({
  tree: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .optional(),
});

/** Newest Changes shown. Each query below is capped as well (AGENTS.md section 14.2). */
const CHANGE_LIMIT = 10;
const RUN_LIMIT = 200;
const CHANGESET_LIMIT = 200;
const CANDIDATE_LIMIT = 60;
/** Must match MAX_FILES in workers/integration/src/code-store.ts. */
const MAX_INDEXED_FILES = 2000;
/** Task kinds that open a Workspace fork (workers/integration/src/project-cleanup.ts). */
const WORKSPACE_TASK_KINDS = ["implement", "migrate", "test"];
const UNASSIGNED = "unassigned";

const FileStat = z.object({
  path: z.string(),
  /** Changed lines from `git diff --stat`; null for a binary file. */
  changes: z.number().int().nullable(),
  adds: z.number().int().nullable(),
  dels: z.number().int().nullable(),
  /** False when git scaled the +/- bar, so `adds` and `dels` are proportional estimates. */
  exact: z.boolean(),
  binary: z.boolean(),
});

const ChangeSetDiff = z.object({
  id: z.string(),
  status: z.string(),
  fork: z.string(),
  commit: z.string(),
  baseCommit: z.string(),
  files: z.array(z.string()),
  fileStats: z.array(FileStat),
  insertions: z.number().int(),
  deletions: z.number().int(),
  diffStat: z.string(),
  createdAt: z.string(),
});

const WorkspaceFork = z.object({
  fork: z.string(),
  runId: z.string().nullable(),
  changeId: z.string(),
  taskId: z.string().nullable(),
  taskKey: z.string().nullable(),
  taskTitle: z.string().nullable(),
  attempt: z.number().int().nullable(),
  runStatus: z.string().nullable(),
  baseGeneration: z.number().int(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  changeSet: ChangeSetDiff.nullable(),
});

const CandidateFork = z.object({
  fork: z.string(),
  id: z.string(),
  changeId: z.string(),
  status: z.string(),
  statusReason: z.string().nullable(),
  baseGeneration: z.number().int(),
  composedCommit: z.string().nullable(),
  composedTree: z.string().nullable(),
  changeSetIds: z.array(z.string()),
  promotedGeneration: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const WorkspaceView = z.object({
  canonical: z.object({
    assigned: z.boolean(),
    generation: z.number().int(),
    artifactRef: z.string(),
    treeSha: z.string(),
    lastPromotedCandidateId: z.string().nullable(),
    updatedAt: z.string().nullable(),
  }),
  changes: z.array(
    z.object({
      id: z.string(),
      goal: z.string(),
      status: z.string(),
      baseGeneration: z.number().int(),
      createdAt: z.string(),
    }),
  ),
  /** More Changes exist than `changes` lists. */
  truncated: z.boolean(),
  workspaces: z.array(WorkspaceFork),
  candidates: z.array(CandidateFork),
});
type WorkspaceView = z.infer<typeof WorkspaceView>;

const FileIndexView = z.object({
  treeSha: z.string(),
  /** False when no index exists for this tree yet. */
  indexed: z.boolean(),
  commit: z.string().nullable(),
  files: z.array(z.string()),
  /** The index stops at MAX_INDEXED_FILES paths. */
  truncated: z.boolean(),
});

/** The ChangeSet the agent stored with its Intent (workers/agents/src/workspace.ts `Published`). */
const StoredChangeSet = z.object({
  fork: z.string(),
  commit: z.string(),
  baseCommit: z.string(),
  diffStat: z.string().default(""),
  files: z.array(z.string()).default([]),
});

const STAT_LINE = /^\s*(.+?)\s+\|\s+(?:(\d+)\s*([+-]*)|Bin\b.*)$/;
const SUMMARY = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;

/**
 * Parses `git diff --stat` output. Paths come from `--name-only` when the counts line up, since
 * `--stat` shortens long paths with `...`. Totals come from the summary line and are exact.
 */
function parseDiffStat(diffStat: string, names: string[]) {
  const lines = diffStat.split("\n");
  const stats: z.infer<typeof FileStat>[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of lines) {
    const summary = SUMMARY.exec(line);
    if (summary) {
      insertions = Number(summary[2] ?? 0);
      deletions = Number(summary[3] ?? 0);
      continue;
    }
    const match = STAT_LINE.exec(line);
    if (!match) continue;
    const path = (match[1] ?? "").trim();
    if (match[2] === undefined) {
      stats.push({ path, changes: null, adds: null, dels: null, exact: true, binary: true });
      continue;
    }
    const changes = Number(match[2]);
    const bar = match[3] ?? "";
    const plus = [...bar].filter((ch) => ch === "+").length;
    const minus = bar.length - plus;
    const exact = plus + minus === changes;
    const adds = exact ? plus : bar.length ? Math.round((changes * plus) / bar.length) : 0;
    stats.push({ path, changes, adds, dels: changes - adds, exact, binary: false });
  }
  if (stats.length === names.length) {
    for (const [index, stat] of stats.entries()) stat.path = names[index] ?? stat.path;
  }
  return { fileStats: stats, insertions, deletions };
}

type ChangeRow = {
  id: string;
  goal: string;
  status: string;
  base_generation: number;
  created_at: string;
};
type RunRow = {
  id: string;
  task_id: string;
  change_id: string;
  task_key: string | null;
  title: string | null;
  attempt: number;
  status: string;
  started_at: string;
  ended_at: string | null;
};
type ChangeSetRow = {
  id: string;
  change_id: string;
  base_generation: number;
  intent_json: string;
  status: string;
  created_at: string;
};
type CandidateRow = {
  id: string;
  change_id: string;
  status: string;
  status_reason: string | null;
  base_generation: number;
  composed_commit: string | null;
  composed_tree: string | null;
  change_set_ids_json: string;
  promoted_generation: number | null;
  created_at: string;
  updated_at: string;
};

function storedChangeSet(row: ChangeSetRow): z.infer<typeof ChangeSetDiff> | null {
  let intent: unknown;
  try {
    intent = JSON.parse(row.intent_json);
  } catch {
    return null;
  }
  const parsed = StoredChangeSet.safeParse((intent as { changeSet?: unknown } | null)?.changeSet);
  if (!parsed.success) return null;
  const stored = parsed.data;
  return {
    id: row.id,
    status: row.status,
    fork: stored.fork,
    commit: stored.commit,
    baseCommit: stored.baseCommit,
    files: stored.files,
    diffStat: stored.diffStat,
    ...parseDiffStat(stored.diffStat, stored.files),
    createdAt: row.created_at,
  };
}

const projectRoot = (env: Env, projectId: string) => {
  const ns = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  return ns.get(ns.idFromName(projectId));
};

/** ChangeSet `cs_<x>` belongs to Task run `run_<x>`, whose fork is `ws-<x>` (agent-do.ts). */
const runOfChangeSet = (changeSetId: string) => `run_${changeSetId.slice(3)}`;
const workspaceFork = (runId: string) => `ws-${runId.slice(4)}`;
const candidateFork = (candidateId: string) => `cand-${candidateId.slice(5)}`;

async function loadWorkspace(env: Env, projectId: string): Promise<WorkspaceView> {
  const canonical = await projectRoot(env, projectId).getCanonical();
  const changeRows = await env.DB.prepare(
    `SELECT id, goal, status, base_generation, created_at FROM changes
     WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(projectId, CHANGE_LIMIT + 1)
    .all<ChangeRow>();
  const changes = (changeRows.results ?? []).slice(0, CHANGE_LIMIT);
  const ids = JSON.stringify(changes.map((c) => c.id));
  const kinds = WORKSPACE_TASK_KINDS.map(() => "?").join(", ");

  const [runs, sets, cands] =
    changes.length === 0
      ? [[], [], []]
      : await env.DB.batch([
          env.DB.prepare(
            `SELECT r.id, r.task_id, t.change_id, t.task_key, t.title, r.attempt, r.status,
                    r.started_at, r.ended_at
             FROM tasks t JOIN task_runs r ON r.task_id = t.id
             WHERE t.change_id IN (SELECT value FROM json_each(?)) AND t.kind IN (${kinds})
               AND r.fork_deleted_at IS NULL
             ORDER BY r.started_at LIMIT ?`,
          ).bind(ids, ...WORKSPACE_TASK_KINDS, RUN_LIMIT),
          env.DB.prepare(
            `SELECT id, change_id, base_generation, intent_json, status, created_at FROM changesets
             WHERE change_id IN (SELECT value FROM json_each(?)) ORDER BY created_at LIMIT ?`,
          ).bind(ids, CHANGESET_LIMIT),
          env.DB.prepare(
            `SELECT id, change_id, status, status_reason, base_generation, composed_commit,
                    composed_tree, change_set_ids_json, promoted_generation, created_at, updated_at
             FROM candidates WHERE change_id IN (SELECT value FROM json_each(?))
               AND fork_deleted_at IS NULL
             ORDER BY created_at LIMIT ?`,
          ).bind(ids, CANDIDATE_LIMIT),
        ]).then((results) => results.map((r) => r.results ?? []));

  const baseOf = new Map(changes.map((c) => [c.id, c.base_generation]));
  const setByRun = new Map(
    (sets as ChangeSetRow[]).map((row) => [runOfChangeSet(row.id), row] as const),
  );
  const workspaces: z.infer<typeof WorkspaceFork>[] = (runs as RunRow[]).map((run) => {
    const set = setByRun.get(run.id);
    setByRun.delete(run.id);
    return {
      fork: workspaceFork(run.id),
      runId: run.id,
      changeId: run.change_id,
      taskId: run.task_id,
      taskKey: run.task_key,
      taskTitle: run.title,
      attempt: run.attempt,
      runStatus: run.status,
      baseGeneration: set?.base_generation ?? baseOf.get(run.change_id) ?? 0,
      startedAt: run.started_at,
      endedAt: run.ended_at,
      changeSet: set ? storedChangeSet(set) : null,
    };
  });
  // A ChangeSet whose run fell outside the capped run query still names its own fork.
  for (const set of setByRun.values()) {
    const changeSet = storedChangeSet(set);
    workspaces.push({
      fork: changeSet?.fork ?? workspaceFork(runOfChangeSet(set.id)),
      runId: null,
      changeId: set.change_id,
      taskId: null,
      taskKey: null,
      taskTitle: null,
      attempt: null,
      runStatus: null,
      baseGeneration: set.base_generation,
      startedAt: null,
      endedAt: null,
      changeSet,
    });
  }

  return {
    canonical: {
      assigned: !!canonical && canonical.artifactRef !== UNASSIGNED,
      generation: canonical?.generation ?? 0,
      artifactRef: canonical?.artifactRef ?? UNASSIGNED,
      treeSha: canonical?.treeSha ?? "",
      lastPromotedCandidateId: canonical?.lastPromotedCandidateId ?? null,
      updatedAt: canonical?.updatedAt ?? null,
    },
    changes: changes.map((c) => ({
      id: c.id,
      goal: c.goal,
      status: c.status,
      baseGeneration: c.base_generation,
      createdAt: c.created_at,
    })),
    truncated: (changeRows.results ?? []).length > CHANGE_LIMIT,
    workspaces,
    candidates: (cands as CandidateRow[]).map((row) => ({
      fork: candidateFork(row.id),
      id: row.id,
      changeId: row.change_id,
      status: row.status,
      statusReason: row.status_reason,
      baseGeneration: row.base_generation,
      composedCommit: row.composed_commit,
      composedTree: row.composed_tree,
      changeSetIds: JSON.parse(row.change_set_ids_json) as string[],
      promotedGeneration: row.promoted_generation,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

export const workspace = new Hono<AppEnv>()
  .get(
    "/v1/projects/:projectId/workspace",
    requireAuth,
    validate("param", ProjectIdParam),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { projectId } = c.req.valid("param");
      if (!(await canAccessProject(c.env.DB, userId, projectId))) {
        return fail(c, 404, "not_found", "Project not found");
      }
      return respond(c, apiData(WorkspaceView), { data: await loadWorkspace(c.env, projectId) });
    },
  )

  /**
   * File index of one canonical tree (paths only; the index carries no sizes or contents).
   * `tree` defaults to the current canonical tree. The R2 key is scoped by Project ID.
   */
  .get(
    "/v1/projects/:projectId/workspace/files",
    requireAuth,
    validate("param", ProjectIdParam),
    validate("query", FilesQuery),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { projectId } = c.req.valid("param");
      if (!(await canAccessProject(c.env.DB, userId, projectId))) {
        return fail(c, 404, "not_found", "Project not found");
      }
      let treeSha = c.req.valid("query").tree;
      if (!treeSha) {
        const canonical = await projectRoot(c.env, projectId).getCanonical();
        if (!canonical || canonical.artifactRef === UNASSIGNED) {
          return fail(c, 404, "not_found", "Project has no canonical source");
        }
        treeSha = canonical.treeSha;
      }
      const object = await c.env.EVIDENCE.get(`source/${projectId}/${treeSha}/index.json`);
      const index = object
        ? ((await object.json()) as { commit?: string; files?: string[] })
        : null;
      const files = index?.files ?? [];
      return respond(c, apiData(FileIndexView), {
        data: {
          treeSha,
          indexed: !!index,
          commit: index?.commit ?? null,
          files,
          truncated: files.length >= MAX_INDEXED_FILES,
        },
      });
    },
  );
