import {
  EMBEDDING_DIMENSIONS,
  indexKeys,
  indexPrefix,
  type VectorManifest,
  vectorManifestKey,
} from "@rhumbatron/context-compiler";
import { buildIndexes, type OwnerRow } from "./build.ts";
import type { SourceTree } from "./source.ts";
import { planVectors, vectorMetadata } from "./vectors.ts";

/**
 * Index build and purge (AGENTS.md section 12.7). Commands arrive on `rhumbatron-indexing`:
 *
 * - `index.build` {treeSha}: from the Causal Router on `artifact.promoted` (provisioned source)
 *   and `canonical.advanced` (promotion). Builds only the current canonical tree, once.
 * - `index.purge`: from the daily maintenance tick for archived Projects. Deletes the Project's
 *   vectors and `index/<project>/` objects.
 *
 * Exact indexes are the product; Vectorize is optional. A Vectorize or Workers AI failure leaves
 * the index `ready` with `vector_status = 'error'`; the next tree retries the vectors, because the
 * manifest only moves after a successful write.
 *
 * Free-limit guards (rule 50): at most 500 files per build, at most VECTOR_ACCOUNT_CAP vectors in
 * the account (Vectorize free: 5M stored dimensions = 13,020 vectors of 384), and at most
 * EMBED_DAILY_CAP embedded texts per UTC day (Workers AI free: 10,000 Neurons per day).
 */

/** 10,000 x 384 = 3.84M stored dimensions, under the 5M free allowance with headroom. */
const VECTOR_ACCOUNT_CAP = 10_000;
/** About 200 tokens each: at most about 740 Neurons per day for bge-small-en-v1.5. */
const EMBED_DAILY_CAP = 2_000;
/** Workers AI text-embedding batch, and the Vectorize write batch. */
const BATCH = 100;
const OWNER_ROW_LIMIT = 500;
/** Ready indexes kept per Project; older trees' objects are deleted (dev retention, section 43). */
const KEEP_INDEXES = 3;

export class RetryLater extends Error {}

export type Bucket = {
  getJson(key: string): Promise<unknown | null>;
  putJson(key: string, value: unknown): Promise<void>;
  list(prefix: string): Promise<string[]>;
  delete(keys: string[]): Promise<void>;
};

export type IndexerDeps = {
  db: D1Database;
  bucket: Bucket;
  /** Current canonical state from ProjectRootDO, or null when the Project has none. */
  canonical(projectId: string): Promise<{ treeSha: string; generation: number } | null>;
  readSource(projectId: string, commit: string, treeSha: string): Promise<SourceTree>;
  memory?: {
    upsert(vectors: VectorizeVector[]): Promise<unknown>;
    deleteByIds(ids: string[]): Promise<unknown>;
  };
  embed?: (texts: string[]) => Promise<number[][]>;
  metric?: (point: AnalyticsEngineDataPoint) => void;
  now(): string;
};

export type VectorStatus =
  | "ok"
  | "unchanged"
  | "skipped_cap"
  | "skipped_quota"
  | "unbound"
  | "error";

export type BuildOutcome =
  | { result: "exists" | "superseded" | "no_source" }
  | {
      result: "built";
      files: number;
      symbols: number;
      edges: number;
      vectorStatus: VectorStatus;
      embedded: number;
      removed: number;
    };

const day = (now: string) => now.slice(0, 10);

