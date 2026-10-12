import type { EventEnvelope } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { analyticsPoint, metricFor } from "./analytics.ts";

const event = (eventType: string, payload: unknown = {}): EventEnvelope =>
  ({
    eventId: `evt_${eventType}`,
    eventType,
    eventVersion: 1,
    tenantId: "org_1",
    projectId: "proj_1",
    changeId: "chg_1",
    taskId: "task_1",
    actor: { kind: "agent", id: "agent_1" },
    canonicalGeneration: 1841,
    correlationId: "corr_1",
    timestamp: "2026-10-09T10:00:00.000Z",
    payload,
  }) as EventEnvelope;

describe("analytics projector mapping", () => {
  it("maps lifecycle Events to Analytics Engine metric names", () => {
    expect(metricFor(event("change.created"))?.name).toBe("change_created");
    expect(metricFor(event("task.failed", { kind: "dead_letter" }))).toEqual({
      name: "task_failed",
      result: "dead_letter",
    });
    expect(metricFor(event("canonical.advanced"))?.name).toBe("promotion_success");
    expect(metricFor(event("deployment.failed"))).toEqual({
      name: "release_completed",
      result: "failed",
    });
    expect(metricFor(event("verification.completed", { status: "verified" }))?.name).toBe(
      "candidate_verified",
    );
    expect(metricFor(event("verification.completed", { status: "rejected" }))?.name).toBe(
      "candidate_rejected",
    );
  });

  it("writes nothing for an unmeasured Event or an unknown verification status", () => {
    expect(analyticsPoint(event("intent.declared"))).toBeNull();
    expect(analyticsPoint(event("verification.completed", { status: "stale" }))).toBeNull();
  });

  it("keeps free text out of the point: a task.failed reason is not a blob", () => {
    const point = analyticsPoint(event("task.failed", { reason: "secret-ish long sentence" }));
    expect(point?.blobs).not.toContain("secret-ish long sentence");
    expect(point?.blobs?.[1]).toBe("failed");
  });

  it("indexes by Project and carries the model tier of a route", () => {
    expect(analyticsPoint(event("model.route.decided", { selectedTier: "sonnet" }))).toEqual({
      indexes: ["proj_1"],
      blobs: ["model_route", "rules", "sonnet", "chg_1", "task_1", "model.route.decided", "agent"],
      doubles: [1, 1841],
    });
  });
});
