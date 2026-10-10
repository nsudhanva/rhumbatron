import type { ProjectRootDO } from "@rhumbatron/coordinator";
import {
  APP_PRODUCTION_CHANNEL,
  type AppBuildResult,
  type AppSourceFile,
  appLabelCandidates,
  isAppBuildInput,
} from "@rhumbatron/protocol";
import type { SourceIndex } from "./provision.ts";

/**
 * `app.provision` (P16-08, ADR 0020): builds the app bundle of a Project's canonical commit and
 * points its production host at it. Runs after `project.provision` and on request (the API's
 * "Deploy app" route, for Projects that existed before live apps). Prod only: without the `APPS`
 * binding (dev) it returns `disabled` and writes nothing.
 *
 * Idempotent. The pointer row moves only after the bundle exists, so a failed build never takes a
 * live version down. Cost per build: one Artifacts read per source file (about 20 for Acme), a few
 * R2 writes, and one builder RPC. No Sandbox time.
 */

export type AppProvisionOutcome =
  | { status: "disabled" | "archived" | "no_source" | "current" }
  | { status: "ready"; label: string; commit: string; reused: boolean }
  | { status: "failed"; label: string; reason: string };

type Row = {
  slug: string;
  commit_sha: string | null;
  bundle_key: string | null;
  status: string;
};

const MAX_FILES = 400;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/** Inserts the production row with the first free label (labels are unique across Projects). */
async function claimLabel(env: Env, projectId: string, slug: string, now: string) {
  for (const label of appLabelCandidates(slug, projectId)) {
    const inserted = await env.DB.prepare(
      `INSERT INTO app_deployments (project_id, slug, channel, status, created_at, updated_at)
       VALUES (?, ?, ?, 'building', ?, ?) ON CONFLICT DO NOTHING`,
    )
      .bind(projectId, label, APP_PRODUCTION_CHANNEL, now, now)
      .run();
    if (inserted.meta.changes > 0) return label;
    // Another delivery of this command may have claimed a label for this Project already.
    const own = await env.DB.prepare(
      "SELECT slug FROM app_deployments WHERE project_id = ? AND channel = ?",
    )
      .bind(projectId, APP_PRODUCTION_CHANNEL)
      .first<{ slug: string }>();
    if (own) return own.slug;
  }
  throw new Error(`no free app label for ${projectId}`);
}

/** Reads the build inputs of one commit through the Artifacts binding. */
async function readSource(env: Env, projectId: string, index: SourceIndex) {
  using repo = await env.ARTIFACTS.get(projectId);
  const files: AppSourceFile[] = [];
  let bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  for (const path of index.files.filter(isAppBuildInput).slice(0, MAX_FILES)) {
    const blob = await repo.readFile({ ref: index.commit, path });
    if (!blob) continue;
    const buffer = await blob.arrayBuffer();
    bytes += buffer.byteLength;
    if (bytes > MAX_SOURCE_BYTES) throw new Error("source is larger than 8 MB");
    try {
      files.push({ path, text: decoder.decode(buffer) });
    } catch {
      let binary = "";
      const view = new Uint8Array(buffer);
      for (let i = 0; i < view.length; i += 0x8000) {
        binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
      }
      files.push({ path, base64: btoa(binary) });
    }
  }
  return files;
}

export async function provisionApp(env: Env, projectId: string): Promise<AppProvisionOutcome> {
  if (!env.APPS) return { status: "disabled" };
  const project = await env.DB.prepare("SELECT slug, status FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{ slug: string; status: string }>();
  if (!project || project.status === "archived") return { status: "archived" };

  const root = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  const canonical = await root.get(root.idFromName(projectId)).getCanonical();
  if (!canonical || canonical.artifactRef === "unassigned") return { status: "no_source" };
  const indexObject = await env.EVIDENCE.get(`source/${projectId}/${canonical.treeSha}/index.json`);
  if (!indexObject) return { status: "no_source" };
  const index = (await indexObject.json()) as SourceIndex;

  const now = new Date().toISOString();
  const existing = await env.DB.prepare(
    "SELECT slug, commit_sha, bundle_key, status FROM app_deployments WHERE project_id = ? AND channel = ?",
  )
    .bind(projectId, APP_PRODUCTION_CHANNEL)
    .first<Row>();
  if (existing?.status === "removed") return { status: "archived" };
  if (existing?.status === "ready" && existing.commit_sha === index.commit) {
    return { status: "current" };
  }
  const label = existing?.slug ?? (await claimLabel(env, projectId, project.slug, now));

  let result: AppBuildResult;
  try {
    const files = await readSource(env, projectId, index);
    result = await env.APPS.build({
      projectId,
      commit: index.commit,
      treeSha: index.treeSha,
      channel: "production",
      files,
    });
  } catch (error) {
    result = { ok: false, reason: String(error).slice(0, 400) };
  }

  if (result.ok) {
    await env.DB.prepare(
      `UPDATE app_deployments SET commit_sha = ?, generation = ?, bundle_key = ?, status = 'ready',
         failure_reason = NULL, updated_at = ?
       WHERE project_id = ? AND channel = ? AND status != 'removed'`,
    )
      .bind(
        index.commit,
        canonical.generation,
        result.bundleKey,
        now,
        projectId,
        APP_PRODUCTION_CHANNEL,
      )
      .run();
    return { status: "ready", label, commit: index.commit, reused: result.reused };
  }
  // A row that already serves a bundle keeps it; only the status and reason change.
  await env.DB.prepare(
    `UPDATE app_deployments SET status = 'failed', failure_reason = ?, updated_at = ?,
       commit_sha = CASE WHEN bundle_key IS NULL THEN ? ELSE commit_sha END
     WHERE project_id = ? AND channel = ? AND status != 'removed'`,
  )
    .bind(result.reason, now, index.commit, projectId, APP_PRODUCTION_CHANNEL)
    .run();
  return { status: "failed", label, reason: result.reason };
}
