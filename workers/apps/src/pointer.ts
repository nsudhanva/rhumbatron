import {
  APP_PRODUCTION_CHANNEL,
  type AppDeploymentStatus,
  type AppHost,
  previewChannel,
} from "@rhumbatron/protocol";
import { loaderId } from "./bundle.ts";

/**
 * Pointer selection (ADR 0020): which bundle a host serves. The pointer rows live in D1
 * `app_deployments` (migration 0018). A row keeps the last good bundle while a newer build runs or
 * after it fails, so a failed build never takes a live app down. Removing the production app
 * removes its previews too.
 */

export type DeploymentRow = {
  project_id: string;
  slug: string;
  channel: string;
  commit_sha: string | null;
  generation: number | null;
  bundle_key: string | null;
  status: AppDeploymentStatus;
  failure_reason: string | null;
};

export type Selection =
  | {
      kind: "serve";
      projectId: string;
      commit: string;
      bundleKey: string;
      loaderId: string;
      /** Storage name of the app's DATA binding: production data is never shared with previews. */
      storeName: string;
    }
  | { kind: "not_found" }
  | { kind: "removed" }
  | { kind: "building" }
  /** The Project's source has no app code yet (`ready` with no bundle, app-provision.ts). */
  | { kind: "empty" }
  | { kind: "failed"; reason: string };

function channelFor(host: AppHost): string | null {
  if (host.kind === "production") return APP_PRODUCTION_CHANNEL;
  if (host.kind === "preview") return previewChannel(host.previewId);
  return null;
}

export function selectDeployment(host: AppHost, rows: DeploymentRow[]): Selection {
  const channel = channelFor(host);
  if (!channel || (host.kind !== "production" && host.kind !== "preview")) {
    return { kind: "not_found" };
  }
  const own = rows.filter((r) => r.slug === host.label);
  const production = own.find((r) => r.channel === APP_PRODUCTION_CHANNEL);
  if (production?.status === "removed") return { kind: "removed" };
  const target = own.find((r) => r.channel === channel);
  if (!target) return { kind: "not_found" };
  if (target.status === "removed") return { kind: "removed" };
  if (target.bundle_key && target.commit_sha) {
    return {
      kind: "serve",
      projectId: target.project_id,
      commit: target.commit_sha,
      bundleKey: target.bundle_key,
      loaderId: loaderId(target.project_id, target.commit_sha, channel),
      storeName:
        channel === APP_PRODUCTION_CHANNEL ? target.project_id : `${target.project_id}#${channel}`,
    };
  }
  if (target.status === "failed") {
    return { kind: "failed", reason: target.failure_reason ?? "The build failed." };
  }
  if (target.status === "ready") return { kind: "empty" };
  return { kind: "building" };
}

/** Pointer rows for one host label: production and, for a preview host, its channel. */
async function readDeployments(db: D1Database, host: AppHost): Promise<DeploymentRow[]> {
  const channel = channelFor(host);
  if (!channel || (host.kind !== "production" && host.kind !== "preview")) return [];
  const { results } = await db
    .prepare(
      `SELECT project_id, slug, channel, commit_sha, generation, bundle_key, status, failure_reason
       FROM app_deployments WHERE slug = ? AND channel IN (?, ?)`,
    )
    .bind(host.label, APP_PRODUCTION_CHANNEL, channel)
    .all<DeploymentRow>();
  return results;
}

/**
 * Short in-isolate cache of pointer rows. A moved pointer is visible within the TTL on every
 * isolate; no KV writes, so no KV write quota is used.
 */
const POINTER_TTL_MS = 10_000;
const MAX_CACHED_HOSTS = 500;
const cache = new Map<string, { at: number; rows: DeploymentRow[] }>();

export async function cachedDeployments(
  db: D1Database,
  host: AppHost,
  now = Date.now(),
  /** Skip the cache read (release smoke probes): a just-moved pointer is seen at once. */
  fresh = false,
): Promise<DeploymentRow[]> {
  if (host.kind !== "production" && host.kind !== "preview") return [];
  const key = host.kind === "preview" ? `${host.previewId}--${host.label}` : host.label;
  const hit = cache.get(key);
  if (!fresh && hit && now - hit.at < POINTER_TTL_MS) return hit.rows;
  const rows = await readDeployments(db, host);
  if (cache.size >= MAX_CACHED_HOSTS) cache.clear();
  cache.set(key, { at: now, rows });
  return rows;
}