/** Adds `n` to a daily counter only if the total stays at or under `cap`. */
async function takeDaily(db: D1Database, now: string, counter: string, n: number, cap: number) {
  if (n === 0) return true;
  const row = await db
    .prepare(
      `INSERT INTO usage_counters (day, counter, count) SELECT ?, ?, ? WHERE ? <= ?
       ON CONFLICT (day, counter) DO UPDATE SET count = count + excluded.count
       WHERE count + excluded.count <= ?
       RETURNING count`,
    )
    .bind(day(now), counter, n, n, cap, cap)
    .first<{ count: number }>();
  return row !== null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Resources and files of the ChangeSets of every Candidate promoted up to `generation`. */
async function ownerRows(
  db: D1Database,
  projectId: string,
  generation: number,
): Promise<OwnerRow[]> {
  const rows = await db
    .prepare(
      `SELECT cs.resources_json, cs.intent_json FROM candidates c
       JOIN changes ch ON ch.id = c.change_id
       JOIN changesets cs ON cs.change_id = c.change_id
       WHERE ch.project_id = ? AND c.status = 'promoted' AND c.promoted_generation <= ?
         AND EXISTS (SELECT 1 FROM json_each(c.change_set_ids_json) j WHERE j.value = cs.id)
       ORDER BY c.promoted_generation, cs.id LIMIT ${OWNER_ROW_LIMIT}`,
    )
    .bind(projectId, generation)
    .all<{ resources_json: string; intent_json: string }>();
  return (rows.results ?? []).map((r) => {
    let intent: {
      expectedFiles?: unknown;
      semanticResources?: unknown;
      changeSet?: { files?: unknown };
    } = {};
    try {
      intent = JSON.parse(r.intent_json) as typeof intent;
    } catch {}
    let resources: string[] = [];
    try {
      resources = stringList(JSON.parse(r.resources_json));
    } catch {}
    return {
      resources: [...new Set([...resources, ...stringList(intent.semanticResources)])],
      files: [
        ...new Set([...stringList(intent.changeSet?.files), ...stringList(intent.expectedFiles)]),
      ],
    };
  });
}

async function syncVectors(
  deps: IndexerDeps,
  projectId: string,
  treeSha: string,
  files: Parameters<typeof planVectors>[3],
): Promise<{ status: VectorStatus; embedded: number; removed: number }> {
  const { memory, embed } = deps;
  if (!memory || !embed) return { status: "unbound", embedded: 0, removed: 0 };
  const previous = (await deps.bucket.getJson(
    vectorManifestKey(projectId),
  )) as VectorManifest | null;
  const plan = await planVectors(projectId, treeSha, previous, files);
  if (plan.upsert.length === 0 && plan.remove.length === 0) {
    return { status: "unchanged", embedded: 0, removed: 0 };
  }

  const others = await deps.db
    .prepare(
      "SELECT COALESCE(SUM(vector_count), 0) AS n FROM project_vectors WHERE project_id != ?",
    )
    .bind(projectId)
    .first<{ n: number }>();
  const count = Object.keys(plan.next.entries).length;
  if ((others?.n ?? 0) + count > VECTOR_ACCOUNT_CAP) {
    return { status: "skipped_cap", embedded: 0, removed: 0 };
  }
  if (!(await takeDaily(deps.db, deps.now(), "index-embed", plan.upsert.length, EMBED_DAILY_CAP))) {
    return { status: "skipped_quota", embedded: 0, removed: 0 };
  }

  try {
    for (let i = 0; i < plan.upsert.length; i += BATCH) {
      const batch = plan.upsert.slice(i, i + BATCH);
      const values = await embed(batch.map((u) => u.text));
      if (values.length !== batch.length || values.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
        throw new Error("embedding shape mismatch");
      }
      await memory.upsert(
        batch.map((u, j) => ({
          id: u.id,
          values: values[j] ?? [],
          namespace: projectId,
          metadata: vectorMetadata(projectId, treeSha, u.file.path),
        })),
      );
    }
    for (let i = 0; i < plan.remove.length; i += BATCH) {
      await memory.deleteByIds(plan.remove.slice(i, i + BATCH));
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "indexer.vectors_failed",
        projectId,
        error: String(error).slice(0, 300),
      }),
    );
    return { status: "error", embedded: 0, removed: 0 };
  }

  // The manifest moves only after every write succeeded.
  await deps.bucket.putJson(vectorManifestKey(projectId), plan.next);
  await deps.db
    .prepare(
      `INSERT INTO project_vectors (project_id, tree_sha, vector_count, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE SET tree_sha = excluded.tree_sha,
         vector_count = excluded.vector_count, updated_at = excluded.updated_at`,
    )
    .bind(projectId, treeSha, count, deps.now())
    .run();
  return { status: "ok", embedded: plan.upsert.length, removed: plan.remove.length };
}

/**
 * Builds the index of `treeSha`, or of the current canonical tree when `treeSha` is null (daily
 * backfill for Projects without a ready index).
 */
