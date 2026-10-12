import type { ProjectRootDO } from "@rhumbatron/coordinator";
import { codeBlobKey, codeManifestKey } from "@rhumbatron/protocol";
import { readTreeFiles } from "./code-store.ts";

/**
 * Deterministic inputs of the intake gate and the request comparison (ADR 0025). No model runs.
 *
 * - `CanonicalSummary`: what the current app is made of, from the planner's file listing
 *   (`readTreeFiles`), plus the name, description, and dependency names of the root
 *   `package.json` and the start of the root `README.md` (one manifest read and at most two blob
 *   reads from R2).
 * - `AppContext`: the summary plus the titles of recent shipped and in-flight requests. The
 *   clarity check reads a request as a change to this app.
 * - `RelatedItem`: another request of the same Project with its goal and criteria. Each text has a
 *   packet ID (`<changeId>:goal`, `<changeId>:c1`, ...), so a model can cite it and code can check
 *   the citation.
 */

export type Criterion = { id: string; text: string };

export type CanonicalSummary = {
  /** False when the source could not be read. Unknown source is never an empty repository. */
  known: boolean;
  empty: boolean;
  /** Up to MAX_SUMMARY_FILES paths. */
  files: string[];
  fileCount: number;
  /** Dependency and devDependency names of the root package.json. */
  dependencies: string[];
  /** Stack hints derived from paths and dependencies, for example "react" or "angularjs". */
  stack: string[];
  /** `name` and `description` of the root package.json; null when absent. */
  name: string | null;
  description: string | null;
  /** The first README_CHARS characters of the root README.md, whitespace collapsed; null when absent. */
  readme: string | null;
};

export const UNKNOWN_CANONICAL: CanonicalSummary = {
  known: false,
  empty: false,
  files: [],
  fileCount: 0,
  dependencies: [],
  stack: [],
  name: null,
  description: null,
  readme: null,
};

const MAX_SUMMARY_FILES = 60;
const README_CHARS = 600;

/** Packet items for the current app. IDs are stable so a model can cite them. */
export function canonicalItems(summary: CanonicalSummary): Criterion[] {
  if (!summary.known) return [];
  if (summary.empty) return [{ id: "canonical:files", text: "The repository is empty (no app)." }];
  const items = [
    {
      id: "canonical:files",
      text: `Files (${summary.fileCount}): ${summary.files.join(", ")}`,
    },
  ];
  if (summary.dependencies.length > 0)
    items.push({ id: "canonical:deps", text: `Dependencies: ${summary.dependencies.join(", ")}` });
  if (summary.stack.length > 0)
    items.push({ id: "canonical:stack", text: `Stack: ${summary.stack.join(", ")}` });
  return items;
}

const STACK_BY_DEPENDENCY: Record<string, string> = {
  react: "react",
  "react-dom": "react",
  angular: "angularjs",
  "@angular/core": "angular",
  vue: "vue",
  svelte: "svelte",
  hono: "hono",
  "@tanstack/react-start": "tanstack-start",
  tailwindcss: "tailwind",
};

function stackHints(files: readonly string[], dependencies: readonly string[]): string[] {
  const hints = new Set<string>();
  for (const dependency of dependencies) {
    const hint = STACK_BY_DEPENDENCY[dependency];
    if (hint) hints.add(hint);
  }
  for (const path of files) {
    if (path.endsWith(".tsx") || path.endsWith(".jsx")) hints.add("jsx");
    if (path.endsWith(".vue")) hints.add("vue");
    if (path.endsWith(".svelte")) hints.add("svelte");
    if (path === "angular.json" || path.endsWith(".component.ts")) hints.add("angular");
    if (path === "wrangler.jsonc" || path === "wrangler.toml") hints.add("cloudflare-worker");
  }
  return [...hints].sort();
}

type PackageFacts = Pick<CanonicalSummary, "dependencies" | "name" | "description" | "readme">;

const NO_FACTS: PackageFacts = { dependencies: [], name: null, description: null, readme: null };

const shortText = (value: unknown, max: number) =>
  typeof value === "string" && value.trim()
    ? value.replace(/\s+/g, " ").trim().slice(0, max)
    : null;

