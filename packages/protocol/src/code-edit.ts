import { z } from "zod";
import { utf8Length } from "./code.ts";
import type { RiskTier } from "./common.ts";

/**
 * Human edits (Phase 16 P16-19; AGENTS.md sections 15.4, 26.1, 33, 36). A person edits one file on
 * the Code page. Save creates a new Change with one human ChangeSet. That Change goes through the
 * same composition, verification, and promotion as agent work: only verified evidence advances
 * the Canonical State. Everything here is deterministic; no model sees an edit.
 */

/** Largest file a person can save from the Code page. */
export const MAX_EDIT_BYTES = 256 * 1024;
const MAX_PATH = 1024;
/** Edit distance (lines) above which the stored patch replaces the whole file. */
const MAX_DIFF_EDITS = 2000;
const CONTEXT_LINES = 3;

const Sha = z.string().regex(/^[0-9a-f]{40}$/);

/** `POST /v1/projects/:projectId/code/edits`. */
export const CodeEditRequest = z.object({
  path: z.string().min(1).max(MAX_PATH),
  /** The whole new file. Size and text checks are in `checkEdit` (they need byte counts). */
  content: z.string(),
  /** The canonical tree the person edited. A different live tree is a 409. */
  baseTree: Sha,
  message: z.string().trim().min(1).max(200),
  /** Display name from the sign-in session, for "edited by". Never used for authority. */
  authorName: z.string().trim().max(80).optional(),
  clientRequestId: z.string().min(1).max(128).optional(),
});
export type CodeEditRequest = z.infer<typeof CodeEditRequest>;

export const CodeEditOutcome = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["created", "existing"]),
    changeId: z.string(),
    changeSetId: z.string(),
    candidateIds: z.array(z.string()),
  }),
  z.object({
    status: z.literal("refused"),
    reason: z.enum([
      "not_found",
      "archived",
      "no_source",
      "stale_base",
      "invalid_path",
      "not_a_file",
      "binary",
      "too_large",
      "no_change",
    ]),
    detail: z.string(),
  }),
]);
export type CodeEditOutcome = z.infer<typeof CodeEditOutcome>;
type Refusal = Extract<CodeEditOutcome, { status: "refused" }>;

/** HTTP status for a refused edit. 409 means "reload and edit again". */
export function editRefusalStatus(reason: Refusal["reason"]): 400 | 404 | 409 | 413 {
  switch (reason) {
    case "not_found":
      return 404;
    case "archived":
    case "no_source":
    case "stale_base":
      return 409;
    case "too_large":
      return 413;
    default:
      return 400;
  }
}

const refuse = (reason: Refusal["reason"], detail: string): Refusal => ({
  status: "refused",
  reason,
  detail,
});

