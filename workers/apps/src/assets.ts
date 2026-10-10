import { WorkerEntrypoint } from "cloudflare:workers";
import { handleAssetRequest } from "@cloudflare/worker-bundler";
import { type AppBundle, assetObjectKey } from "./bundle.ts";
import { loadBundle } from "./store.ts";

/**
 * Static assets of one app version (P16-07), per the Dynamic Workers static assets guide. The
 * manifest is in bundle.json; each file is one R2 object under the bundle prefix. The router
 * serves matching assets before the app runs, as Workers static assets do. Apps can also call
 * `env.ASSETS.fetch(request)` themselves; this entrypoint is that binding. `props.bundleKey` is
 * set by the router; the app cannot change it.
 */

export async function serveAsset(
  bucket: R2Bucket,
  key: string,
  bundle: AppBundle,
  request: Request,
): Promise<Response | null> {
  if (bundle.assets.length === 0) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const manifest = new Map(
    bundle.assets.map((a) => [a.path, { contentType: a.contentType ?? undefined, etag: a.etag }]),
  );
  const storage = {
    async get(pathname: string) {
      const object = await bucket.get(assetObjectKey(key, pathname));
      return object ? object.arrayBuffer() : null;
    },
  };
  return handleAssetRequest(request, manifest, storage, {
    not_found_handling: bundle.assetConfig.notFoundHandling,
  });
}

export class AppAssets extends WorkerEntrypoint<Env, { bundleKey: string }> {
  override async fetch(request: Request): Promise<Response> {
    const key = this.ctx.props.bundleKey;
    const bundle = await loadBundle(this.env.EVIDENCE, key);
    const response = bundle ? await serveAsset(this.env.EVIDENCE, key, bundle, request) : null;
    return response ?? new Response("Not Found", { status: 404 });
  }
}
