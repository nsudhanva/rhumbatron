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