/** Root package.json facts and the start of the root README.md. Missing files give nulls. */
async function packageFacts(
  env: Pick<Env, "EVIDENCE">,
  projectId: string,
  treeSha: string,
): Promise<PackageFacts> {
  try {
    const manifest = await env.EVIDENCE.get(codeManifestKey(projectId, treeSha));
    if (!manifest) return NO_FACTS;
    const entries = ((await manifest.json()) as { entries?: { path: string; blob: string }[] })
      .entries;
    const blobText = async (path: string) => {
      const entry = entries?.find((e) => e.path === path);
      if (!entry) return null;
      const blob = await env.EVIDENCE.get(codeBlobKey(projectId, entry.blob));
      return blob ? blob.text() : null;
    };
    const [pkgText, readme] = await Promise.all([
      blobText("package.json"),
      blobText("README.md").catch(() => null),
    ]);
    const pkg = (pkgText ? JSON.parse(pkgText) : {}) as {
      name?: unknown;
      description?: unknown;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      dependencies: [
        ...new Set([
          ...Object.keys(pkg.dependencies ?? {}),
          ...Object.keys(pkg.devDependencies ?? {}),
        ]),
      ]
        .sort()
        .slice(0, 40),
      name: shortText(pkg.name, 80),
      description: shortText(pkg.description, 300),
      readme: shortText(readme, README_CHARS),
    };
  } catch {
    return NO_FACTS;
  }
}

export function summarizeCanonical(
  files: readonly string[] | null,
  dependencies: readonly string[] = [],
  facts: Partial<Pick<CanonicalSummary, "name" | "description" | "readme">> = {},
): CanonicalSummary {
  if (!Array.isArray(files)) return UNKNOWN_CANONICAL;
  return {
    known: true,
    empty: !files.includes("package.json"),
    files: files.slice(0, MAX_SUMMARY_FILES),
    fileCount: files.length,
    dependencies: [...dependencies],
    stack: stackHints(files, dependencies),
    name: facts.name ?? null,
    description: facts.description ?? null,
    readme: facts.readme ?? null,
  };
}

/** The current canonical tree as a summary. Unknown when ProjectRootDO or the source fails. */
export async function readCanonicalSummary(
  env: Pick<Env, "PROJECT_ROOT" | "EVIDENCE" | "ARTIFACTS">,
  projectId: string,
): Promise<CanonicalSummary> {
  try {
    const roots = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
    const canonical = await roots.get(roots.idFromName(projectId)).getCanonical();
    if (!canonical || canonical.artifactRef === "unassigned") return UNKNOWN_CANONICAL;
    const files = await readTreeFiles(env, projectId, canonical.treeSha);
    const facts = files?.includes("package.json")
      ? await packageFacts(env, projectId, canonical.treeSha)
      : NO_FACTS;
    return summarizeCanonical(files, facts.dependencies, facts);
  } catch {
    return UNKNOWN_CANONICAL;
  }
}

export type RelatedItem = {
  changeId: string;
  goal: string;
  /** The planner's short title; null before planning. */
  title?: string | null;
  status: string;
  /**
   * For a `proposed` request (ADR 0028): the requester's display name, so a duplicate question
   * can say who already proposed it. Null otherwise or when the name is unknown.
   */
  proposedBy?: string | null;
  /** `<changeId>:goal` first, then `<changeId>:c1` ... from the stored acceptance criteria. */
  items: Criterion[];
};

/** What the clarity check reads besides the request: the app and the recent requests. */
export type AppContext = {
  /** False when the source could not be read. */
  known: boolean;
  /** True when the repository has no app yet. */
  empty: boolean;
  name: string | null;
  description: string | null;
  readme: string | null;
  /** Up to MAX_SUMMARY_FILES paths of the canonical tree. */
  files: string[];
  fileCount: number;
  /** Up to MAX_CONTEXT_REQUESTS requests: in-flight ones first, then the latest shipped ones. */
  requests: { title: string; state: "in_flight" | "shipped" }[];
};

const MAX_CONTEXT_REQUESTS = 10;

/**
 * Deterministic app context for the clarity check, from the canonical summary and the related
 * requests that intake already loaded. No read and no model call.
 */
