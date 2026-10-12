import type { ProjectRootDO } from "@rhumbatron/coordinator";
import {
  apiData,
  CandidateDiffView,
  ChangeSetAttribution,
  ChangeSetDiffView,
  ChangeSetIntent,
  type CodeDiff,
  CodeManifest,
  CodeVersions,
  CodeView,
  candidatePatchKey,
  changeSetPatchKey,
  changeTitle,
  codeBlobKey,
  codeManifestKey,
  MAX_CODE_BLOB_BYTES,
  MAX_PATCH_BYTES,
  sourceIndexKey,
  splitPatch,
} from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

/**
 * Code view: file contents of canonical trees, ChangeSet and Candidate diffs, and the
 * version history. Reads D1, ProjectRootDO, and R2 objects under `source/<project>/` that the
 * integration and agents Workers write (packages/protocol code.ts). Every R2 key is built from
 * the Project ID of a row the caller is a member of, never from request text.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

/** Internal RPC on the integration Worker (service binding `INTEGRATION`). */
type CodeRpc = {
  backfillTreeCode(input: { projectId: string; treeSha: string }): Promise<unknown>;
};

const ProjectIdParam = z.object({ projectId: z.string().regex(/^proj_[a-z0-9-]+$/) });
const ChangeIdParam = z.object({ changeId: z.string().regex(/^chg_[a-z0-9-]+$/) });
const ChangeSetIdParam = z.object({ changeSetId: z.string().regex(/^cs_[A-Za-z0-9_-]+$/) });
const CandidateIdParam = z.object({ candidateId: z.string().regex(/^cand_[a-z0-9]+$/) });
const CodeQuery = z.object({
  tree: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  path: z.string().min(1).max(1024).optional(),
});

const VERSION_LIMIT = 100;
const CHANGESET_LIMIT = 200;
const UNASSIGNED = "unassigned";
/** Bytes scanned for a NUL to call a file binary (same rule as git). */
const BINARY_SNIFF = 8000;

const projectRoot = (env: Env, projectId: string) => {
  const ns = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  return ns.get(ns.idFromName(projectId));
};

async function member(env: Env, subject: string, projectId: string) {
  const { userId } = await ensureIdentity(env.DB, subject);
  return canAccessProject(env.DB, userId, projectId);
}

async function readManifest(env: Env, projectId: string, treeSha: string) {
  const object = await env.EVIDENCE.get(codeManifestKey(projectId, treeSha));
  if (!object) return null;
  const parsed = CodeManifest.safeParse(await object.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

/**
 * The tree's code manifest, backfilled once through the integration Worker when it is missing
 * or partial. Only trees with a file index (they were canonical) or the live tree qualify.
 */
async function loadManifest(env: Env, projectId: string, treeSha: string, live: boolean) {
  const manifest = await readManifest(env, projectId, treeSha);
  if (manifest?.complete) return manifest;
  if (!live && !(await env.EVIDENCE.head(sourceIndexKey(projectId, treeSha)))) return manifest;
  try {
    await (env.INTEGRATION as unknown as CodeRpc).backfillTreeCode({ projectId, treeSha });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "code.backfill_failed",
        projectId,
        error: String(error).slice(0, 200),
      }),
    );
    return manifest;
  }
  return (await readManifest(env, projectId, treeSha)) ?? manifest;
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, BINARY_SNIFF).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

type AttributionRow = {
  id: string;
  change_id: string;
  agent_id: string;
  intent_json: string;
  status: string;
  created_at: string;
  agent_role: string | null;
  task_id: string | null;
  task_key: string | null;
  task_title: string | null;
};

/** ChangeSet `cs_<x>` belongs to Task run `run_<x>` (agents Worker). */
const ATTRIBUTION_SQL = `SELECT cs.id, cs.change_id, cs.agent_id, cs.intent_json, cs.status, cs.created_at,
    a.role AS agent_role, t.id AS task_id, t.task_key, t.title AS task_title
  FROM changesets cs
  LEFT JOIN agents a ON a.id = cs.agent_id
  LEFT JOIN task_runs r ON r.id = 'run_' || substr(cs.id, 4)
  LEFT JOIN tasks t ON t.id = r.task_id`;

