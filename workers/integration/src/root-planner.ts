import {
  applyOpusPolicy,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  routeByRules,
} from "@rhumbatron/model-router";
import {
  APP_CONVENTIONS,
  checkWorkGraph,
  clampTitle,
  MAX_ASSUMPTIONS,
  type PlannedTask,
  type RouteRequest,
  WorkGraphPlan,
} from "@rhumbatron/protocol";
import { z } from "zod";
import { normalizeToolArgs } from "./plan-normalize.ts";

/**
 * Root Planner contract. The model must answer with one
 * `submit_work_graph` tool call. Application code validates it; the model never decides its scope.
 */

const SUBMIT_TOOL = "submit_work_graph";

const SYSTEM_PROMPT = `You are the Root Planner of Rhumbatron, a system where many software agents change one codebase in parallel.
Turn the user's goal into a small dependency graph of Tasks. Rules:
- title: a short title for the request, at most 6 words, plain words, no trailing punctuation (for example "Kanban feature" or "React and Tailwind redesign"). When the goal has clarifications, the title names the request with the answers applied.
- 2 to 8 Tasks. Each Task is one bounded unit of work that one agent can finish and verify alone.
- Keys are t1, t2, ... in order. dependsOn lists keys that must finish first. No cycles.
- Tasks that do not depend on each other must not list each other, so they can run in parallel.
- A UI Task that calls routes another Task of this plan defines must depend on that Task, so the UI is written against the real API (for example todos:ui depends on todos:api). Never plan a UI and its API in parallel.
- semanticResources are colon-separated kebab-case product areas, for example wishlist:membership or cart:totals.
- Use kind "design" only for decisions other Tasks need first; "test" for verification work; "document" sparingly.
- acceptanceCriteria are observable results, not activities.
- invariants are behaviours that must not change, taken from the goal (for example existing cart behaviour).
- assumptions: the small product details the goal leaves open that you decided (for example which colors, sizes, labels, or defaults), one plain sentence each, at most ${MAX_ASSUMPTIONS}. Decide each open detail instead of planning a question. Empty when the goal decides everything.
- riskTier: high when a Task changes authorization, data ownership, or migrations; critical only for destructive changes.
- Do not plan deployment or release Tasks; Rhumbatron releases automatically.
- Rhumbatron builds and hosts the Project as a live app. Every Task must keep it in this shape:
${APP_CONVENTIONS.map((c) => `  - ${c}`).join("\n")}
- When the repository is empty, t1 is the bootstrap Task (kind "implement"): it creates package.json, tsconfig.json, wrangler.jsonc, src/app.ts with GET /api/health, src/worker.ts, src/server.ts, public/index.html, scripts/contract.ts and one passing test, so typecheck, test and contract pass. Every other Task depends on t1.
Call ${SUBMIT_TOOL} exactly once. Do not write any other text.`;

export type PlannerInput = {
  goal: string;
  projectName: string;
  /** Current canonical tree's file paths; null when the source is unavailable. */
  files?: string[] | null;
  /** Open details the intake gate found; the planner decides each one and records it. */
  openDetails?: string[];
};

/** Paths listed to the planner; the rest are counted. */
const MAX_LISTED_FILES = 200;

/** True when the repository has no app yet: an empty repository has no root package.json. */
export function isEmptyRepository(files: readonly string[] | null | undefined): boolean {
  return Array.isArray(files) && !files.includes("package.json");
}

/**
 * An empty repository needs a bootstrap Task first: t1 is an implement Task and every other Task
 * depends on it, directly or through other Tasks. Returns errors for a repair turn.
 */
function checkBootstrap(plan: WorkGraphPlan): string[] {
  const t1 = plan.tasks.find((t) => t.key === "t1");
  if (t1?.kind !== "implement") {
    return ['the repository is empty: t1 must be the bootstrap Task with kind "implement"'];
  }
  const deps = new Map(plan.tasks.map((t) => [t.key, t.dependsOn]));
  const reaches = (key: string, seen = new Set<string>()): boolean => {
    if (key === "t1") return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return (deps.get(key) ?? []).some((d) => reaches(d, seen));
  };
  const missing = plan.tasks.filter((t) => t.key !== "t1" && !reaches(t.key)).map((t) => t.key);
  return missing.length > 0
    ? [`the repository is empty: ${missing.join(", ")} must depend on the bootstrap Task t1`]
    : [];
}

