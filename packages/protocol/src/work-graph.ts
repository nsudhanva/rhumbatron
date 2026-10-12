import { z } from "zod";
import { Complexity, Id, RiskTier } from "./common.ts";

/** Semantic resource relative to the Project, for example `wishlist:membership`. */
export const RelativeResource = z
  .string()
  .regex(/^[a-z0-9-]+(:[a-z0-9-]+)*$/, "resource must be colon-separated kebab-case");
export type RelativeResource = z.infer<typeof RelativeResource>;

export const TaskKind = z.enum(["design", "implement", "migrate", "test", "review", "document"]);
export type TaskKind = z.infer<typeof TaskKind>;

export const TaskStatus = z.enum([
  "pending",
  "ready",
  "assigned",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Upper bound on Tasks per Change (small active sets). */
export const MAX_TASKS_PER_CHANGE = 12;

/** One Task as the Root Planner proposes it. `key` is local to the plan, for example `t1`. */
export const PlannedTask = z.object({
  key: z.string().regex(/^t[0-9]{1,2}$/),
  title: z.string().min(3).max(120),
  kind: TaskKind,
  objective: z.string().min(10).max(1000),
  semanticResources: z.array(RelativeResource).min(1).max(5),
  dependsOn: z.array(z.string()).max(MAX_TASKS_PER_CHANGE),
  acceptanceCriteria: z.array(z.string().min(3).max(300)).min(1).max(8),
  riskTier: RiskTier,
  complexity: Complexity,
  touchesAuthorization: z.boolean(),
  touchesBilling: z.boolean(),
  touchesMigration: z.boolean(),
});
export type PlannedTask = z.infer<typeof PlannedTask>;

/** Upper bound on the assumptions the Root Planner records for one Change. */
export const MAX_ASSUMPTIONS = 8;

/** Root Planner output contract. */
export const WorkGraphPlan = z.object({
  /** Cut to MAX_TITLE_CHARS at a word boundary after parsing (`clampTitle`). */
  title: z
    .string()
    .max(200)
    .describe("A short title for the request, at most 6 words, for example Kanban feature"),
  acceptanceCriteria: z.array(z.string().min(3).max(300)).min(1).max(12),
  invariants: z.array(z.string().min(3).max(300)).max(12),
  /**
   * Small product details the goal leaves open that the planner decided (colors, sizes, labels,
   * defaults). Stored on the Change and shown as "Assumptions"; a follow-up request changes one.
   */
  assumptions: z
    .array(z.string().min(3).max(300))
    .max(MAX_ASSUMPTIONS)
    .default([])
    .describe("Open details you decided, one plain sentence each"),
  riskTier: RiskTier,
  tasks: z.array(PlannedTask).min(1).max(MAX_TASKS_PER_CHANGE),
});
export type WorkGraphPlan = z.infer<typeof WorkGraphPlan>;

export type WorkGraphCheck = { ok: true; order: string[] } | { ok: false; errors: string[] };

/**
 * Structural checks Zod cannot express: unique keys, known dependencies, no self-dependency,
 * and no cycle. Returns a topological order of Task keys when the graph is valid.
 */
export function checkWorkGraph(
  tasks: readonly Pick<PlannedTask, "key" | "dependsOn">[],
): WorkGraphCheck {
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const task of tasks) {
    if (keys.has(task.key)) errors.push(`duplicate task key ${task.key}`);
    keys.add(task.key);
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.key) errors.push(`${task.key} depends on itself`);
      else if (!keys.has(dep)) errors.push(`${task.key} depends on unknown task ${dep}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // Kahn's algorithm. Ties keep plan order, so the result is deterministic.
  const remaining = new Map(tasks.map((t) => [t.key, new Set(t.dependsOn)]));
  const order: string[] = [];
  while (remaining.size > 0) {
    const next = [...remaining].find(([, deps]) => deps.size === 0)?.[0];
    if (next === undefined) {
      return { ok: false, errors: [`dependency cycle among ${[...remaining.keys()].join(", ")}`] };
    }
    order.push(next);
    remaining.delete(next);
    for (const deps of remaining.values()) deps.delete(next);
  }
  return { ok: true, order };
}

/** Persisted Task. */
export const Task = z.object({
  id: Id,
  changeId: Id,
  key: z.string(),
  title: z.string(),
  kind: TaskKind,
  objective: z.string(),
  semanticResources: z.array(z.string()),
  dependsOn: z.array(Id),
  acceptanceCriteria: z.array(z.string()),
  riskTier: RiskTier,
  complexity: Complexity,
  status: TaskStatus,
  assignedAgentId: Id.nullable(),
});
export type Task = z.infer<typeof Task>;

/** Wake command payload for `rhumbatron-agent-wakeups`. */
export const AgentWakePayload = z.object({
  eventId: Id,
  agentId: Id,
  reason: z.enum(["task_ready", "dependency_changed", "challenge", "canonical_advanced"]),
  contextCursor: z.string(),
  priority: z.number().int().min(0).max(9),
  budgetRemainingUsd: z.number().nonnegative(),
});
export type AgentWakePayload = z.infer<typeof AgentWakePayload>;
