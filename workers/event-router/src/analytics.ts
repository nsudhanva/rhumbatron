import type { EventEnvelope } from "@rhumbatron/protocol";

/**
 * Analytics projector (AGENTS.md sections 19 and 41.1, HOM-202). The `analytics-projector` K2
 * subscription turns lifecycle Events into Workers Analytics Engine data points. Deterministic: a
 * fixed table maps Event types to section 41.1 metric names; every other Event writes nothing.
 *
 * Points go to their own dataset (binding EVENT_METRICS, `rhumbatron_event_metrics_<env>`), so they
 * never double-count the points the agents and indexer Workers write at the source (METRICS).
 *
 * Schema of one point:
 *   index1  project ID
 *   blob1   metric name (section 41.1), blob2 result, blob3 model tier or "", blob4 Change ID or "",
 *   blob5   Task ID or "", blob6 Event type, blob7 actor kind
 *   double1 1 (count), double2 Canonical Generation
 *
 * Volume: one point per mapped Event. A Change emits about 50 to 150 Events, and about a third of
 * them map, so a busy demo day of 20 Changes writes about 1,000 points, 1 percent of the 100,000
 * free daily data points.
 */

/** Analytics Engine allows 250 data points per invocation. One cron tick writes at most this many. */
export const ANALYTICS_POINT_CAP = 100;

type Mapped = { name: string; result: string };

const text = (payload: unknown, key: string): string | undefined => {
  const value = (payload as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value : undefined;
};

/** Section 41.1 metric for one Event, or null when the Event is not a measured fact. */
export function metricFor(event: EventEnvelope): Mapped | null {
  const p = event.payload;
  switch (event.eventType) {
    case "change.created":
      return { name: "change_created", result: "created" };
    case "change.completed":
      return { name: "change_completed", result: "completed" };
    case "change.failed":
      return { name: "change_completed", result: "failed" };
    case "change.cancelled":
      return { name: "change_completed", result: "cancelled" };
    case "task.started":
      return { name: "task_started", result: "started" };
    case "task.completed":
      return { name: "task_completed", result: "ok" };
    case "task.failed":
      return { name: "task_failed", result: text(p, "kind") ?? "failed" };
    case "agent.woken":
      return { name: "agent_wakeup", result: text(p, "reason") ?? "woken" };
    case "agent.slept":
      return { name: "agent_sleep", result: text(p, "reason") ?? "slept" };
    case "model.route.decided":
      return { name: "model_route", result: text(p, "decidedBy") ?? "rules" };
    case "agent.escalated":
      return { name: "model_escalation", result: text(p, "reason") ?? "escalated" };
    case "claim.contended":
      return { name: "claim_contention", result: "contended" };
    case "conflict.reviewed":
      return { name: "conflict_detected", result: text(p, "verdict") ?? "reviewed" };
    case "candidate.forked":
      return { name: "candidate_created", result: text(p, "trigger") ?? "created" };
    case "verification.completed": {
      const status = text(p, "status");
      if (status === "verified") return { name: "candidate_verified", result: status };
      if (status === "rejected") return { name: "candidate_rejected", result: status };
      return null;
    }
    case "canonical.advanced":
      return { name: "promotion_success", result: "advanced" };
    case "candidate.stale":
      return { name: "promotion_stale", result: "stale" };
    case "deployment.completed":
      return { name: "release_completed", result: "deployed" };
    case "deployment.failed":
      return { name: "release_completed", result: "failed" };
    default:
      return null;
  }
}

/** The model tier a point carries: a route's selected tier, an escalation's target, a review's tier. */
const modelTierOf = (event: EventEnvelope): string =>
  text(event.payload, "selectedTier") ??
  text(event.payload, "to") ??
  text(event.payload, "tier") ??
  "";

/** One data point for a mapped Event, or null. No payload text beyond the short fields above. */
export function analyticsPoint(event: EventEnvelope): AnalyticsEngineDataPoint | null {
  const metric = metricFor(event);
  if (!metric) return null;
  return {
    indexes: [event.projectId],
    blobs: [
      metric.name,
      metric.result.slice(0, 64),
      modelTierOf(event).slice(0, 32),
      event.changeId ?? "",
      event.taskId ?? "",
      event.eventType,
      event.actor.kind,
    ],
    doubles: [1, event.canonicalGeneration],
  };
}