export function appContext(
  canonical: CanonicalSummary,
  requests: readonly RelatedItem[],
): AppContext {
  const seen = new Set<string>();
  const listed: AppContext["requests"] = [];
  const ordered = [
    ...requests.filter((r) => r.status !== "completed"),
    ...requests.filter((r) => r.status === "completed"),
  ];
  for (const request of ordered) {
    const text = (request.title?.trim() || request.goal).replace(/\s+/g, " ").trim();
    const title = text.length > 120 ? `${text.slice(0, 119)}…` : text;
    const key = title.toLowerCase();
    if (!title || seen.has(key)) continue;
    seen.add(key);
    listed.push({ title, state: request.status === "completed" ? "shipped" : "in_flight" });
    if (listed.length >= MAX_CONTEXT_REQUESTS) break;
  }
  return {
    known: canonical.known,
    empty: canonical.empty,
    name: canonical.name,
    description: canonical.description,
    readme: canonical.readme,
    files: canonical.files,
    fileCount: canonical.fileCount,
    requests: listed,
  };
}

/** Change statuses that end a request. */
const ENDED = ["completed", "failed", "cancelled", "not_selected", "declined"];

/**
 * Open requests of the Project plus the 20 most recent completed ones, without the Change itself.
 * A `proposed` request that waits for review counts as open, so a later duplicate gets the
 * question "already proposed by <name>". Two indexed reads (`idx_changes_project_id`), at most 70
 * rows.
 */
export async function loadRelatedRequests(
  env: Pick<Env, "DB">,
  projectId: string,
  changeId: string,
): Promise<RelatedItem[]> {
  type Row = {
    id: string;
    goal: string;
    title: string | null;
    status: string;
    acceptance_criteria_json: string;
    proposed_by?: string | null;
  };
  const [open, done] = await env.DB.batch<Row>([
    env.DB.prepare(
      `SELECT c.id, c.goal, c.title, c.status, c.acceptance_criteria_json,
              CASE WHEN c.status = 'proposed'
                THEN COALESCE(u.display_name, substr(u.email, 1, instr(u.email, '@') - 1))
              END AS proposed_by
       FROM changes c LEFT JOIN users u ON u.id = c.created_by
       WHERE c.project_id = ? AND c.id <> ? AND c.status NOT IN (${ENDED.map(() => "?").join(", ")})
       ORDER BY c.created_at DESC LIMIT 50`,
    ).bind(projectId, changeId, ...ENDED),
    env.DB.prepare(
      `SELECT id, goal, title, status, acceptance_criteria_json FROM changes
       WHERE project_id = ? AND id <> ? AND status = 'completed'
       ORDER BY updated_at DESC LIMIT 20`,
    ).bind(projectId, changeId),
  ]);
  return [...(open?.results ?? []), ...(done?.results ?? [])].map((row) => {
    let criteria: unknown = [];
    try {
      criteria = JSON.parse(row.acceptance_criteria_json);
    } catch {
      criteria = [];
    }
    const texts = Array.isArray(criteria)
      ? criteria.filter((c): c is string => typeof c === "string")
      : [];
    return {
      changeId: row.id,
      goal: row.goal,
      title: row.title,
      status: row.status,
      ...(row.status === "proposed" ? { proposedBy: row.proposed_by || null } : {}),
      items: [
        { id: `${row.id}:goal`, text: row.goal },
        ...texts.slice(0, 20).map((text, i) => ({ id: `${row.id}:c${i + 1}`, text })),
      ],
    };
  });
}

/** One answered clarification, as stored in `changes.clarification_answers_json`. */
export type StoredAnswer = {
  round: number;
  action: "answers" | "proceed_anyway";
  questionId?: string;
  question?: string;
  text?: string;
  answeredBy: string;
  answeredAt: string;
};

export function parseAnswers(json: string | null | undefined): StoredAnswer[] {
  try {
    const value = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(value) ? (value as StoredAnswer[]) : [];
  } catch {
    return [];
  }
}

/** Rounds the requester or the owner already answered (1 to 3). */
export const answeredRounds = (answers: readonly StoredAnswer[]) =>
  answers.reduce((max, answer) => Math.max(max, answer.round), 0);

/**
 * The intake gate asks at most one round per request. After any answer (answers, or "Build it as
 * it is") the request goes to planning, and the intake never asks again. The request comparison
 * after planning keeps its own rounds.
 */
export const intakeMayAsk = (answers: readonly StoredAnswer[]) => answers.length === 0;

/** The goal plus the answered questions: the text the intake gate and the planner read. */
export function goalWithAnswers(goal: string, answers: readonly StoredAnswer[]): string {
  const lines = answers
    .filter((a) => a.action === "answers" && a.text)
    .map((a) => `Q: ${a.question ?? a.questionId}\nA: ${a.text}`);
  return lines.length > 0
    ? `${goal}\n\nClarifications from the requester:\n${lines.join("\n")}`
    : goal;
}
