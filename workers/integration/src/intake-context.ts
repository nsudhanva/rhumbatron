import type { ProjectRootDO } from "@rhumbatron/coordinator";
import { codeBlobKey, codeManifestKey } from "@rhumbatron/protocol";
import { readTreeFiles } from "./code-store.ts";

/**
 * Deterministic inputs of the intake gate and the request arbiter (ADR 0025). No model runs here.
 *
 * - `CanonicalSummary`: what the current app is made of, from the planner's file listing
 *   (`readTreeFiles`) plus the dependency names of the root `package.json` (one manifest read and
 *   one blob read from R2).
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
};

export const UNKNOWN_CANONICAL: CanonicalSummary = {
  known: false,
  empty: false,
  files: [],
  fileCount: 0,
  dependencies: [],
  stack: [],
};

const MAX_SUMMARY_FILES = 60;

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

async function packageDependencies(
  env: Pick<Env, "EVIDENCE">,
  projectId: string,
  treeSha: string,
): Promise<string[]> {
  try {
    const manifest = await env.EVIDENCE.get(codeManifestKey(projectId, treeSha));
    if (!manifest) return [];
    const entries = ((await manifest.json()) as { entries?: { path: string; blob: string }[] })
      .entries;
    const entry = entries?.find((e) => e.path === "package.json");
    if (!entry) return [];
    const blob = await env.EVIDENCE.get(codeBlobKey(projectId, entry.blob));
    if (!blob) return [];
    const pkg = JSON.parse(await blob.text()) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return [
      ...new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ]),
    ]
      .sort()
      .slice(0, 40);
  } catch {
    return [];
  }
}

export function summarizeCanonical(
  files: readonly string[] | null,
  dependencies: readonly string[] = [],
): CanonicalSummary {
  if (!Array.isArray(files)) return UNKNOWN_CANONICAL;
  return {
    known: true,
    empty: !files.includes("package.json"),
    files: files.slice(0, MAX_SUMMARY_FILES),
    fileCount: files.length,
    dependencies: [...dependencies],
    stack: stackHints(files, dependencies),
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
    const dependencies = files?.includes("package.json")
      ? await packageDependencies(env, projectId, canonical.treeSha)
      : [];
    return summarizeCanonical(files, dependencies);
  } catch {
    return UNKNOWN_CANONICAL;
  }
}

export type RelatedItem = {
  changeId: string;
  goal: string;
  status: string;
  /**
   * For a `proposed` request (ADR 0028): the requester's display name, so a duplicate question
   * can say who already proposed it. Null otherwise or when the name is unknown.
   */
  proposedBy?: string | null;
  /** `<changeId>:goal` first, then `<changeId>:c1` ... from the stored acceptance criteria. */
  items: Criterion[];
};

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
    status: string;
    acceptance_criteria_json: string;
    proposed_by?: string | null;
  };
  const [open, done] = await env.DB.batch<Row>([
    env.DB.prepare(
      `SELECT c.id, c.goal, c.status, c.acceptance_criteria_json,
              CASE WHEN c.status = 'proposed'
                THEN COALESCE(u.display_name, substr(u.email, 1, instr(u.email, '@') - 1))
              END AS proposed_by
       FROM changes c LEFT JOIN users u ON u.id = c.created_by
       WHERE c.project_id = ? AND c.id <> ? AND c.status NOT IN (${ENDED.map(() => "?").join(", ")})
       ORDER BY c.created_at DESC LIMIT 50`,
    ).bind(projectId, changeId, ...ENDED),
    env.DB.prepare(
      `SELECT id, goal, status, acceptance_criteria_json FROM changes
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

/** The goal plus the answered questions: the text the intake gate and the planner read. */
export function goalWithAnswers(goal: string, answers: readonly StoredAnswer[]): string {
  const lines = answers
    .filter((a) => a.action === "answers" && a.text)
    .map((a) => `Q: ${a.question ?? a.questionId}\nA: ${a.text}`);
  return lines.length > 0
    ? `${goal}\n\nClarifications from the requester:\n${lines.join("\n")}`
    : goal;
}
