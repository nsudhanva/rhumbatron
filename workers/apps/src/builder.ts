import { WorkerEntrypoint } from "cloudflare:workers";
import { buildAssetManifest, createWorker } from "@cloudflare/worker-bundler";
import { type AppBuildInput, type AppBuildResult, isAppBuildInput } from "@rhumbatron/protocol";
import {
  type AppBundle,
  assetObjectKey,
  BUNDLE_VERSION,
  bundleKey,
  bundleObjectKey,
  encodeModules,
  findRealAuth,
  type LoaderModule,
  MAX_ASSET_BYTES,
  MAX_ASSETS,
  MAX_MODULE_BYTES,
  modulesSize,
  readAppSettings,
} from "./bundle.ts";

/**
 * Bundle builder (P16-06, ADR 0020). Runs in this Worker with `@cloudflare/worker-bundler`
 * (esbuild-wasm), not in the Sandbox: no container time. The integration Worker reads the source of
 * one commit from Artifacts and calls `build` over its `APPS` service binding (prod only). npm
 * dependencies are fetched from the public registry at build time.
 *
 * Idempotent: a stored bundle for the same commit is reused. Deterministic failures (real auth,
 * size limits, a bundling error) return `ok: false` with a reason; they are not retried.
 */

const BUILDER = "worker-bundler@0.2.6";
const DEFAULT_COMPAT_DATE = "2026-10-08";

const decodeBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)).buffer;

async function buildApp(env: Env, input: AppBuildInput): Promise<AppBuildResult> {
  const key = bundleKey(input.channel, input.projectId, input.commit);
  const stored = await env.EVIDENCE.head(bundleObjectKey(key));
  if (stored) {
    return { ok: true, bundleKey: key, reused: true, modules: 0, assets: 0, bytes: stored.size };
  }

  const texts: Record<string, string> = {};
  const binaries: Record<string, ArrayBuffer> = {};
  for (const file of input.files) {
    if (file.text !== undefined) texts[file.path] = file.text;
    else if (file.base64 !== undefined) binaries[file.path] = decodeBase64(file.base64);
  }

  const auth = findRealAuth(texts);
  if (auth.length > 0) {
    const list = auth.slice(0, 3).map((f) => `${f.path}: ${f.reason}`);
    return {
      ok: false,
      reason: `Real authentication is not allowed (use the fake identity). ${list.join("; ")}`,
    };
  }

  const settings = readAppSettings(texts);
  const assetPrefix = settings.assetsDirectory ? `${settings.assetsDirectory}/` : null;
  const assets: Record<string, string | ArrayBuffer> = {};
  const sources: Record<string, string> = {};
  for (const [path, text] of Object.entries(texts)) {
    if (assetPrefix && path.startsWith(assetPrefix))
      assets[`/${path.slice(assetPrefix.length)}`] = text;
    else if (isAppBuildInput(path)) sources[path] = text;
  }
  for (const [path, bytes] of Object.entries(binaries)) {
    if (assetPrefix && path.startsWith(assetPrefix))
      assets[`/${path.slice(assetPrefix.length)}`] = bytes;
  }
  const assetEntries = Object.entries(assets);
  if (assetEntries.length > MAX_ASSETS) {
    return {
      ok: false,
      reason: `Too many static assets (${assetEntries.length}, limit ${MAX_ASSETS}).`,
    };
  }
  const size = (v: string | ArrayBuffer) =>
    typeof v === "string" ? new TextEncoder().encode(v).length : v.byteLength;
  const large = assetEntries.find(([, v]) => size(v) > MAX_ASSET_BYTES);
  if (large) return { ok: false, reason: `Asset ${large[0]} is larger than 5 MB.` };

  let worker: Awaited<ReturnType<typeof createWorker>>;
  try {
    worker = await createWorker({ files: sources, bundle: true, minify: true });
  } catch (error) {
    return { ok: false, reason: `Bundling failed: ${String(error).slice(0, 400)}` };
  }
  const modules = encodeModules(worker.modules as Record<string, LoaderModule>);
  const bytes = modulesSize(modules);
  if (bytes > MAX_MODULE_BYTES) {
    return { ok: false, reason: `Bundle is ${bytes} bytes; the limit is ${MAX_MODULE_BYTES}.` };
  }

  const manifest = await buildAssetManifest(assets);
  for (const [path, content] of assetEntries) {
    const meta = manifest.get(path);
    await env.EVIDENCE.put(assetObjectKey(key, path), content, {
      httpMetadata: meta?.contentType ? { contentType: meta.contentType } : {},
    });
  }

  const bundle: AppBundle = {
    version: BUNDLE_VERSION,
    projectId: input.projectId,
    commit: input.commit,
    treeSha: input.treeSha,
    mainModule: worker.mainModule,
    modules,
    compatibilityDate: settings.compatibilityDate ?? DEFAULT_COMPAT_DATE,
    compatibilityFlags: settings.compatibilityFlags,
    assets: assetEntries.map(([path, content]) => ({
      path,
      contentType: manifest.get(path)?.contentType ?? null,
      etag: manifest.get(path)?.etag ?? "",
      size: size(content),
    })),
    assetConfig: {
      notFoundHandling: settings.notFoundHandling,
      runWorkerFirst: settings.runWorkerFirst,
    },
    builder: BUILDER,
    builtAt: new Date().toISOString(),
  };
  // Last: bundle.json marks a complete bundle.
  await env.EVIDENCE.put(bundleObjectKey(key), JSON.stringify(bundle), {
    httpMetadata: { contentType: "application/json" },
  });
  return {
    ok: true,
    bundleKey: key,
    reused: false,
    modules: Object.keys(modules).length,
    assets: assetEntries.length,
    bytes,
  };
}

/**
 * RPC entrypoint for the integration Worker (service binding `APPS`, entrypoint `AppBuilder`).
 * Not reachable from the Internet: the router's fetch handler never calls it.
 */
export class AppBuilder extends WorkerEntrypoint<Env> {
  async build(input: AppBuildInput): Promise<AppBuildResult> {
    return buildApp(this.env, input);
  }
}