/** A repository-relative file path, or null. No `..`, no absolute path, nothing under `.git`. */
export function normalizeEditPath(path: string): string | null {
  const clean = path.replace(/^\.\//, "");
  if (!clean || clean.length > MAX_PATH) return null;
  if (clean.startsWith("/") || clean.endsWith("/") || clean.includes("\\")) return null;
  // Control characters cannot be in a path a person picked from the file list.
  for (let i = 0; i < clean.length; i++) if (clean.charCodeAt(i) < 0x20) return null;
  const parts = clean.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  if (parts[0] === ".git") return null;
  return clean;
}

/**
 * The checks every edit passes before any Artifacts work: the path, the size (256 KB), text only
 * (no NUL byte, the same rule git uses), and the base tree. `canonicalTree` is the live tree now;
 * a different `baseTree` means another Change advanced canonical after the file was opened.
 */
export function checkEdit(
  input: Pick<CodeEditRequest, "path" | "content" | "baseTree">,
  canonicalTree: string | null,
): Refusal | { status: "ok"; path: string } {
  const path = normalizeEditPath(input.path);
  if (!path) return refuse("invalid_path", "The path is not a file in this repository.");
  if (utf8Length(input.content) > MAX_EDIT_BYTES) {
    return refuse("too_large", `Files over ${MAX_EDIT_BYTES / 1024} KB cannot be edited here.`);
  }
  if (input.content.includes("\u0000")) {
    return refuse("binary", "Only text files can be edited here.");
  }
  if (canonicalTree === null) return refuse("no_source", "The project has no source to edit.");
  if (input.baseTree !== canonicalTree) {
    return refuse("stale_base", "The file changed; reload.");
  }
  return { status: "ok", path };
}

/* ------------------------------------------------------------------------------------------ */
/* Intent derivation                                                                           */
/* ------------------------------------------------------------------------------------------ */

const ROUTE = /\.(get|post|put|patch|delete)\(\s*(["'`])(\/[^"'`\s]*)\2/g;

/** `METHOD /path` routes registered with string literals (`app.get("/api/x", …)`). Best effort. */
export function routeTable(source: string): string[] {
  const routes = new Set<string>();
  for (const match of source.matchAll(ROUTE)) {
    routes.add(`${(match[1] ?? "").toUpperCase()} ${match[3]}`);
  }
  return [...routes].sort();
}

const kebab = (text: string) =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const SOURCE_DIRS = new Set(["src", "app", "lib", "server", "worker", "workers"]);
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec"]);
const UI_DIRS = new Set(["public", "static", "assets", "styles"]);
const CONFIG_FILE =
  /^(package\.json|bun\.lockb?|tsconfig.*\.json|wrangler\.jsonc?|biome\.json|\.gitignore)$/;

/**
 * Semantic resources for one path (plan-relative, like an agent's Intent): `src/catalog.ts` is
 * `catalog`, `src/wishlist/membership.ts` is `wishlist:membership`, `test/cart.test.ts` is `cart`.
 */
export function semanticResourcesForPath(path: string): string[] {
  const parts = path.split("/");
  const file = parts.at(-1) ?? path;
  if (parts.length === 1 && CONFIG_FILE.test(file)) return ["config"];
  if (parts.length === 1 && /\.(md|txt)$/i.test(file)) return ["docs"];
  const head = parts[0] ?? "";
  if (/^migrations?$/.test(head)) return ["data:migrations"];
  if (UI_DIRS.has(head)) return ["ui"];
  const dirs = parts.slice(SOURCE_DIRS.has(head) || TEST_DIRS.has(head) ? 1 : 0, -1);
  const stem = kebab(file.replace(/(\.(test|spec))?\.[^.]+$/, ""));
  const segments = [...dirs.map(kebab), stem].filter((s) => s && s !== "index").slice(0, 2);
  return [segments.length > 0 ? segments.join(":") : "general"];
}

/** Resource head before `:` or `.`: `identity.auth` and `identity:session` share `identity`. */
const headOf = (resource: string) => resource.split(/[:.]/)[0] ?? resource;

const AUTH_PATH = /(^|[/._-])(auth|identity|session|permission|acl|rbac|login)/i;

export type HumanEditIntent = {
  summary: string;
  semanticResources: string[];
  expectedFiles: string[];
  expectedContractChanges: string[];
  expectedDataChanges: string[];
  assumptions: string[];
  riskTier: RiskTier;
  touchesAuthorization: boolean;
  touchesMigration: boolean;
};

/**
 * The Intent of a human ChangeSet (section 26.1), derived from the path and the two file versions.
 * Route changes become declared contract changes, so the contract check accepts them. Risk is
 * deterministic: a protected resource or an authorization path is high (a human gate by default
 * policy), a route change medium, anything else low. Policy then decides promotion as for any
 * Change.
 */
export function humanEditIntent(input: {
  path: string;
  before: string;
  after: string;
  message: string;
  protectedResources?: readonly string[];
}): HumanEditIntent {
  const semanticResources = semanticResourcesForPath(input.path);
  const before = new Set(routeTable(input.before));
  const after = new Set(routeTable(input.after));
  const expectedContractChanges = [
    ...[...after].filter((r) => !before.has(r)).map((r) => `${r} - added`),
    ...[...before].filter((r) => !after.has(r)).map((r) => `${r} - removed`),
  ];
  const protectedHeads = new Set((input.protectedResources ?? []).map(headOf));
  const touchesProtected = semanticResources.some((r) => protectedHeads.has(headOf(r)));
  const touchesAuthorization = AUTH_PATH.test(input.path);
  const touchesMigration = semanticResources.includes("data:migrations");
  const riskTier: RiskTier =
    touchesProtected || touchesAuthorization || touchesMigration
      ? "high"
      : expectedContractChanges.length > 0
        ? "medium"
        : "low";
  const firstLine = input.message.trim().split("\n")[0]?.trim() ?? "";
  return {
    summary: (firstLine || `Edit ${input.path}`).slice(0, 200),
    semanticResources,
    expectedFiles: [input.path],
    expectedContractChanges,
    expectedDataChanges: touchesMigration ? [`Schema change in ${input.path}`] : [],
    assumptions: ["A person wrote this edit on the Code page; checks decide whether it ships."],
    riskTier,
    touchesAuthorization,
    touchesMigration,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* One-file unified diff                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** Marks a last line without a trailing newline, so "only the final newline changed" differs. */
const NO_EOL = "\u0000";

function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  else lines[lines.length - 1] = `${lines.at(-1)}${NO_EOL}`;
  return lines;
}

type Op = { kind: "eq" | "del" | "add"; line: string };

/** Myers O(ND) line diff. Null when the edit distance exceeds `maxD`. */
function myers(a: readonly string[], b: readonly string[], maxD: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const trace: Int32Array[] = [];
  const at = (v: Int32Array, d: number, k: number) => v[k + d] ?? 0;
  for (let d = 0; d <= Math.min(maxD, n + m); d++) {
    const prev = trace[d - 1];
    const v = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (!prev) x = 0;
      else if (k === -d || (k !== d && at(prev, d - 1, k - 1) < at(prev, d - 1, k + 1))) {
        x = at(prev, d - 1, k + 1);
      } else x = at(prev, d - 1, k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + d] = x;
      if (x >= n && y >= m) {
        trace.push(v);
        return backtrack(trace, a, b);
      }
    }
    trace.push(v);
  }
  return null;
}

function backtrack(trace: Int32Array[], a: readonly string[], b: readonly string[]): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1] as Int32Array;
    const k = x - y;
    const get = (kk: number) => prev[kk + d - 1] ?? 0;
    const down = k === -d || (k !== d && get(k - 1) < get(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "eq", line: a[--x] as string });
      y--;
    }
    if (down) ops.push({ kind: "add", line: b[--y] as string });
    else ops.push({ kind: "del", line: a[--x] as string });
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: "eq", line: a[--x] as string });
    y--;
  }
  return ops.reverse();
}

