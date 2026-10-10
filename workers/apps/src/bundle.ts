import { isAppBuildInput } from "@rhumbatron/protocol";
import { z } from "zod";

/**
 * App bundle format (ADR 0020, P16-06). One bundle per Project commit, stored in R2:
 *
 *   apps/<project>/<commit>/bundle.json          modules, settings, asset manifest
 *   apps/<project>/<commit>/assets/<path>        static assets, one object each
 *
 * Previews use the `app-previews/` prefix, which an R2 lifecycle rule expires (prod Terraform).
 * `bundle.json` is written last, so its presence means the bundle is complete. The commit is the
 * content address: the same commit always builds the same bundle, so a stored bundle is reused.
 *
 * Pure code only (no worker-bundler import): unit tested in bundle.critical.test.ts.
 */

export const BUNDLE_VERSION = 1;
const PROJECT_ID = /^proj_[a-z0-9-]+$/;
const COMMIT = /^[0-9a-f]{40}$/;

export type BundleChannel = "production" | "preview";

export function bundleKey(channel: BundleChannel, projectId: string, commit: string): string {
  if (!PROJECT_ID.test(projectId)) throw new Error(`invalid project id: ${projectId}`);
  if (!COMMIT.test(commit)) throw new Error(`invalid commit: ${commit}`);
  return `${channel === "production" ? "apps" : "app-previews"}/${projectId}/${commit}`;
}

export const bundleObjectKey = (key: string) => `${key}/bundle.json`;
export const assetObjectKey = (key: string, path: string) => `${key}/assets${path}`;

/** Dynamic Worker ID: one per Project commit (and per preview channel), stable across requests. */
export function loaderId(projectId: string, commit: string, key: string): string {
  return key.startsWith("apps/") ? `${projectId}@${commit}` : `${projectId}@${commit}:preview`;
}

/** A module as stored in JSON. Binary modules are base64. */
const StoredModule = z.union([
  z.string(),
  z.object({ js: z.string() }).strict(),
  z.object({ cjs: z.string() }).strict(),
  z.object({ text: z.string() }).strict(),
  z.object({ json: z.unknown() }).strict(),
  z.object({ dataBase64: z.string() }).strict(),
  z.object({ wasmBase64: z.string() }).strict(),
]);
type StoredModule = z.infer<typeof StoredModule>;

/** Flags an app may set. Anything else (for example `experimental`) is dropped at build time. */
const ALLOWED_COMPAT_FLAGS: ReadonlySet<string> = new Set([
  "nodejs_compat",
  "nodejs_compat_v2",
  "nodejs_als",
  "global_fetch_strictly_public",
]);

export const NotFoundHandling = z.enum(["none", "single-page-application", "404-page"]);

export const AppBundle = z.object({
  version: z.literal(BUNDLE_VERSION),
  projectId: z.string().regex(PROJECT_ID),
  commit: z.string().regex(COMMIT),
  treeSha: z.string(),
  mainModule: z.string().min(1),
  modules: z.record(z.string(), StoredModule),
  compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  compatibilityFlags: z.array(z.string()),
  assets: z.array(
    z.object({
      path: z.string().startsWith("/"),
      contentType: z.string().nullable(),
      etag: z.string(),
      size: z.number().int().nonnegative(),
    }),
  ),
  assetConfig: z.object({
    notFoundHandling: NotFoundHandling,
    /** true: every request reaches the app first; it serves assets through env.ASSETS. */
    runWorkerFirst: z.boolean(),
  }),
  builder: z.string(),
  builtAt: z.iso.datetime(),
});
export type AppBundle = z.infer<typeof AppBundle>;

/** The Worker Loader module shape (`WorkerLoaderModule` in the runtime types). */
export type LoaderModule =
  | string
  | { js: string }
  | { cjs: string }
  | { text: string }
  | { json: unknown }
  | { data: ArrayBuffer }
  | { wasm: ArrayBuffer };

const toBase64 = (bytes: ArrayBuffer) => {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)).buffer;

export function encodeModules(modules: Record<string, LoaderModule>): Record<string, StoredModule> {
  const out: Record<string, StoredModule> = {};
  for (const [name, module] of Object.entries(modules)) {
    if (typeof module === "string") out[name] = module;
    else if ("data" in module) out[name] = { dataBase64: toBase64(module.data) };
    else if ("wasm" in module) out[name] = { wasmBase64: toBase64(module.wasm) };
    else out[name] = module as StoredModule;
  }
  return out;
}

export function decodeModules(modules: Record<string, StoredModule>): Record<string, LoaderModule> {
  const out: Record<string, LoaderModule> = {};
  for (const [name, module] of Object.entries(modules)) {
    if (typeof module === "string") out[name] = module;
    else if ("dataBase64" in module) out[name] = { data: fromBase64(module.dataBase64) };
    else if ("wasmBase64" in module) out[name] = { wasm: fromBase64(module.wasmBase64) };
    else out[name] = module as LoaderModule;
  }
  return out;
}

