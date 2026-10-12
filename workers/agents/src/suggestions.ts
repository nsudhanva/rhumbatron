import type { ProjectRootDO } from "@rhumbatron/coordinator";
import { type DecisionModel, WorkersAiDecisionModel } from "@rhumbatron/model-router";
import { type GoalSuggestions, sourceIndexKey } from "@rhumbatron/protocol";
import { takeQuota } from "./limits.ts";

/**
 * Goal suggestion pills (new Change goal box). Clef is a choice model: it cannot write text, so it
 * ranks a fixed catalog of short goals for the Project. The state it sees is the Project name,
 * its canonical file list, and its recent Change goals. Never logged.
 *
 * Cost: a cache hit is one D1 read. A miss is at most one Clef call per Project and Canonical
 * Generation, under a daily cap in `usage_counters`. A failed or refused call caches an
 * empty list, retried after one hour.
 */

/** Goals for a Project with no app code yet. */
export const START_GOALS = [
  "Make me a todo app",
  "Make a notes app with search",
  "Make a shared shopping list",
  "Make a simple blog with posts",
  "Make a habit tracker",
  "Make a poll where people vote",
  "Make a guestbook page",
  "Make a link-in-bio page",
  "Make a recipe collection",
  "Make an event RSVP page",
  "Make a team kanban board",
  "Make a personal wishlist with share links",
] as const;

/** Goals for a Project that already has app code. */
export const EXTEND_GOALS = [
  "Add a contact form that stores messages",
  "Add search to the main list",
  "Add a dark mode toggle",
  "Add a demo user picker for accounts",
  "Add sharing with a public link",
  "Add tags and filtering",
  "Add an about page",
  "Add sorting by date and name",
  "Add export to CSV",
  "Add input validation with clear errors",
  "Add pagination to long lists",
  "Improve the page layout on mobile",
] as const;

const PILLS = 4;
/** Clef calls per day for suggestions, per environment (Workers AI free: 10,000 Neurons a day). */
const SUGGESTION_DAILY_CAP = 100;
const RETRY_EMPTY_MS = 60 * 60 * 1000;
const MAX_FILES = 200;
const RECENT_GOALS = 5;
const CODE_FILE = /\.(m?[jt]sx?|html)$/;

/** True when the file list holds app code (else the Project starts from nothing). */
export const hasAppCode = (files: readonly string[]) => files.some((f) => CODE_FILE.test(f));

/**
 * The top `count` options by Clef probability. Missing probabilities count as 0; ties keep catalog
 * order. No answer at all (abstain without probabilities) gives no suggestions.
 */
export function rankOptions(
  options: readonly string[],
  probabilities: Record<string, number>,
  count = PILLS,
): string[] {
  if (Object.keys(probabilities).length === 0) return [];
  return options
    .map((option, index) => ({ option, index, p: probabilities[option] ?? 0 }))
    .sort((a, b) => b.p - a.p || a.index - b.index)
    .slice(0, count)
    .map((r) => r.option);
}

type SuggestEnv = Pick<Env, "DB" | "EVIDENCE" | "PROJECT_ROOT" | "AI">;

const today = () => new Date().toISOString().slice(0, 10);

/** Reads the cache row; a stale empty row counts as a miss. */
async function cached(env: SuggestEnv, projectId: string, generation: number, now: number) {
  const row = await env.DB.prepare(
    "SELECT suggestions_json, created_at FROM goal_suggestions WHERE project_id = ? AND generation = ?",
  )
    .bind(projectId, generation)
    .first<{ suggestions_json: string; created_at: string }>();
  if (!row) return null;
  const list = JSON.parse(row.suggestions_json) as string[];
  if (list.length === 0 && now - Date.parse(row.created_at) > RETRY_EMPTY_MS) return null;
  return list;
}

async function canonicalFiles(env: SuggestEnv, treeSha: string, projectId: string) {
  const object = await env.EVIDENCE.get(sourceIndexKey(projectId, treeSha));
  if (!object) return [];
  const index = (await object.json().catch(() => null)) as { files?: string[] } | null;
  return index?.files ?? [];
}

export async function suggestGoals(
  env: SuggestEnv,
  projectId: string,
  model?: DecisionModel,
): Promise<GoalSuggestions> {
  const project = await env.DB.prepare("SELECT name, status FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{ name: string; status: string }>();
  if (project?.status !== "active") return { suggestions: [], generation: null };
  const root = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  const canonical = await root.get(root.idFromName(projectId)).getCanonical();
  if (!canonical) return { suggestions: [], generation: null };
  const { generation } = canonical;

  const now = Date.now();
  const hit = await cached(env, projectId, generation, now);
  if (hit) return { suggestions: hit, generation };

  const files =
    canonical.artifactRef === "unassigned"
      ? []
      : await canonicalFiles(env, canonical.treeSha, projectId);
  const recent = await env.DB.prepare(
    "SELECT goal FROM changes WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
  )
    .bind(projectId, RECENT_GOALS)
    .all<{ goal: string }>();
  const options = hasAppCode(files) ? EXTEND_GOALS : START_GOALS;

  let suggestions: string[] = [];
  try {
    const clef =
      model ??
      new WorkersAiDecisionModel({
        ai: env.AI,
        // Ranking uses the probabilities; the choice itself is never acted on.
        abstainBelow: 0,
        allowCall: () => takeQuota(env.DB, today(), "goal-suggestions", SUGGESTION_DAILY_CAP),
      });
    const [answer] = await clef.decide({
      model: "clef-flash",
      state: {
        project: project.name.slice(0, 120),
        files: files.slice(0, MAX_FILES),
        fileCount: files.length,
        recentGoals: (recent.results ?? []).map((r) => r.goal.slice(0, 300)),
      },
      questions: [
        {
          id: "next_goal",
          prompt:
            "Which goal is the most useful next request for this Project? Prefer goals that fit its name, its files, and its recent goals, and that it has not done yet.",
          options,
        },
      ],
    });
    suggestions = answer ? rankOptions(options, answer.probabilities) : [];
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "suggestions.failed",
        projectId,
        error: String(error).slice(0, 200),
      }),
    );
  }

  await env.DB.prepare(
    `INSERT INTO goal_suggestions (project_id, generation, suggestions_json, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (project_id, generation) DO UPDATE SET
       suggestions_json = excluded.suggestions_json, created_at = excluded.created_at`,
  )
    .bind(projectId, generation, JSON.stringify(suggestions), new Date(now).toISOString())
    .run();
  return { suggestions, generation };
}
