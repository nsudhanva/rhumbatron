// Integrate rule for complementary Tasks (AGENTS.md sections 32.4 and 33). Pure; no model calls.
// Two Tasks of one Change on different semantic resources are parts of one plan, never
// alternatives: a conflict between them makes one Task build on the other, not a Candidate fork.
import type { Intent } from "@rhumbatron/protocol";
import { normalizeResource, normalizeTarget, resourceOverlap } from "./normalize.ts";

/** The planned Task behind one side of a conflict. */
export type PlanTask = {
  key: string;
  title: string;
  /** Planned semantic resources (D1 `tasks.semantic_resources_json`), relative or absolute. */
  resources: readonly string[];
};

/** One Task re-runs on a stacked workspace that includes the other Task's ChangeSet. */
export type Integration = {
  /** Gets the dependency edge and re-runs once. */
  dependentTaskId: string;
  dependsOnTaskId: string;
  reason: string;
};

/** Order-independent key of a Task pair. */
export const taskPairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** True when `from` depends on `to`, directly or through other Tasks. */
export function dependsOnPath(
  from: string,
  to: string,
  dependsOn: Readonly<Record<string, readonly string[]>>,
): boolean {
  const seen = new Set<string>();
  const queue = [...(dependsOn[from] ?? [])];
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (next === to) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(dependsOn[next] ?? []));
  }
  return false;
}

const UI_SEGMENT = /(^|-)(ui|frontend|page)$/;
const API_SEGMENT = /(^|-)api$/;
const UI_TITLE = /\b(ui|page|frontend)\b/i;
const API_TITLE = /\bapi\b/i;

const lastSegment = (resource: string) => normalizeResource(resource).split(":").at(-1) ?? "";

type Role = "ui" | "api" | null;

/** A Task whose resources end in `ui` or `api` (`todos:ui`, `missions:calendar-ui`), else its title. */
function roleOf(task: PlanTask): Role {
  const segments = task.resources.map(lastSegment);
  const ui = segments.some((s) => UI_SEGMENT.test(s));
  const api = segments.some((s) => API_SEGMENT.test(s));
  if (ui !== api) return ui ? "ui" : "api";
  if (ui) return null;
  const uiTitle = UI_TITLE.test(task.title);
  const apiTitle = API_TITLE.test(task.title);
  return uiTitle && !apiTitle ? "ui" : apiTitle && !uiTitle ? "api" : null;
}

/** True when `consumer` uses a contract target that `owner` declares as a change. */
function consumes(consumer: Intent, owner: Intent): boolean {
  const owned = new Set(owner.expectedContractChanges.map((c) => normalizeTarget(c.target)));
  return (consumer.consumedContracts ?? []).some((t) => owned.has(normalizeTarget(t)));
}

/** `t3` sorts after `t2` and before `t10`; other keys compare as text. */
function keyOrder(a: string, b: string): number {
  const na = /^t(\d+)$/.exec(a)?.[1];
  const nb = /^t(\d+)$/.exec(b)?.[1];
  if (na !== undefined && nb !== undefined) return Number(na) - Number(nb);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The integrate decision for a conflict between two Intents of one Change, or null when the two
 * Tasks are alternatives (fork rule) or were integrated once already (`integrated` pair keys).
 * Complementary means both Tasks have planned resources and no resource of one equals, contains,
 * or is contained in a resource of the other (`todos:api` and `todos:ui`).
 * Order: an existing dependency path decides; else the UI Task depends on the API Task; else the
 * Task whose Intent consumes the other's contract depends on it; else the higher Task key depends
 * on the lower.
 */
export function integrationFor(
  pair: readonly [Intent, Intent],
  tasks: ReadonlyMap<string, PlanTask>,
  dependsOn: Readonly<Record<string, readonly string[]>>,
  integrated: ReadonlySet<string> = new Set(),
): Integration | null {
  const [a, b] = pair;
  if (a.taskId === b.taskId || integrated.has(taskPairKey(a.taskId, b.taskId))) return null;
  const ta = tasks.get(a.taskId);
  const tb = tasks.get(b.taskId);
  if (!ta || !tb) return null;
  const ra = ta.resources.length > 0 ? ta.resources : a.semanticResources;
  const rb = tb.resources.length > 0 ? tb.resources : b.semanticResources;
  if (ra.length === 0 || rb.length === 0) return null;
  const overlap = ra.some((x) =>
    rb.some((y) => resourceOverlap(normalizeResource(x), normalizeResource(y)) !== "none"),
  );
  if (overlap) return null;

  const label = (t: PlanTask) => `${t.key || "Task"} (${t.resources.join(", ")})`;
  const decide = (dependent: Intent, on: Intent, why: string): Integration => {
    const td = dependent === a ? ta : tb;
    const to = dependent === a ? tb : ta;
    return {
      dependentTaskId: dependent.taskId,
      dependsOnTaskId: on.taskId,
      reason: `${label(td)} builds on ${label(to)}: ${why}`,
    };
  };
  if (dependsOnPath(a.taskId, b.taskId, dependsOn)) return decide(a, b, "it already depends on it");
  if (dependsOnPath(b.taskId, a.taskId, dependsOn)) return decide(b, a, "it already depends on it");
  const roleA = roleOf(ta);
  const roleB = roleOf(tb);
  if (roleA === "ui" && roleB === "api") return decide(a, b, "the UI uses the API");
  if (roleB === "ui" && roleA === "api") return decide(b, a, "the UI uses the API");
  const aUsesB = consumes(a, b);
  const bUsesA = consumes(b, a);
  if (aUsesB !== bUsesA) {
    return aUsesB ? decide(a, b, "it uses its contract") : decide(b, a, "it uses its contract");
  }
  const order = keyOrder(ta.key, tb.key) || (a.taskId < b.taskId ? -1 : 1);
  return order > 0
    ? decide(a, b, "later Task in the plan")
    : decide(b, a, "later Task in the plan");
}
