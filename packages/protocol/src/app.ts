import { z } from "zod";
import { Timestamp } from "./common.ts";

/**
 * Live apps (Phase 16, ADR 0020). Every Project runs at `<label>.<domain>`, and a Candidate preview
 * at `<preview-id>--<label>.<domain>`. The hosts are one label deep, so Universal SSL covers them.
 * These rules are shared by the apps router, the integration Worker, and the API.
 */

/** The production channel of an app. Preview channels are `preview:<preview-id>` (milestone B). */
export const APP_PRODUCTION_CHANNEL = "production";

/**
 * Host labels that belong to Rhumbatron itself or to Clerk. No app can use them. DKIM hosts
 * (`clk._domainkey`) contain a dot, so the one-label rule already excludes them.
 */
export const RESERVED_APP_LABELS: ReadonlySet<string> = new Set([
  "www",
  "api",
  "dev",
  "api-dev",
  "clerk",
  "accounts",
  "clkmail",
  "app",
  "apps",
  "admin",
  "mail",
  "status",
  "docs",
  "static",
  "cdn",
]);

/** Room for `<preview-id>--` in front of the label, inside the 63-character DNS label limit. */
export const MAX_APP_LABEL = 50;
const PREVIEW_ID = /^[a-z0-9]{8}$/;
/** Lowercase letters, digits, single hyphens; no leading, trailing, or double hyphen. */
const LABEL = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type AppHost =
  | { kind: "production"; label: string }
  | { kind: "preview"; label: string; previewId: string }
  | { kind: "reserved"; label: string }
  | { kind: "invalid" };

const isReserved = (label: string) =>
  RESERVED_APP_LABELS.has(label) || label.startsWith("rhumbatron");

/**
 * Maps a request host to an app. Only one label under `domain` is an app host; anything else,
 * including the apex and deeper names, is invalid. Case, a port, and a trailing dot are ignored.
 */
export function parseAppHost(host: string, domain: string): AppHost {
  const name = host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  const suffix = `.${domain.toLowerCase()}`;
  if (!name.endsWith(suffix)) return { kind: "invalid" };
  const first = name.slice(0, -suffix.length);
  if (first.length === 0 || first.length > 63 || first.includes(".")) return { kind: "invalid" };

  const split = first.indexOf("--");
  if (split === -1) {
    if (!LABEL.test(first) || first.length > MAX_APP_LABEL) return { kind: "invalid" };
    return isReserved(first)
      ? { kind: "reserved", label: first }
      : { kind: "production", label: first };
  }
  const previewId = first.slice(0, split);
  const label = first.slice(split + 2);
  if (!PREVIEW_ID.test(previewId) || !LABEL.test(label) || label.length > MAX_APP_LABEL) {
    return { kind: "invalid" };
  }
  return isReserved(label) ? { kind: "reserved", label } : { kind: "preview", label, previewId };
}

/**
 * Host labels to try for a Project, in order. Project slugs are unique per organization only, so
 * the second choice adds part of the Project ID. A reserved slug gets an `-app` suffix.
 */
export function appLabelCandidates(slug: string, projectId: string): [string, string] {
  const clean = (value: string, max: number) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .slice(0, max)
      .replace(/^-+|-+$/g, "");
  let base = clean(slug, MAX_APP_LABEL) || "app";
  if (isReserved(base)) base = clean(`${base.slice(0, MAX_APP_LABEL - 4)}-app`, MAX_APP_LABEL);
  const suffix =
    projectId
      .replace(/^proj_/, "")
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 6) || "x";
  return [base, `${clean(base, MAX_APP_LABEL - suffix.length - 1)}-${suffix}`];
}

/** The preview id of a Candidate: the first 8 characters after `cand_`. */
export const previewIdFor = (candidateId: string) => candidateId.replace(/^cand_/, "").slice(0, 8);

export const previewChannel = (previewId: string) => `preview:${previewId}`;

export function appUrl(domain: string, label: string, previewId?: string): string {
  return `https://${previewId ? `${previewId}--` : ""}${label}.${domain}`;
}

export const AppDeploymentStatus = z.enum(["building", "ready", "failed", "removed"]);
export type AppDeploymentStatus = z.infer<typeof AppDeploymentStatus>;

/** The production app of a Project, as the API shows it. Null when the Project has no app. */
export const ProjectApp = z.object({
  label: z.string(),
  url: z.string().url(),
  status: AppDeploymentStatus,
  commit: z.string().nullable(),
  generation: z.number().int().nonnegative().nullable(),
  failureReason: z.string().nullable(),
  updatedAt: Timestamp,
});
export type ProjectApp = z.infer<typeof ProjectApp>;