const UI_SEGMENT = /(^|-)(ui|frontend|page)$/;
const API_SEGMENT = /(^|-)api$/;
const UI_TITLE = /\b(ui|page|frontend)\b/i;

const segments = (resource: string) => resource.toLowerCase().split(":");
const area = (resource: string) => segments(resource)[0] ?? "";
const last = (resource: string) => segments(resource).at(-1) ?? "";

/**
 * Deterministic plan repair, no model call: a UI Task (a resource ending in `ui`, `-ui`,
 * `frontend`, or `page`, or a title that says UI, page, or frontend) and an API Task (a resource
 * ending in `api` or `-api`) on the same area (first resource segment, `todos` in `todos:ui`) with
 * no dependency path between them get the edge UI -> API. Then the UI agent runs after the API
 * and reads its real routes instead of guessing them. Needs an acyclic graph; returns the added
 * edges as `ui->api` key pairs.
 */
function linkUiToApi(tasks: readonly PlannedTask[]): { tasks: PlannedTask[]; linked: string[] } {
  const deps = new Map(tasks.map((t) => [t.key, [...t.dependsOn]]));
  const reaches = (from: string, to: string) => {
    const seen = new Set<string>();
    const queue = [...(deps.get(from) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift() as string;
      if (next === to) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(deps.get(next) ?? []));
    }
    return false;
  };
  const apiAreas = (t: PlannedTask) =>
    t.semanticResources.filter((r) => API_SEGMENT.test(last(r))).map(area);
  const uiAreas = (t: PlannedTask) => {
    if (apiAreas(t).length > 0) return [];
    const byResource = t.semanticResources.filter((r) => UI_SEGMENT.test(last(r))).map(area);
    if (byResource.length > 0) return byResource;
    return UI_TITLE.test(t.title) ? t.semanticResources.map(area) : [];
  };
  const linked: string[] = [];
  for (const ui of tasks) {
    const areas = new Set(uiAreas(ui));
    if (areas.size === 0) continue;
    for (const api of tasks) {
      if (api.key === ui.key || !apiAreas(api).some((a) => areas.has(a))) continue;
      if (reaches(ui.key, api.key) || reaches(api.key, ui.key)) continue;
      deps.get(ui.key)?.push(api.key);
      linked.push(`${ui.key}->${api.key}`);
    }
  }
  return {
    tasks: tasks.map((t) => ({ ...t, dependsOn: deps.get(t.key) ?? t.dependsOn })),
    linked,
  };
}

function repositoryLine(files: readonly string[] | null | undefined): string {
  if (!Array.isArray(files)) return "Repository: unknown.";
  if (isEmptyRepository(files)) {
    return "Repository: empty (no app yet). Plan the bootstrap Task t1 first.";
  }
  const shown = files.slice(0, MAX_LISTED_FILES);
  const more = files.length - shown.length;
  return `Repository files (${files.length}):\n${shown.join("\n")}${more > 0 ? `\n… ${more} more` : ""}`;
}

export type PlannerResult = {
  plan: WorkGraphPlan;
  criteria: { id: string; text: string }[];
  /** Topological order of Task keys. */
  order: string[];
  attempts: number;
  calls: Pick<
    CompletionResult,
    "provider" | "model" | "inputTokens" | "outputTokens" | "costUsd" | "latencyMs" | "gatewayLogId"
  >[];
  /** `requestedTier` is set when policy lowered the tier (ADR 0021: Opus off). */
  route: { tier: string; reasons: string[]; requestedTier?: string };
};

export class PlannerError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly lastErrors: string[],
  ) {
    super(message);
  }
}

/** Validation failures cross the Workflow step boundary as data; model failures still retry. */
export type PlannerStepResult =
  | { ok: true; planned: PlannerResult }
  | { ok: false; errors: string[] };

