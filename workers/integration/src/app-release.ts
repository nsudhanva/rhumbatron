import {
  APP_PRODUCTION_CHANNEL,
  type AppBuildResult,
  type AppDeploymentStatus,
  type AppSourceFile,
  isAppBuildInput,
  previewChannel,
  versionPreviewId,
} from "@rhumbatron/protocol";
import {
  decidePointerMove,
  type PointerDecision,
  type PointerMove,
  type PointerState,
  type PointerTarget,
  type PreviewSlot,
  planPreview,
} from "./app-release-model.ts";
import { walkTree } from "./code-store.ts";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";
import { judgeProbe, type Probe, type ProbeResult } from "./release-model.ts";
import { candidateFork } from "./repo-names.ts";

/**
 * Live app releases (Phase 16 milestone B, ADR 0020): Candidate previews (P16-10), the production
 * pointer after promotion and its smoke check (P16-11, P16-12), version hosts (P16-13), app removal
 * (P16-20), and preview expiry (P16-22). Prod only: every entry point is a no-op without the `APPS`
 * binding, so dev builds, checks, and promotes Projects without hosting them.
 *
 * Writes are runtime data (D1 `app_deployments`, R2 bundles), never Terraform.
 * Every write is guarded and safe to repeat: rows are keyed by Project and channel, bundles by
 * commit, and the pointer moves only by compare-and-swap on the row it read.
 *
 * Cost per preview or rebuilt production bundle: one Artifacts read per tree and per source file
 * (about 25 for Acme), a few R2 writes, and one builder RPC, within the daily build cap. A
 * production bundle copied from a preview costs only R2 operations.
 */

const ACTOR = { kind: "system", id: "app-release" } as const;
const MAX_FILES = 400;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
/** Preview rows and bundles live 7 days (the R2 lifecycle rule on `app-previews/`). */
const PREVIEW_RETENTION_DAYS = 7;
/** Data stores wiped and rows deleted per command delivery (one Durable Object call each). */
const WIPES_PER_PASS = 25;
const R2_PAGE = 1000;

/** Daily cap on app bundle builds (P16-21): each reads source from Artifacts and runs esbuild. */
export const APP_BUILDS_PER_DAY = 60;