/** `app.provision` outcome of the API route (queued, or why not). */
export const AppProvisionOutcome = z.object({
  status: z.enum(["queued", "disabled"]),
});
export type AppProvisionOutcome = z.infer<typeof AppProvisionOutcome>;

/**
 * Files that go into an app build. Tests, benchmarks, lockfiles, docs, and tool state stay out:
 * fewer Artifacts reads and a smaller bundle.
 */
export function isAppBuildInput(path: string): boolean {
  return !(
    /(^|\/)(node_modules|\.git|test|tests|__tests__|bench)\//.test(path) ||
    /\.(test|spec|bench)\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(path) ||
    /\.md$/i.test(path)
  );
}

/** One source file sent to the bundle builder: UTF-8 text, or base64 for binary files. */
export type AppSourceFile = { path: string; text?: string; base64?: string };

/** RPC input of the apps Worker's `AppBuilder.build` (ADR 0020, P16-06). */
export type AppBuildInput = {
  projectId: string;
  commit: string;
  treeSha: string;
  channel: "production" | "preview";
  files: AppSourceFile[];
};

export type AppBuildResult =
  | { ok: true; bundleKey: string; reused: boolean; modules: number; assets: number; bytes: number }
  | { ok: false; reason: string };

/** Kinds of checks AppChecker can run in Dynamic Workers. */
export type AppCheckKind = "build" | "unit" | "contract";

/** RPC input of the apps Worker's AppChecker.check (ADR 0020, docs/plans/checker-integration.md). */
export type AppCheckInput = {
  projectId: string;
  treeSha: string;
  kind: AppCheckKind;
  timeoutMs?: number;
};

/** Reply from AppChecker.check. */
export type AppCheckResult = {
  kind: AppCheckKind;
  status: "pass" | "fail" | "error" | "skipped";
  coverage: "checked_supported" | "not_checked";
  /** False permits Sandbox fallback. A completed assertion failure must not be retried as a pass. */
  supported: boolean;
  summary: string;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  passed: number;
  failed: number;
  failures: { name: string; message: string }[];
  startedAt: string;
  completedAt: string;
};

/* ------------------------------------------------------------------------------------------ */
/* Milestone B: previews, releases, versions, rollback (P16-10..P16-13)                        */
/* ------------------------------------------------------------------------------------------ */

/** Previews per Change: the Candidate limit (policy `maxCandidates`, AGENTS.md section 44). */
export const MAX_PREVIEWS_PER_CHANGE = 3;

/** Largest generation a version host can name (`v` plus 7 digits). */
const MAX_VERSION_GENERATION = 9_999_999;

/**
 * Host id of one promoted generation: `v` plus 7 digits, for example `v0000003--acme`. It fits the
 * 8-character preview id rule, and `v` is not a hex digit, so it never equals a Candidate preview
 * id (Candidate IDs are hex). The router serves it like a preview: its own data store, never
 * production data. Null past the 7-digit range.
 */
export function versionPreviewId(generation: number): string | null {
  if (!Number.isInteger(generation) || generation < 0 || generation > MAX_VERSION_GENERATION) {
    return null;
  }
  return `v${String(generation).padStart(7, "0")}`;
}

/** True for a version host id (`versionPreviewId`), false for a Candidate preview id. */
export const isVersionPreviewId = (previewId: string) => /^v\d{7}$/.test(previewId);

/**
 * RPC input of the apps Worker's `AppBuilder.probe`: one request through the router, as if it came
 * to the app's host, with a fresh pointer read (no isolate cache). Release smoke checks use it, so
 * they test the router, the pointer, and the Dynamic Worker without leaving Cloudflare.
 */
export type AppProbeInput = {
  label: string;
  /** Preview or version host id; absent for the production host. */
  previewId?: string;
  path: string;
  headers?: Record<string, string>;
};

/** `status` null: no response (the router threw). The body is cut to 64 KiB. */
export type AppProbeResult = { status: number; body: string } | { status: null; error: string };

/** Live preview of one Candidate, as the API shows it. `enabled` is false where apps are off. */
export const CandidatePreview = z.object({
  enabled: z.boolean(),
  preview: z
    .object({
      url: z.string().url(),
      status: AppDeploymentStatus,
      commit: z.string().nullable(),
      failureReason: z.string().nullable(),
      updatedAt: Timestamp,
    })
    .nullable(),
});
export type CandidatePreview = z.infer<typeof CandidatePreview>;

