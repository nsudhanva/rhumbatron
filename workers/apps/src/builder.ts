import { WorkerEntrypoint } from "cloudflare:workers";
import { buildAssetManifest, createWorker } from "@cloudflare/worker-bundler";
import {
  type AppBuildInput,
  type AppBuildResult,
  type AppCheckInput,
  type AppCheckResult,
  type AppProbeInput,
  type AppProbeResult,
  isAppBuildInput,
} from "@rhumbatron/protocol";
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
import { AppChecker } from "./checker.ts";
import type { AppDataDO } from "./data.ts";
import { routeAppRequest } from "./router.ts";

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
    // Stored size: modules plus assets (the cost report sums it per bundle).
    bytes: bytes + bundle.assets.reduce((n, a) => n + a.size, 0),
  };
}

/** Probe body cap: enough for a JSON check, small enough for an RPC reply. */
const PROBE_BODY_BYTES = 64 * 1024;
/** Stores wiped per `wipeData` call (one Durable Object call each). */
const MAX_WIPES = 50;
const LABEL = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * RPC entrypoint for the integration Worker (service binding `APPS`, entrypoint `AppBuilder`).
 * Not reachable from the Internet: the router's fetch handler never calls it.
 */
export class AppBuilder extends WorkerEntrypoint<Env> {
  async build(input: AppBuildInput): Promise<AppBuildResult> {
    return buildApp(this.env, input);
  }

  /**
   * One GET through the router for the app's host (P16-11 smoke check), with a fresh pointer
   * read. It never leaves Cloudflare, so it works whatever the public route state is, and it runs
   * the app under the same limits as a visitor's request.
   */
  async probe(input: AppProbeInput): Promise<AppProbeResult> {
    const domain = this.env.APPS_DOMAIN;
    if (!domain || !LABEL.test(input.label)) return { status: null, error: "invalid host" };
    if (input.previewId !== undefined && !/^[a-z0-9]{8}$/.test(input.previewId)) {
      return { status: null, error: "invalid preview id" };
    }
    if (!input.path.startsWith("/")) return { status: null, error: "invalid path" };
    const host = `${input.previewId ? `${input.previewId}--` : ""}${input.label}.${domain}`;
    try {
      const response = await routeAppRequest(
        new Request(`https://${host}${input.path}`, {
          headers: { "cache-control": "no-cache", ...input.headers },
        }),
        this.env,
        this.ctx,
        { fresh: true },
      );
      const text = await response.text();
      return { status: response.status, body: text.slice(0, PROBE_BODY_BYTES) };
    } catch (error) {
      return { status: null, error: String(error).slice(0, 200) };
    }
  }

  /**
   * Deletes app data stores (P16-20 app removal, expired previews). Store names are the ones the
   * router derives: the Project ID for production, `<project>#preview:<id>` for a preview.
   */
  async wipeData(storeNames: string[]): Promise<{ wiped: number }> {
    const ns = this.env.APP_DATA as DurableObjectNamespace<AppDataDO>;
    const names = storeNames
      .filter((n) => /^proj_[a-z0-9-]+(#preview:[a-z0-9]{8})?$/.test(n))
      .slice(0, MAX_WIPES);
    for (const name of names) await ns.get(ns.idFromName(name)).wipe();
    return { wiped: names.length };
  }

  /**
   * Dynamic Workers checker (ADR 0020).
   * Runs build, unit, or contract checks in dynamic workers without starting a Sandbox.
   */
  async check(input: AppCheckInput): Promise<AppCheckResult> {
    const checker = this.ctx.exports?.AppChecker
      ? this.ctx.exports.AppChecker({})
      : new AppChecker(this.ctx, this.env);
    return checker.check(input);
  }
}