/** Bundle size: the bytes of every module as stored. */
export const modulesSize = (modules: Record<string, StoredModule>) =>
  Object.values(modules).reduce(
    (sum, m) => sum + (typeof m === "string" ? m.length : JSON.stringify(m).length),
    0,
  );

export const MAX_MODULE_BYTES = 10 * 1024 * 1024;
export const MAX_ASSETS = 500;
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;

/** Settings read from the app's wrangler.jsonc or wrangler.json (comments allowed). */
export type AppSettings = {
  assetsDirectory: string | null;
  notFoundHandling: z.infer<typeof NotFoundHandling>;
  runWorkerFirst: boolean;
  compatibilityDate: string | null;
  compatibilityFlags: string[];
};

export function readAppSettings(files: Record<string, string>): AppSettings {
  const raw = files["wrangler.jsonc"] ?? files["wrangler.json"];
  const fallback: AppSettings = {
    assetsDirectory: null,
    notFoundHandling: "none",
    runWorkerFirst: false,
    compatibilityDate: null,
    compatibilityFlags: [],
  };
  if (!raw) return fallback;
  let config: {
    compatibility_date?: unknown;
    compatibility_flags?: unknown;
    assets?: { directory?: unknown; not_found_handling?: unknown; run_worker_first?: unknown };
  };
  try {
    // Line and block comments outside strings, then trailing commas.
    const json = raw
      .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) =>
        m.startsWith('"') ? m : "",
      )
      .replace(/,(\s*[}\]])/g, "$1");
    config = JSON.parse(json);
  } catch {
    return fallback;
  }
  const directory = typeof config.assets?.directory === "string" ? config.assets.directory : null;
  const notFound = NotFoundHandling.safeParse(config.assets?.not_found_handling);
  const date = config.compatibility_date;
  return {
    assetsDirectory: directory ? directory.replace(/^\.\//, "").replace(/\/+$/, "") || null : null,
    notFoundHandling: notFound.success ? notFound.data : "none",
    runWorkerFirst: config.assets?.run_worker_first === true,
    compatibilityDate: typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    compatibilityFlags: Array.isArray(config.compatibility_flags)
      ? config.compatibility_flags.filter(
          (f): f is string => typeof f === "string" && ALLOWED_COMPAT_FLAGS.has(f),
        )
      : [],
  };
}

/**
 * Real authentication is not allowed in generated apps (ADR 0020): they use a fake identity (a demo
 * user picker). A bundle fails when a source file or package.json names a real auth SDK or a
 * password-hashing library, or when markup has a password field.
 */
const AUTH_PACKAGE =
  /^(@clerk\/|next-auth$|@auth\/|better-auth$|lucia$|@lucia-auth\/|@supabase\/(auth|supabase-js)|firebase$|firebase\/auth|@firebase\/auth|@auth0\/|auth0$|passport($|-)|@okta\/|aws-amplify$|@aws-amplify\/auth|@workos-inc\/|@stytch\/|stytch$|@kinde-oss\/|@descope\/|bcrypt$|bcryptjs$|argon2$|@node-rs\/(argon2|bcrypt)$)/;
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;
const PASSWORD_FIELD =
  /\btype\s*[=:]\s*\{?\s*["'`]password["'`]|autocomplete\s*=\s*["'](current|new)-password["']/i;
const SCANNED = /\.([cm]?[jt]sx?|html?|vue|svelte|astro)$/;

export type AuthFinding = { path: string; reason: string };

export function findRealAuth(files: Record<string, string>): AuthFinding[] {
  const findings: AuthFinding[] = [];
  const pkg = files["package.json"];
  if (pkg) {
    try {
      const json = JSON.parse(pkg) as Record<string, Record<string, string> | undefined>;
      for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
        for (const name of Object.keys(json[field] ?? {})) {
          if (AUTH_PACKAGE.test(name)) {
            findings.push({ path: "package.json", reason: `real auth package ${name}` });
          }
        }
      }
    } catch {
      findings.push({ path: "package.json", reason: "package.json is not valid JSON" });
    }
  }
  for (const [path, text] of Object.entries(files)) {
    if (!SCANNED.test(path) || !isAppBuildInput(path)) continue;
    for (const match of text.matchAll(IMPORT)) {
      const specifier = match[1] ?? "";
      if (AUTH_PACKAGE.test(specifier)) {
        findings.push({ path, reason: `imports real auth package ${specifier}` });
      }
    }
    if (PASSWORD_FIELD.test(text)) findings.push({ path, reason: "has a password field" });
  }
  return findings;
}