/** An "Open" link to one promoted generation's bundle (Versions page). */
export const AppVersionLink = z.object({
  generation: z.number().int().nonnegative(),
  url: z.string().url(),
});
export type AppVersionLink = z.infer<typeof AppVersionLink>;

/** `app.remove` outcome of the API route. */
export const AppRemoveOutcome = z.object({ status: z.enum(["removing", "not_found"]) });
export type AppRemoveOutcome = z.infer<typeof AppRemoveOutcome>;

/**
 * P16-13: roll the Project back to the tree of an earlier generation Sk. The caller names the
 * generation it saw as current (`expectedGeneration`), so a rollback requested on an old page is
 * refused instead of undoing work the person never saw.
 */
export const RollbackRequest = z.object({
  targetGeneration: z.number().int().nonnegative(),
  expectedGeneration: z.number().int().nonnegative(),
});
export type RollbackRequest = z.infer<typeof RollbackRequest>;

export const RollbackRefusal = z.enum([
  "not_found",
  "archived",
  "no_source",
  "stale",
  "not_earlier",
  "unknown_target",
  "same_tree",
  "in_progress",
]);
export type RollbackRefusal = z.infer<typeof RollbackRefusal>;

export const RollbackOutcome = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("promoted"),
    changeId: z.string(),
    candidateId: z.string(),
    targetGeneration: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
    alreadyPromoted: z.boolean(),
  }),
  /** Policy gates this rollback: approve the Candidate, then promote it (section 36 rule 4). */
  z.object({
    status: z.literal("awaiting_approval"),
    changeId: z.string(),
    candidateId: z.string(),
    targetGeneration: z.number().int().nonnegative(),
  }),
  z.object({ status: z.literal("refused"), reason: RollbackRefusal, detail: z.string() }),
]);
export type RollbackOutcome = z.infer<typeof RollbackOutcome>;

/* ------------------------------------------------------------------------------------------ */
/* App conventions (blank Projects)                                                            */
/* ------------------------------------------------------------------------------------------ */

/**
 * The shape every Project's app must have, stated as instructions, not template files: a Project
 * starts from an empty repository and agents create the app. The verification plan
 * (packages/evidence plan.ts) runs `bun run typecheck`, `bun test` and `bun run contract`; the apps
 * builder bundles `src/worker.ts` and serves `public/`.
 */
export const APP_CONVENTIONS = [
  "The app is a Cloudflare Worker in TypeScript, run with Bun. src/worker.ts default-exports { fetch(request, env, ctx) }. Use Hono 4.13.13: src/app.ts exports createApp() that returns the Hono app; API routes live under /api.",
  'Static files (HTML, CSS, client JavaScript) live in public/ and are served before the Worker runs; public/index.html is the home page. wrangler.jsonc: { "main": "src/worker.ts", "compatibility_date": "2026-10-08", "assets": { "directory": "./public", "not_found_handling": "none" } }.',
  'package.json ("type": "module") has the scripts "typecheck" (tsc --noEmit), "test" (bun test), "contract" (bun run scripts/contract.ts) and "dev" (bun run src/server.ts: a Bun.serve server on PORT, default 8787, serving /api from the app and the rest from public/). devDependencies: typescript 7.0.2 and @types/bun 1.4.2. tsconfig.json: strict, module ESNext, moduleResolution Bundler, types ["bun"], noEmit.',
  'scripts/contract.ts prints the API route table as one JSON line, {"routes":["GET /api/health", ...]}: sorted unique "METHOD /path" from createApp().routes, without method ALL. It imports src/app.ts from the directory in the CONTRACT_ROOT environment variable, else from the current directory, so the base commit can be read too.',
  "Tests are bun:test files under test/; at least one test must exist and pass.",
  "Storage: env.DATA is a string key-value store with exactly these async methods: get(key): Promise<string | null>; put(key, value: string): Promise<void>; delete(key): Promise<boolean>; list({ prefix?, limit? }): Promise<{ key: string; value: string }[]> (an ARRAY of entries with their values, sorted by key; limit defaults to 100 and is at most 1000; it is NOT the Workers KV { keys: [{ name }] } shape). Values are strings up to 128 KiB (JSON.stringify objects). Test doubles of env.DATA in tests and src/server.ts must have this exact shape. Memory is lost between requests. The app has no network access.",
  "No real authentication: no passwords, no email sign-in, no auth SDKs (the build rejects them). When the goal asks for accounts or users, build a fake identity: a demo user picker stored in a cookie, read on the server.",
] as const;