/** Takes one build from today's meter. False when the cap is reached: the build does not run. */
export async function reserveAppBuild(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO usage_counters (day, counter, count) VALUES (?, 'app-builds', 1)
       ON CONFLICT (day, counter) DO UPDATE SET count = count + 1 WHERE count + 1 <= ?
       RETURNING count`,
    )
    .bind(new Date().toISOString().slice(0, 10), APP_BUILDS_PER_DAY)
    .first<{ count: number }>();
  return row !== null;
}

/** One build input: UTF-8 text when it decodes, else base64. */
export function toSourceFile(path: string, buffer: ArrayBuffer): AppSourceFile {
  try {
    return {
      path,
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buffer),
    };
  } catch {
    let binary = "";
    const view = new Uint8Array(buffer);
    for (let i = 0; i < view.length; i += 0x8000) {
      binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
    }
    return { path, base64: btoa(binary) };
  }
}

/**
 * The commit a canonical ref names (`artifacts://<project>@<commit>`), or null for `@main`. After
 * a rollback the tree's file index can name an older commit with the same tree; this one is on
 * `main`.
 */
export function canonicalCommitOf(artifactRef: string): string | null {
  const match = /@([0-9a-f]{40})$/.exec(artifactRef);
  return match?.[1] ?? null;
}

/** Reads the build inputs of one tree from an Artifacts repo: one read per directory and file. */
async function readTreeSource(
  env: Env,
  repoName: string,
  treeSha: string,
): Promise<AppSourceFile[]> {
  using repo = await env.ARTIFACTS.get(repoName);
  const entries = (await walkTree(repo, treeSha)).filter((e) => isAppBuildInput(e.path));
  const files: AppSourceFile[] = [];
  let bytes = 0;
  for (const entry of entries.slice(0, MAX_FILES)) {
    const blob = await repo.readBlob(entry.blob);
    if (!blob) continue;
    const buffer = await blob.arrayBuffer();
    bytes += buffer.byteLength;
    if (bytes > MAX_SOURCE_BYTES) throw new Error("source is larger than 8 MB");
    files.push(toSourceFile(entry.path, buffer));
  }
  return files;
}

type AppRow = {
  project_id: string;
  slug: string;
  channel: string;
  commit_sha: string | null;
  generation: number | null;
  bundle_key: string | null;
  status: AppDeploymentStatus;
};

/** The production row of a Project, or null when it has no app. */
export async function productionRow(env: Env, projectId: string): Promise<AppRow | null> {
  return env.DB.prepare(
    `SELECT project_id, slug, channel, commit_sha, generation, bundle_key, status
     FROM app_deployments WHERE project_id = ? AND channel = ?`,
  )
    .bind(projectId, APP_PRODUCTION_CHANNEL)
    .first<AppRow>();
}

/** True when promotions of this Project release to its live app (prod, app not removed). */
export async function hasLiveApp(env: Env, projectId: string): Promise<boolean> {
  if (!env.APPS) return false;
  const row = await productionRow(env, projectId);
  return !!row && row.status !== "removed";
}

/** Data store name of a channel; the router derives the same (workers/apps/src/pointer.ts). */
const storeName = (projectId: string, channel: string) =>
  channel === APP_PRODUCTION_CHANNEL ? projectId : `${projectId}#${channel}`;

/* ------------------------------------------------------------------------------------------ */
/* Previews (P16-10)                                                                           */
/* ------------------------------------------------------------------------------------------ */

export type PreviewOutcome =
  | { status: "disabled" | "no_app" | "limit" | "current" }
  | { status: "ready"; channel: string; label: string; reused: boolean }
  | { status: "failed"; channel: string; reason: string };

/**
 * Builds the Candidate's composed commit and points its preview host at it
 * (`<preview-id>--<label>`). At most MAX_PREVIEWS_PER_CHANGE previews per Change. The preview has
 * its own data store, so it never reads or writes production data. A failed build marks only the
 * preview row; it never changes the Candidate's verification result.
 */
export async function publishPreview(
  env: Env,
  ctx: ChangeContext,
  input: { candidateId: string; commit: string; treeSha: string },
): Promise<PreviewOutcome> {
  if (!env.APPS) return { status: "disabled" };
  const production = await productionRow(env, ctx.projectId);
  if (!production || production.status === "removed") return { status: "no_app" };

  const { results } = await env.DB.prepare(
    `SELECT d.channel, d.candidate_id, c.status AS candidate_status, d.updated_at,
            d.commit_sha, d.status
     FROM app_deployments d LEFT JOIN candidates c ON c.id = d.candidate_id
     WHERE d.project_id = ? AND d.change_id = ?`,
  )
    .bind(ctx.projectId, ctx.changeId)
    .all<{
      channel: string;
      candidate_id: string | null;
      candidate_status: string | null;
      updated_at: string;
      commit_sha: string | null;
      status: string;
    }>();
  const previews: PreviewSlot[] = results.map((r) => ({
    channel: r.channel,
    candidateId: r.candidate_id,
    candidateStatus: r.candidate_status,
    updatedAt: r.updated_at,
  }));
  const plan = planPreview({ candidateId: input.candidateId, previews });
  if (plan.kind === "skip") return { status: "limit" };
  const existing = results.find((r) => r.channel === plan.channel);
  if (existing?.status === "ready" && existing.commit_sha === input.commit) {
    return { status: "current" };
  }
  if (plan.kind === "new" && plan.evict.length > 0)
    await removeChannels(env, ctx.projectId, plan.evict);

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO app_deployments (project_id, slug, channel, commit_sha, status, candidate_id,
       change_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'building', ?, ?, ?, ?)
     ON CONFLICT (project_id, channel) DO UPDATE SET status = 'building', failure_reason = NULL,
       commit_sha = CASE WHEN bundle_key IS NULL THEN excluded.commit_sha ELSE commit_sha END,
       updated_at = excluded.updated_at`,
  )
    .bind(
      ctx.projectId,
      production.slug,
      plan.channel,
      input.commit,
      input.candidateId,
      ctx.changeId,
      now,
      now,
    )
    .run();

  let result: AppBuildResult;
  try {
    if (!(await reserveAppBuild(env.DB))) {
      throw new Error(`the daily app build cap (${APP_BUILDS_PER_DAY}) is reached`);
    }
    result = await env.APPS.build({
      projectId: ctx.projectId,
      commit: input.commit,
      treeSha: input.treeSha,
      channel: "preview",
      files: await readTreeSource(env, candidateFork(input.candidateId), input.treeSha),
    });
  } catch (error) {
    result = { ok: false, reason: String(error).slice(0, 400) };
  }
  const at = new Date().toISOString();
  if (!result.ok) {
    await env.DB.prepare(
      `UPDATE app_deployments SET status = 'failed', failure_reason = ?, updated_at = ?
       WHERE project_id = ? AND channel = ? AND status != 'removed'`,
    )
      .bind(result.reason, at, ctx.projectId, plan.channel)
      .run();
    return { status: "failed", channel: plan.channel, reason: result.reason };
  }
  await env.DB.prepare(
    `UPDATE app_deployments SET status = 'ready', commit_sha = ?, bundle_key = ?, bundle_bytes = ?,
       failure_reason = NULL, updated_at = ?
     WHERE project_id = ? AND channel = ? AND status != 'removed'`,
  )
    .bind(input.commit, result.bundleKey, result.bytes, at, ctx.projectId, plan.channel)
    .run();
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "preview.ready",
      {
        candidateId: input.candidateId,
        channel: plan.channel,
        label: production.slug,
        commit: input.commit,
      },
      { key: input.candidateId, actor: ACTOR },
    ),
  ]);
  return { status: "ready", channel: plan.channel, label: production.slug, reused: result.reused };
}

/** Wipes the data stores of preview channels and deletes their rows. Bundles expire in R2. */
async function removeChannels(env: Env, projectId: string, channels: readonly string[]) {
  const previews = channels.filter((c) => c.startsWith("preview:"));
  if (previews.length === 0) return;
  await env.APPS?.wipeData(previews.map((c) => storeName(projectId, c)));
  await env.DB.prepare(
    `DELETE FROM app_deployments WHERE project_id = ? AND channel IN (SELECT value FROM json_each(?))`,
  )
    .bind(projectId, JSON.stringify(previews))
    .run();
}

/* ------------------------------------------------------------------------------------------ */
/* Production bundle and pointer (P16-11, P16-12)                                             */
/* ------------------------------------------------------------------------------------------ */

const bundleJson = (key: string) => `${key}/bundle.json`;

export type ProductionBundle =
  | {
      ok: true;
      bundleKey: string;
      bytes: number | null;
      source: "stored" | "same_tree" | "copied" | "built";
    }
  | { ok: false; reason: string };

/** Copies a preview bundle to the production prefix; `bundle.json` last (a complete bundle). */
async function copyBundle(bucket: R2Bucket, from: string, to: string): Promise<number> {
  let cursor: string | undefined;
  let bytes = 0;
  do {
    const page = await bucket.list({
      prefix: `${from}/assets/`,
      limit: R2_PAGE,
      ...(cursor ? { cursor } : {}),
    });
    for (const object of page.objects) {
      const source = await bucket.get(object.key);
      if (!source) throw new Error(`asset ${object.key} disappeared during the copy`);
      await bucket.put(`${to}${object.key.slice(from.length)}`, source.body, {
        httpMetadata: source.httpMetadata ?? {},
      });
      bytes += object.size;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const manifest = await bucket.get(bundleJson(from));
  if (!manifest) throw new Error("the preview bundle is incomplete");
  const text = await manifest.text();
  await bucket.put(bundleJson(to), text, { httpMetadata: { contentType: "application/json" } });
  return bytes + text.length;
}

/**
 * The production bundle of a promoted commit, in order of cost: the stored bundle of the commit;
 * a stored bundle of another commit with the same tree (a rollback: Sk's bundle serves Sk+n's
 * identical tree, no rebuild); the Candidate's preview bundle, copied (previews expire after 7
 * days); else a build from canonical source.
 */
export async function ensureProductionBundle(
  env: Env,
  input: {
    projectId: string;
    commit: string;
    treeSha: string;
    rollbackOfGeneration: number | null;
  },
): Promise<ProductionBundle> {
  if (!env.APPS) return { ok: false, reason: "Live apps are not enabled here." };
  const own = `apps/${input.projectId}/${input.commit}`;
  if (await env.EVIDENCE.head(bundleJson(own))) {
    return { ok: true, bundleKey: own, bytes: null, source: "stored" };
  }

  // Same tree: promoted Candidates with this tree, and the version row of a rollback target.
  const [sameTree, version] = await env.DB.batch([
    env.DB.prepare(
      `SELECT c.composed_commit AS commit_sha FROM candidates c JOIN changes ch ON ch.id = c.change_id
       WHERE ch.project_id = ? AND c.composed_tree = ? AND c.status = 'promoted'
         AND c.composed_commit IS NOT NULL AND c.composed_commit != ?
       ORDER BY c.promoted_generation DESC LIMIT 5`,
    ).bind(input.projectId, input.treeSha, input.commit),
    env.DB.prepare(
      "SELECT bundle_key FROM app_deployments WHERE project_id = ? AND channel = ? AND status = 'ready'",
    ).bind(
      input.projectId,
      input.rollbackOfGeneration === null
        ? ""
        : previewChannel(versionPreviewId(input.rollbackOfGeneration) ?? ""),
    ),
  ]);
  const keys = [
    ...((version?.results ?? []) as { bundle_key: string | null }[]).map((r) => r.bundle_key),
    ...((sameTree?.results ?? []) as { commit_sha: string }[]).map(
      (r) => `apps/${input.projectId}/${r.commit_sha}`,
    ),
  ].filter((k): k is string => !!k?.startsWith(`apps/${input.projectId}/`));
  for (const key of keys) {
    const stored = await env.EVIDENCE.get(bundleJson(key));
    if (!stored) continue;
    const bundle = (await stored.json().catch(() => null)) as { treeSha?: string } | null;
    if (bundle?.treeSha === input.treeSha) {
      return { ok: true, bundleKey: key, bytes: null, source: "same_tree" };
    }
  }

  const preview = `app-previews/${input.projectId}/${input.commit}`;
  if (await env.EVIDENCE.head(bundleJson(preview))) {
    try {
      const bytes = await copyBundle(env.EVIDENCE, preview, own);
      return { ok: true, bundleKey: own, bytes, source: "copied" };
    } catch (error) {
      // The preview expired mid-copy: rebuild below.
      console.warn(
        JSON.stringify({ event: "app.copy_failed", message: String(error).slice(0, 200) }),
      );
    }
  }

  if (!(await reserveAppBuild(env.DB))) {
    return { ok: false, reason: `The daily app build cap (${APP_BUILDS_PER_DAY}) is reached.` };
  }
  try {
    const result = await env.APPS.build({
      projectId: input.projectId,
      commit: input.commit,
      treeSha: input.treeSha,
      channel: "production",
      files: await readTreeSource(env, input.projectId, input.treeSha),
    });
    return result.ok
      ? { ok: true, bundleKey: result.bundleKey, bytes: result.bytes, source: "built" }
      : { ok: false, reason: result.reason };
  } catch (error) {
    return { ok: false, reason: `Build did not finish: ${String(error).slice(0, 300)}` };
  }
}

export type PointerOutcome = {
  decision: PointerDecision;
  /** What production served before this transition. */
  previous: PointerState;
  label: string | null;
};

/**
 * Applies one pointer transition by compare-and-swap on the row it read, so a concurrent release
 * or revert can never be overwritten blindly. A lost race throws; the caller's workflow step
 * retries and decides again from the new row.
 */
export async function movePointer(
  env: Env,
  projectId: string,
  move: PointerMove,
  bytes: number | null = null,
): Promise<PointerOutcome> {
  const row = await productionRow(env, projectId);
  const previous: PointerState = row
    ? {
        commit: row.commit_sha,
        bundleKey: row.bundle_key,
        generation: row.generation,
        status: row.status,
      }
    : null;
  const decision = decidePointerMove(previous, move);
  if (decision.kind !== "move") return { decision, previous, label: row?.slug ?? null };
  const { to } = decision;
  const updated = await env.DB.prepare(
    `UPDATE app_deployments SET commit_sha = ?, bundle_key = ?, generation = ?, status = 'ready',
       failure_reason = NULL, bundle_bytes = COALESCE(?, bundle_bytes), updated_at = ?
     WHERE project_id = ? AND channel = ? AND status != 'removed'
       AND commit_sha IS ? AND bundle_key IS ? AND generation IS ?`,
  )
    .bind(
      to.commit,
      to.bundleKey,
      to.generation,
      bytes,
      new Date().toISOString(),
      projectId,
      APP_PRODUCTION_CHANNEL,
      previous?.commit ?? null,
      previous?.bundleKey ?? null,
      previous?.generation ?? null,
    )
    .run();
  if (!updated.meta.changes) throw new Error("The production pointer changed concurrently");
  return { decision, previous, label: row?.slug ?? null };
}

/**
 * The version host row of one generation (`preview:v<generation>`), for the Versions page "Open"
 * link. It points at the production bundle (never expires) and has its own data store.
 */
export async function upsertVersionRow(
  env: Env,
  input: { projectId: string; label: string; target: PointerTarget; bytes: number | null },
) {
  const id = versionPreviewId(input.target.generation);
  if (!id) return;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO app_deployments (project_id, slug, channel, commit_sha, generation, bundle_key,
       status, bundle_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)
     ON CONFLICT (project_id, channel) DO UPDATE SET commit_sha = excluded.commit_sha,
       generation = excluded.generation, bundle_key = excluded.bundle_key, status = 'ready',
       bundle_bytes = COALESCE(excluded.bundle_bytes, bundle_bytes), updated_at = excluded.updated_at
     WHERE app_deployments.status != 'removed'`,
  )
    .bind(
      input.projectId,
      input.label,
      previewChannel(id),
      input.target.commit,
      input.target.generation,
      input.target.bundleKey,
      input.bytes,
      now,
      now,
    )
    .run();
}