const range = (start: number, count: number) =>
  count === 1 ? `${start}` : `${count === 0 ? start - 1 : start},${count}`;

function printLine(prefix: string, line: string): string[] {
  return line.endsWith(NO_EOL)
    ? [`${prefix}${line.slice(0, -1)}`, "\\ No newline at end of file"]
    : [`${prefix}${line}`];
}

/**
 * `git diff`-style patch of one modified file (what `splitPatch` and the Files changed view read).
 * Empty when nothing changed. A very large rewrite is shown as one hunk that replaces the file.
 */
export function unifiedFilePatch(input: {
  path: string;
  before: string;
  after: string;
  oldBlob?: string;
  newBlob?: string;
}): { patch: string; additions: number; deletions: number } {
  const a = toLines(input.before);
  const b = toLines(input.after);
  const ops = myers(a, b, MAX_DIFF_EDITS) ?? [
    ...a.map((line): Op => ({ kind: "del", line })),
    ...b.map((line): Op => ({ kind: "add", line })),
  ];
  const changed = ops.flatMap((op, i) => (op.kind === "eq" ? [] : [i]));
  if (changed.length === 0) return { patch: "", additions: 0, deletions: 0 };

  // Hunks: changed ops plus CONTEXT_LINES of equal lines around them, merged when they touch.
  const spans: [number, number][] = [];
  for (const i of changed) {
    const start = Math.max(0, i - CONTEXT_LINES);
    const end = Math.min(ops.length, i + CONTEXT_LINES + 1);
    const last = spans.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else spans.push([start, end]);
  }
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const op of ops) {
    oldBefore.push(oldNo);
    newBefore.push(newNo);
    if (op.kind !== "add") oldNo++;
    if (op.kind !== "del") newNo++;
  }

  const out = [`diff --git a/${input.path} b/${input.path}`];
  if (input.oldBlob && input.newBlob) {
    out.push(`index ${input.oldBlob.slice(0, 7)}..${input.newBlob.slice(0, 7)} 100644`);
  }
  out.push(`--- a/${input.path}`, `+++ b/${input.path}`);
  let additions = 0;
  let deletions = 0;
  for (const [start, end] of spans) {
    const slice = ops.slice(start, end);
    const oldCount = slice.filter((op) => op.kind !== "add").length;
    const newCount = slice.filter((op) => op.kind !== "del").length;
    out.push(
      `@@ -${range((oldBefore[start] ?? 0) + 1, oldCount)} +${range((newBefore[start] ?? 0) + 1, newCount)} @@`,
    );
    for (const op of slice) {
      if (op.kind === "add") additions++;
      if (op.kind === "del") deletions++;
      out.push(...printLine(op.kind === "eq" ? " " : op.kind === "add" ? "+" : "-", op.line));
    }
  }
  return { patch: `${out.join("\n")}\n`, additions, deletions };
}