function attribution(row: AttributionRow, projectId: string): ChangeSetAttribution {
  let intent: ChangeSetIntent | null = null;
  try {
    const parsed = ChangeSetIntent.safeParse(JSON.parse(row.intent_json));
    intent = parsed.success ? parsed.data : null;
  } catch {}
  const changeSet = intent?.changeSet;
  return {
    id: row.id,
    changeId: row.change_id,
    agentId: row.agent_id,
    agentRole: row.agent_role,
    taskId: row.task_id,
    taskKey: row.task_key,
    taskTitle: row.task_title,
    summary: intent?.summary ?? "",
    status: row.status,
    files: changeSet?.ownFiles ?? changeSet?.files ?? [],
    patchRecorded: changeSet?.patchRef === changeSetPatchKey(projectId, row.id),
    // A human ChangeSet: the person's name, else their user ID. Null for agents.
    editedBy: intent?.actor ? (intent.actor.name ?? intent.actor.id) : null,
    createdAt: row.created_at,
  };
}

async function attributionsById(env: Env, projectId: string, ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await env.DB.prepare(
    `${ATTRIBUTION_SQL} WHERE cs.id IN (SELECT value FROM json_each(?)) ORDER BY cs.created_at LIMIT ?`,
  )
    .bind(JSON.stringify(ids), CHANGESET_LIMIT)
    .all<AttributionRow>();
  return (rows.results ?? []).map((row) => attribution(row, projectId));
}

const NO_DIFF: CodeDiff = {
  recorded: false,
  base: null,
  head: null,
  bytes: 0,
  truncated: false,
  files: [],
};

/** Reads a stored patch and splits it per file. A missing object is "no diff recorded". */
async function readPatch(
  env: Env,
  key: string,
  attribute: (path: string) => string[],
): Promise<CodeDiff> {
  const object = await env.EVIDENCE.get(key);
  if (!object) return NO_DIFF;
  // Writers bound patches to MAX_PATCH_BYTES; anything larger is not ours to parse.
  if (object.size > MAX_PATCH_BYTES * 2) return NO_DIFF;
  const meta = object.customMetadata ?? {};
  const truncated = meta.truncated === "true";
  const text = await object.text();
  const bytes = Number(meta.bytes);
  return {
    recorded: true,
    base: meta.base ?? null,
    head: meta.head ?? null,
    bytes: Number.isInteger(bytes) && bytes >= 0 ? bytes : object.size,
    truncated,
    files: splitPatch(text, truncated).map((file) => ({
      ...file,
      changeSetIds: attribute(file.path),
    })),
  };
}