/** Runs release or preview GET probes through the apps router (no Internet). */
export async function probeApp(
  env: Env,
  label: string,
  probes: readonly Probe[],
  previewId?: string,
): Promise<ProbeResult[]> {
  const apps = env.APPS;
  if (!apps) return [];
  return Promise.all(
    probes.map(async (probe): Promise<ProbeResult> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          apps.probe({
            label,
            path: probe.path,
            ...(previewId ? { previewId } : {}),
            ...(probe.headers ? { headers: probe.headers } : {}),
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("probe timed out after 10 seconds")), 10_000);
          }),
        ]);
        if (result.status === null) {
          return { probe, status: null, ok: false, detail: result.error.slice(0, 120) };
        }
        return judgeProbe(probe, result.status, result.body);
      } catch (error) {
        return { probe, status: null, ok: false, detail: String(error).slice(0, 120) };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }),
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Removal and expiry (P16-20, P16-22)                                                        */
/* ------------------------------------------------------------------------------------------ */

export type AppRemoval = {
  status: "done" | "partial" | "skipped";
  wiped: number;
  objectsDeleted: number;
};

/** Deletes up to one page of objects under `prefix`. True when more objects remain. */
async function clearPrefix(bucket: R2Bucket, prefix: string) {
  const listed = await bucket.list({ prefix, limit: R2_PAGE });
  const keys = listed.objects.map((o) => o.key).filter((k) => k.startsWith(prefix));
  if (keys.length > 0) await bucket.delete(keys);
  return { n: keys.length, more: listed.truncated };
}