export async function buildIndex(
  deps: IndexerDeps,
  projectId: string,
  requested: string | null,
): Promise<BuildOutcome> {
  let treeSha = requested;
  if (treeSha === null) {
    const current = await deps.canonical(projectId);
    if (!current) return { result: "no_source" };
    treeSha = current.treeSha;
  }
  const existing = await deps.db
    .prepare("SELECT status FROM project_indexes WHERE project_id = ? AND tree_sha = ?")
    .bind(projectId, treeSha)
    .first<{ status: string }>();
  if (existing?.status === "ready") return { result: "exists" };

  const canonical = await deps.canonical(projectId);
  if (!canonical) return { result: "no_source" };
  // Only the current canonical tree is worth indexing; a newer event builds the newer tree.
  if (canonical.treeSha !== treeSha) return { result: "superseded" };

  // Written by the integration Worker once the commit is on canonical `main` (ADR 0010).
  const pointer = (await deps.bucket.getJson(`source/${projectId}/${treeSha}/index.json`)) as {
    commit?: string;
  } | null;
  if (!pointer?.commit) throw new RetryLater("canonical source index not written yet");

  const started = Date.now();
  const source = await deps.readSource(projectId, pointer.commit, treeSha);
  const built = buildIndexes({
    projectId,
    treeSha,
    commit: pointer.commit,
    truncated: source.truncated,
    files: source.files,
    owners: await ownerRows(deps.db, projectId, canonical.generation),
  });
  const keys = indexKeys(projectId, treeSha);
  await deps.bucket.putJson(keys.symbols, built.symbols);
  await deps.bucket.putJson(keys.deps, built.deps);
  await deps.bucket.putJson(keys.productGraph, built.graph);

  const vectors = await syncVectors(deps, projectId, treeSha, built.symbols.files);
  const symbolCount = built.symbols.files.reduce((n, f) => n + f.declarations.length, 0);
  const now = deps.now();
  await deps.db
    .prepare(
      `INSERT INTO project_indexes (project_id, tree_sha, commit_sha, status, r2_prefix, file_count,
         symbol_count, vector_status, error, built_at)
       VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, NULL, ?)
       ON CONFLICT (project_id, tree_sha) DO UPDATE SET commit_sha = excluded.commit_sha,
         status = 'ready', r2_prefix = excluded.r2_prefix, file_count = excluded.file_count,
         symbol_count = excluded.symbol_count, vector_status = excluded.vector_status, error = NULL,
         built_at = excluded.built_at
       WHERE project_indexes.status != 'ready'`,
    )
    .bind(
      projectId,
      treeSha,
      pointer.commit,
      indexPrefix(projectId, treeSha),
      built.symbols.files.length,
      symbolCount,
      vectors.status,
      now,
    )
    .run();

  const pruned = await pruneIndexes(deps, projectId);

  deps.metric?.({
    blobs: ["index_build", vectors.status, source.truncated ? "truncated" : "complete"],
    doubles: [
      built.symbols.files.length,
      symbolCount,
      built.graph.edges.length,
      vectors.embedded,
      vectors.removed,
      Date.now() - started,
      pruned,
    ],
    indexes: [projectId],
  });
  return {
    result: "built",
    files: built.symbols.files.length,
    symbols: symbolCount,
    edges: built.graph.edges.length,
    vectorStatus: vectors.status,
    embedded: vectors.embedded,
    removed: vectors.removed,
  };
}

/** Keeps the newest KEEP_INDEXES ready indexes of a Project; deletes the objects of older trees. */
async function pruneIndexes(deps: IndexerDeps, projectId: string): Promise<number> {
  const old = await deps.db
    .prepare(
      `SELECT tree_sha FROM project_indexes WHERE project_id = ? AND status = 'ready'
       ORDER BY built_at DESC, tree_sha LIMIT -1 OFFSET ${KEEP_INDEXES}`,
    )
    .bind(projectId)
    .all<{ tree_sha: string }>();
  const trees = (old.results ?? []).map((r) => r.tree_sha);
  if (trees.length === 0) return 0;
  await deps.bucket.delete(trees.flatMap((t) => Object.values(indexKeys(projectId, t))));
  await deps.db.batch(
    trees.map((t) =>
      deps.db
        .prepare(
          "UPDATE project_indexes SET status = 'purged' WHERE project_id = ? AND tree_sha = ?",
        )
        .bind(projectId, t),
    ),
  );
  return trees.length;
}

/** Records a build that failed on its last delivery, so the failure is visible, not silent. */
export async function recordFailure(
  deps: Pick<IndexerDeps, "db" | "now">,
  projectId: string,
  treeSha: string,
  error: string,
) {
  await deps.db
    .prepare(
      `INSERT INTO project_indexes (project_id, tree_sha, status, r2_prefix, error, built_at)
       VALUES (?, ?, 'failed', ?, ?, ?)
       ON CONFLICT (project_id, tree_sha) DO UPDATE SET status = 'failed', error = excluded.error,
         built_at = excluded.built_at
       WHERE project_indexes.status = 'failed'`,
    )
    .bind(projectId, treeSha, indexPrefix(projectId, treeSha), error.slice(0, 500), deps.now())
    .run();
}

/** Deletes an archived Project's vectors and index objects. Safe to repeat. */
export async function purgeIndex(
  deps: Pick<IndexerDeps, "db" | "bucket" | "memory" | "now">,
  projectId: string,
): Promise<{ vectors: number; objects: number }> {
  const manifest = (await deps.bucket.getJson(
    vectorManifestKey(projectId),
  )) as VectorManifest | null;
  const ids = Object.values(manifest?.entries ?? {}).map((e) => e.id);
  if (ids.length > 0) {
    if (!deps.memory) throw new RetryLater("vectors exist but MEMORY is not bound");
    for (let i = 0; i < ids.length; i += BATCH)
      await deps.memory.deleteByIds(ids.slice(i, i + BATCH));
  }
  const manifestKey = vectorManifestKey(projectId);
  const keys = (await deps.bucket.list(`index/${projectId}/`)).filter((k) => k !== manifestKey);
  if (keys.length > 0) await deps.bucket.delete(keys);
  // The manifest goes last, so a failed purge still knows which vectors to delete.
  await deps.bucket.delete([manifestKey]);
  await deps.db.batch([
    deps.db
      .prepare("UPDATE project_indexes SET status = 'purged' WHERE project_id = ?")
      .bind(projectId),
    deps.db.prepare("DELETE FROM project_vectors WHERE project_id = ?").bind(projectId),
  ]);
  return { vectors: ids.length, objects: keys.length };
}