export const code = new Hono<AppEnv>()
  /**
   * File tree (no `path`) or one file (`path`) of a canonical tree. `tree` defaults to the live
   * canonical tree. A path must be listed in the tree's manifest; nothing else is read.
   */
  .get(
    "/v1/projects/:projectId/code",
    requireAuth,
    validate("param", ProjectIdParam),
    validate("query", CodeQuery),
    async (c) => {
      const { projectId } = c.req.valid("param");
      if (!(await member(c.env, c.get("authSubject"), projectId))) {
        return fail(c, 404, "not_found", "Project not found");
      }
      const query = c.req.valid("query");
      const canonical = await projectRoot(c.env, projectId).getCanonical();
      const liveTree =
        canonical && canonical.artifactRef !== UNASSIGNED ? canonical.treeSha : undefined;
      const treeSha = query.tree ?? liveTree;
      if (!treeSha) return fail(c, 404, "not_found", "Project has no canonical source");
      const live = treeSha === liveTree;
      const manifest = await loadManifest(c.env, projectId, treeSha, live);

      if (query.path === undefined) {
        if (manifest) {
          return respond(c, apiData(CodeView), {
            data: {
              kind: "tree",
              treeSha,
              commit: manifest.commit,
              live,
              contents: manifest.complete ? "complete" : "partial",
              files: manifest.entries.map((e) => ({
                path: e.path,
                size: e.size,
                stored: e.stored,
              })),
            },
          });
        }
        // No manifest yet: list paths from the file index, without contents.
        const index = await c.env.EVIDENCE.get(sourceIndexKey(projectId, treeSha));
        const parsed = index
          ? ((await index.json().catch(() => null)) as { commit?: string; files?: string[] } | null)
          : null;
        if (!parsed) return fail(c, 404, "not_found", "No code is stored for this tree");
        return respond(c, apiData(CodeView), {
          data: {
            kind: "tree",
            treeSha,
            commit: parsed.commit ?? null,
            live,
            contents: "missing",
            files: (parsed.files ?? []).map((path) => ({ path, size: null, stored: false })),
          },
        });
      }

      const entry = manifest?.entries.find((e) => e.path === query.path);
      if (!manifest || !entry) return fail(c, 404, "not_found", "File not found in this tree");
      const base = {
        kind: "file" as const,
        treeSha,
        commit: manifest.commit,
        live,
        path: entry.path,
        blob: entry.blob,
        size: entry.size,
      };
      if (!entry.stored) {
        const tooLarge = entry.size !== null && entry.size > MAX_CODE_BLOB_BYTES;
        return respond(c, apiData(CodeView), {
          data: {
            ...base,
            binary: false,
            content: null,
            unavailable: tooLarge ? "too_large" : "not_stored",
          },
        });
      }
      const object = await c.env.EVIDENCE.get(codeBlobKey(projectId, entry.blob));
      if (!object || object.size > MAX_CODE_BLOB_BYTES) {
        return respond(c, apiData(CodeView), {
          data: { ...base, binary: false, content: null, unavailable: "not_stored" },
        });
      }
      const content = decodeText(new Uint8Array(await object.arrayBuffer()));
      return respond(c, apiData(CodeView), {
        data: {
          ...base,
          binary: content === null,
          content,
          unavailable: content === null ? "binary" : null,
        },
      });
    },
  )

  /** Canonical Generations S0..Sn, newest first, with the Change, Candidate and ChangeSets. */
  .get(
    "/v1/projects/:projectId/versions",
    requireAuth,
    validate("param", ProjectIdParam),
    async (c) => {
      const { projectId } = c.req.valid("param");
      if (!(await member(c.env, c.get("authSubject"), projectId))) {
        return fail(c, 404, "not_found", "Project not found");
      }
      const canonical = await projectRoot(c.env, projectId).getCanonical();
      const liveGeneration = canonical?.generation ?? 0;
      const [promoted, project] = await c.env.DB.batch([
        c.env.DB.prepare(
          `SELECT c.id, c.change_id, c.promoted_generation, c.composed_commit, c.composed_tree,
                  c.base_tree, c.change_set_ids_json, c.updated_at, ch.goal, ch.title,
                  (SELECT r.started_at FROM releases r
                    WHERE r.project_id = ch.project_id AND r.generation = c.promoted_generation
                    LIMIT 1) AS released_at
           FROM candidates c JOIN changes ch ON ch.id = c.change_id
           WHERE ch.project_id = ? AND c.promoted_generation IS NOT NULL
           ORDER BY c.promoted_generation DESC LIMIT ?`,
        ).bind(projectId, VERSION_LIMIT + 1),
        c.env.DB.prepare("SELECT created_at FROM projects WHERE id = ?").bind(projectId),
      ]);
      type Row = {
        id: string;
        change_id: string;
        promoted_generation: number;
        composed_commit: string | null;
        composed_tree: string | null;
        base_tree: string | null;
        change_set_ids_json: string;
        updated_at: string;
        goal: string;
        title: string | null;
        released_at: string | null;
      };
      const all = (promoted?.results ?? []) as Row[];
      const rows = all.slice(0, VERSION_LIMIT);
      const truncated = all.length > VERSION_LIMIT;
      const idsOf = (row: Row) => {
        try {
          return z.array(z.string()).parse(JSON.parse(row.change_set_ids_json));
        } catch {
          return [];
        }
      };
      const sets = await attributionsById(c.env, projectId, rows.flatMap(idsOf));
      const byId = new Map(sets.map((s) => [s.id, s] as const));
      const versions: z.input<typeof CodeVersions>["versions"] = rows.map((row) => ({
        generation: row.promoted_generation,
        treeSha: row.composed_tree,
        commit: row.composed_commit,
        live: row.promoted_generation === liveGeneration,
        at: row.released_at ?? row.updated_at,
        change: { id: row.change_id, goal: row.goal, title: changeTitle(row.title, row.goal) },
        candidateId: row.id,
        changeSets: idsOf(row).flatMap((id) => byId.get(id) ?? []),
      }));

      // S0 is the provisioned tree: the base of the first promotion, or the live tree.
      const first = rows.at(-1);
      const assigned = !!canonical && canonical.artifactRef !== UNASSIGNED;
      if (!truncated && (first ? first.promoted_generation === 1 : assigned)) {
        const s0Tree = first ? first.base_tree : (canonical?.treeSha ?? null);
        const index = s0Tree ? await c.env.EVIDENCE.get(sourceIndexKey(projectId, s0Tree)) : null;
        const commit = index
          ? (((await index.json().catch(() => null)) as { commit?: string } | null)?.commit ?? null)
          : null;
        const created = project?.results?.[0] as { created_at?: string } | undefined;
        versions.push({
          generation: 0,
          treeSha: s0Tree,
          commit,
          live: liveGeneration === 0,
          at: created?.created_at ?? null,
          change: null,
          candidateId: null,
          changeSets: [],
        });
      }
      return respond(c, apiData(CodeVersions), { data: { liveGeneration, versions, truncated } });
    },
  )

  /** ChangeSets of one Change with their agent and Intent, for the Files changed section. */
  .get(
    "/v1/changes/:changeId/changesets",
    requireAuth,
    validate("param", ChangeIdParam),
    async (c) => {
      const { changeId } = c.req.valid("param");
      const change = await c.env.DB.prepare("SELECT project_id FROM changes WHERE id = ?")
        .bind(changeId)
        .first<{ project_id: string }>();
      if (!change || !(await member(c.env, c.get("authSubject"), change.project_id))) {
        return fail(c, 404, "not_found", "Change not found");
      }
      const rows = await c.env.DB.prepare(
        `${ATTRIBUTION_SQL} WHERE cs.change_id = ? ORDER BY cs.created_at LIMIT ?`,
      )
        .bind(changeId, CHANGESET_LIMIT)
        .all<AttributionRow>();
      return respond(c, apiData(z.array(ChangeSetAttribution)), {
        data: (rows.results ?? []).map((row) => attribution(row, change.project_id)),
      });
    },
  )

  /** The stored `git diff` of one ChangeSet, split per file. */
  .get(
    "/v1/changesets/:changeSetId/diff",
    requireAuth,
    validate("param", ChangeSetIdParam),
    async (c) => {
      const { changeSetId } = c.req.valid("param");
      const owner = await c.env.DB.prepare(
        "SELECT ch.project_id FROM changesets cs JOIN changes ch ON ch.id = cs.change_id WHERE cs.id = ?",
      )
        .bind(changeSetId)
        .first<{ project_id: string }>();
      if (!owner || !(await member(c.env, c.get("authSubject"), owner.project_id))) {
        return fail(c, 404, "not_found", "ChangeSet not found");
      }
      const [changeSet] = await attributionsById(c.env, owner.project_id, [changeSetId]);
      if (!changeSet) return fail(c, 404, "not_found", "ChangeSet not found");
      const diff = changeSet.patchRecorded
        ? await readPatch(c.env, changeSetPatchKey(owner.project_id, changeSetId), () => [
            changeSetId,
          ])
        : NO_DIFF;
      return respond(c, apiData(ChangeSetDiffView), { data: { changeSet, diff } });
    },
  )

  /** The stored Candidate-vs-base diff, each file attributed to the ChangeSets that changed it. */
  .get(
    "/v1/candidates/:candidateId/diff",
    requireAuth,
    validate("param", CandidateIdParam),
    async (c) => {
      const { candidateId } = c.req.valid("param");
      const row = await c.env.DB.prepare(
        `SELECT c.id, c.change_id, c.base_generation, c.composed_commit, c.change_set_ids_json,
                ch.project_id
         FROM candidates c JOIN changes ch ON ch.id = c.change_id WHERE c.id = ?`,
      )
        .bind(candidateId)
        .first<{
          id: string;
          change_id: string;
          base_generation: number;
          composed_commit: string | null;
          change_set_ids_json: string;
          project_id: string;
        }>();
      if (!row || !(await member(c.env, c.get("authSubject"), row.project_id))) {
        return fail(c, 404, "not_found", "Candidate not found");
      }
      let ids: string[] = [];
      try {
        ids = z.array(z.string()).parse(JSON.parse(row.change_set_ids_json));
      } catch {}
      const changeSets = await attributionsById(c.env, row.project_id, ids);
      const diff = await readPatch(c.env, candidatePatchKey(row.project_id, candidateId), (path) =>
        changeSets.filter((s) => s.files.includes(path)).map((s) => s.id),
      );
      return respond(c, apiData(CandidateDiffView), {
        data: {
          candidateId,
          changeId: row.change_id,
          baseGeneration: row.base_generation,
          composedCommit: row.composed_commit,
          changeSets,
          diff,
        },
      });
    },
  );