export async function planChangeResult(
  input: PlannerInput,
  complete: Complete,
  options: { allowOpus?: boolean } = {},
): Promise<PlannerStepResult> {
  try {
    return { ok: true, planned: await planChange(input, complete, options) };
  } catch (error) {
    if (!(error instanceof PlannerError)) throw error;
    return { ok: false, errors: error.lastErrors };
  }
}

type Complete = (req: CompletionRequest) => Promise<CompletionResult>;

const PLANNER_ROUTE: RouteRequest = {
  taskKind: "plan",
  complexity: "large",
  riskTier: "medium",
  affectedFiles: 0,
  affectedResources: [],
  attempt: 1,
  priorFailureKinds: [],
  hasDesignConflict: false,
  touchesAuthorization: false,
  touchesBilling: false,
  touchesMigration: false,
  destructiveMigration: false,
  contextTokensEstimate: 1500,
  expectedToolCalls: 1,
  budgetRemainingUsd: 3,
};

const tool = {
  type: "function" as const,
  function: {
    name: SUBMIT_TOOL,
    description: "Submit the Work Graph for the goal.",
    parameters: z.toJSONSchema(WorkGraphPlan) as Record<string, unknown>,
  },
};

/** Parses and checks one tool call. Returns the plan or human-readable errors for a repair turn. */
export function parsePlan(
  args: string | undefined,
  options: { emptyRepository?: boolean } = {},
):
  | { ok: true; plan: WorkGraphPlan; order: string[]; linked: string[] }
  | { ok: false; errors: string[] } {
  if (!args) return { ok: false, errors: [`no ${SUBMIT_TOOL} call`] };
  let json: unknown;
  try {
    json = JSON.parse(args);
  } catch {
    return { ok: false, errors: ["arguments are not valid JSON"] };
  }
  // Undo harmless encoding slips first, for example `"riskTier": "\"low\""` (seen on prod).
  const normalized = normalizeToolArgs(json);
  // The title is display text: a missing or bad title never costs a repair turn. Blank means
  // "no title"; the API then shows `fallbackTitle(goal)`.
  if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
    const args = normalized as Record<string, unknown>;
    args.title = clampTitle(typeof args.title === "string" ? args.title : null) ?? "";
    // Assumptions are display text too: drop bad entries and cut the list, never a repair turn.
    args.assumptions = Array.isArray(args.assumptions)
      ? args.assumptions
          .filter((a): a is string => typeof a === "string" && a.trim().length >= 3)
          .map((a) => a.trim().slice(0, 300))
          .slice(0, MAX_ASSUMPTIONS)
      : [];
  }
  const parsed = WorkGraphPlan.safeParse(normalized);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.join(".") || "root"}: ${i.message}`),
    };
  }
  const checked = checkWorkGraph(parsed.data.tasks);
  if (!checked.ok) return checked;
  // The repair only adds edges between Tasks with no path between them: still acyclic.
  const ui = linkUiToApi(parsed.data.tasks);
  const surface = serializeSameSurface(ui.tasks);
  const { tasks } = surface;
  const linked = [...ui.linked, ...surface.linked];
  const plan = { ...parsed.data, tasks };
  const graph = checkWorkGraph(tasks);
  if (!graph.ok) return graph;
  const bootstrap = options.emptyRepository ? checkBootstrap(plan) : [];
  return bootstrap.length > 0
    ? { ok: false, errors: bootstrap }
    : { ok: true, plan, order: graph.order, linked };
}

/**
 * Deterministic plan repair, no model call, after `linkUiToApi`: every UI Task edits the one page
 * `public/index.html`, and every API Task edits `src/app.ts` (APP_CONVENTIONS). Two Tasks of one
 * kind built in parallel on one base never merge, and a re-run on the other's work follows. So
 * Tasks of one kind with no dependency path between them run in plan order: the later key gets an
 * edge to the earlier one. A UI Task and an API Task still run in parallel. The edge goes from a
 * later key to an earlier key only when no path leads from the earlier to the later: still acyclic.
 */
function serializeSameSurface(tasks: readonly PlannedTask[]): {
  tasks: PlannedTask[];
  linked: string[];
} {
  const deps = new Map(tasks.map((t) => [t.key, [...t.dependsOn]]));
  const reaches = (from: string, to: string) => {
    const seen = new Set<string>();
    const queue = [...(deps.get(from) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift() as string;
      if (next === to) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(deps.get(next) ?? []));
    }
    return false;
  };
  const isApi = (t: PlannedTask) => t.semanticResources.some((r) => API_SEGMENT.test(last(r)));
  const isUi = (t: PlannedTask) =>
    !isApi(t) &&
    (t.semanticResources.some((r) => UI_SEGMENT.test(last(r))) || UI_TITLE.test(t.title));
  const order = (key: string) => Number(key.replace(/\D/g, "")) || 0;
  const linked: string[] = [];
  for (const kind of [isUi, isApi]) {
    const group = tasks.filter(kind).sort((a, b) => order(a.key) - order(b.key));
    for (let j = 1; j < group.length; j++) {
      const later = group[j] as PlannedTask;
      for (let i = j - 1; i >= 0; i--) {
        const earlier = group[i] as PlannedTask;
        if (reaches(later.key, earlier.key) || reaches(earlier.key, later.key)) continue;
        deps.get(later.key)?.push(earlier.key);
        linked.push(`${later.key}->${earlier.key}`);
      }
    }
  }
  return {
    tasks: tasks.map((t) => ({ ...t, dependsOn: deps.get(t.key) ?? t.dependsOn })),
    linked,
  };
}

/** At most two model calls: the plan, then one repair turn with the validation errors. */
export async function planChange(
  input: PlannerInput,
  complete: Complete,
  options: { allowOpus?: boolean } = {},
): Promise<PlannerResult> {
  const route = applyOpusPolicy(routeByRules(PLANNER_ROUTE), options.allowOpus ?? true);
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Project: ${input.projectName}\n${repositoryLine(input.files)}\nGoal:\n${input.goal}${input.openDetails?.length ? `\nOpen details (decide each one and record your choice in assumptions):\n- ${input.openDetails.join("\n- ")}` : ""}`,
    },
  ];
  const emptyRepository = isEmptyRepository(input.files);
  const calls: PlannerResult["calls"] = [];
  let lastErrors: string[] = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await complete({
      tier: route.selectedTier,
      maxOutputTokens: route.maxOutputTokens,
      messages,
      tools: [tool],
      metadata: { source: "root-planner", attempt: String(attempt) },
    });
    calls.push({
      provider: result.provider,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      gatewayLogId: result.gatewayLogId,
    });

    const call = result.toolCalls.find((c) => c.function.name === SUBMIT_TOOL);
    const outcome = parsePlan(call?.function.arguments, { emptyRepository });
    if (outcome.ok) {
      if (outcome.linked.length > 0) {
        console.warn(JSON.stringify({ event: "planner.linked_ui_to_api", edges: outcome.linked }));
      }
      return {
        plan: outcome.plan,
        criteria: outcome.plan.acceptanceCriteria.map((text, index) => ({
          id: `c${index + 1}`,
          text,
        })),
        order: outcome.order,
        attempts: attempt,
        calls,
        route: {
          tier: route.selectedTier,
          reasons: route.reasons,
          ...(route.requestedTier ? { requestedTier: route.requestedTier } : {}),
        },
      };
    }
    lastErrors = outcome.errors;
    console.warn(JSON.stringify({ event: "planner.invalid", errors: lastErrors, attempt }));

    // Repair turn: show the model its own call and the exact validation errors.
    if (call) {
      // The whole assistant turn, thinking blocks included, as the API requires for a tool turn.
      messages.push(result.message);
      // Every tool call of the turn needs its result; only the first submit call is checked.
      for (const other of result.toolCalls) {
        messages.push({
          role: "tool",
          tool_call_id: other.id,
          content:
            other.id === call.id
              ? `Rejected. Fix these errors and call ${SUBMIT_TOOL} again:\n- ${outcome.errors.join("\n- ")}`
              : `Ignored. Call ${SUBMIT_TOOL} exactly once.`,
        });
      }
    } else {
      messages.push(result.message);
      messages.push({
        role: "user",
        content: `You must call ${SUBMIT_TOOL}. Errors:\n- ${outcome.errors.join("\n- ")}`,
      });
    }
  }
  throw new PlannerError("Root Planner did not produce a valid Work Graph", 2, lastErrors);
}