/**
 * True for a removed production row whose cleanup finished: no commit and no bundle. It stays so
 * the app's hosts keep answering 410 (not 404), and it keeps the label. "Deploy app" revives it
 * (workers/api/src/apps.ts).
 */
export const isAppTombstone = (row: {
  channel?: string;
  status: string;
  commit_sha: string | null;
  bundle_key: string | null;
}) =>
  (row.channel ?? APP_PRODUCTION_CHANNEL) === APP_PRODUCTION_CHANNEL &&
  row.status === "removed" &&
  row.commit_sha === null &&
  row.bundle_key === null;

/**
 * Removes a Project's app and keeps the Project (P16-20). The API already marked every row
 * `removed`, so the hosts answer 410 at once. This deletes the data stores, the bundles, and the
 * preview and version rows, then reduces the production row to a tombstone (`isAppTombstone`), so
 * the hosts keep answering 410. Bounded per delivery; `partial` asks for another delivery. Safe
 * to repeat: a tombstone alone means done.
 */
export async function removeApp(env: Env, projectId: string): Promise<AppRemoval> {
  const result: AppRemoval = { status: "partial", wiped: 0, objectsDeleted: 0 };
  if (!/^proj_[a-z0-9-]+$/.test(projectId)) return { ...result, status: "skipped" };
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE app_deployments SET status = 'removed', updated_at = ? WHERE project_id = ? AND status != 'removed'",
  )
    .bind(now, projectId)
    .run();
  const { results } = await env.DB.prepare(
    `SELECT channel, status, commit_sha, bundle_key FROM app_deployments WHERE project_id = ?
     ORDER BY channel = ? , channel LIMIT ?`,
  )
    .bind(projectId, APP_PRODUCTION_CHANNEL, WIPES_PER_PASS + 1)
    .all<{
      channel: string;
      status: string;
      commit_sha: string | null;
      bundle_key: string | null;
    }>();
  const only = results.length === 1 ? results[0] : undefined;
  if (results.length === 0 || (only && isAppTombstone(only))) {
    return { ...result, status: "done" };
  }

  // Data stores first (production last), then their rows, so a retry never loses track of a store.
  const batch = results.slice(0, WIPES_PER_PASS);
  // Without the apps Worker (local runs) there is no store to reach; the rows still go.
  if (env.APPS) {
    const { wiped } = await env.APPS.wipeData(batch.map((r) => storeName(projectId, r.channel)));
    result.wiped = wiped;
  }
  const previews = batch.filter((r) => r.channel !== APP_PRODUCTION_CHANNEL).map((r) => r.channel);
  if (previews.length > 0) {
    await env.DB.prepare(
      `DELETE FROM app_deployments WHERE project_id = ? AND channel IN (SELECT value FROM json_each(?))`,
    )
      .bind(projectId, JSON.stringify(previews))
      .run();
  }
  if (results.length > batch.length || previews.length === batch.length) return result;

  let more = false;
  for (const prefix of [`apps/${projectId}/`, `app-previews/${projectId}/`]) {
    const cleared = await clearPrefix(env.EVIDENCE, prefix);
    result.objectsDeleted += cleared.n;
    more ||= cleared.more;
  }
  if (more) return result;
  await env.DB.prepare(
    `UPDATE app_deployments SET commit_sha = NULL, generation = NULL, bundle_key = NULL,
       failure_reason = NULL, bundle_bytes = NULL, candidate_id = NULL, change_id = NULL,
       updated_at = ?
     WHERE project_id = ? AND channel = ? AND status = 'removed'`,
  )
    .bind(now, projectId, APP_PRODUCTION_CHANNEL)
    .run();
  return { ...result, status: "done" };
}

/**
 * Deletes preview rows older than the bundle retention, with their data stores (P16-22). The R2
 * lifecycle rule already expired their bundles. Version rows and production are never touched.
 * Bounded: one pass per daily sweep.
 */
export async function expirePreviews(env: Env, now = Date.now()): Promise<{ expired: number }> {
  if (!env.APPS) return { expired: 0 };
  const cutoff = new Date(now - PREVIEW_RETENTION_DAYS * 86_400_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT project_id, channel FROM app_deployments
     WHERE candidate_id IS NOT NULL AND channel LIKE 'preview:%' AND updated_at < ?
     ORDER BY updated_at LIMIT ?`,
  )
    .bind(cutoff, WIPES_PER_PASS)
    .all<{ project_id: string; channel: string }>();
  if (results.length === 0) return { expired: 0 };
  await env.APPS.wipeData(results.map((r) => storeName(r.project_id, r.channel)));
  for (const row of results) {
    await env.DB.prepare(
      "DELETE FROM app_deployments WHERE project_id = ? AND channel = ? AND updated_at < ?",
    )
      .bind(row.project_id, row.channel, cutoff)
      .run();
  }
  return { expired: results.length };
}
