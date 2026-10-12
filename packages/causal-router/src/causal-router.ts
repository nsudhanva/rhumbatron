// Causal Router deterministic first pass. Pure; no model calls.
import type { TaskStatus } from "@rhumbatron/protocol";
import { type GraphTask, newlyReadyAfter } from "./scheduler.ts";

type WakeReason = "task_ready" | "dependency_changed" | "challenge" | "canonical_advanced";
export type Wake = { agentId: string; taskId: string; reason: WakeReason };
export type RouterEvent = {
  eventId: string;
  eventType: string;
  taskId?: string;
  resource?: string;
};
export type ActiveAgent = { agentId: string; taskId: string; resources: readonly string[] };
export type RoutingDecision = {
  wake: Wake[];
  ready: string[];
  ambiguous: Wake[];
  informational: boolean;
};

const INFORMATIONAL = new Set([
  "task.created",
  "task.assigned",
  "task.started",
  "agent.woken",
  "agent.slept",
  "agent.escalated",
  "model.route.decided",
  "claim.acquired",
  "claim.renewed",
  "claim.contended",
  "project.created",
  "change.created",
  "change.proposed",
  "change.included",
  "change.declined",
  "verification.check.completed",
  "build.started",
  "deployment.started",
  "preview.ready",
  "code.session.opened",
  "code.session.closed",
  "code.session.submitted",
]);

const RESOURCE_EVENTS = new Set([
  "challenge.created",
  "intent.declared",
  "intent.changed",
  "changeset.proposed",
  "claim.expired",
  "claim.released",
]);

type Overlap = "exact" | "prefix" | "none";

function overlap(a: string, b: string): Overlap {
  if (a === b) return "exact";
  return a.startsWith(`${b}:`) || b.startsWith(`${a}:`) ? "prefix" : "none";
}

function bestOverlap(resource: string, agent: ActiveAgent): Overlap {
  let best: Overlap = "none";
  for (const r of agent.resources) {
    const o = overlap(resource, r);
    if (o === "exact") return o;
    if (o === "prefix") best = o;
  }
  return best;
}

export function routeEvent(
  event: RouterEvent,
  index: { activeAgents: readonly ActiveAgent[] },
  tasks: readonly GraphTask[],
): RoutingDecision {
  const none: RoutingDecision = { wake: [], ready: [], ambiguous: [], informational: false };
  if (INFORMATIONAL.has(event.eventType)) return { ...none, informational: true };

  if (event.eventType === "task.completed") {
    return { ...none, ready: event.taskId ? newlyReadyAfter(event.taskId, tasks) : [] };
  }

  if (event.eventType === "canonical.advanced") {
    const wake = index.activeAgents.map(
      (a): Wake => ({ agentId: a.agentId, taskId: a.taskId, reason: "canonical_advanced" }),
    );
    return { ...none, wake };
  }

  if (!RESOURCE_EVENTS.has(event.eventType) || !event.resource) return none;

  const reason = event.eventType === "challenge.created" ? "challenge" : "dependency_changed";
  const wake: Wake[] = [];
  const ambiguous: Wake[] = [];
  const seen = new Set<string>();
  for (const agent of index.activeAgents) {
    if (agent.taskId === event.taskId) continue;
    const key = `${agent.agentId}\u0000${agent.taskId}`;
    if (seen.has(key)) continue;
    const o = bestOverlap(event.resource, agent);
    if (o === "none") continue;
    seen.add(key);
    (o === "exact" ? wake : ambiguous).push({
      agentId: agent.agentId,
      taskId: agent.taskId,
      reason,
    });
  }
  return { ...none, wake, ambiguous };
}

/** A stale wake must terminate quickly. */
export function isWakeStillRelevant(
  wake: { taskId: string; reason: WakeReason },
  task: { status: TaskStatus } | null,
): boolean {
  if (!task) return false;
  if (wake.reason === "task_ready") return task.status === "ready";
  return task.status === "assigned" || task.status === "running";
}
