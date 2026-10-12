import type { EventEnvelope } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { decodeEnvelope, groupByProject, planProjects, toViewDelta } from "./projector.ts";

const event = (over: Partial<EventEnvelope> & { eventId: string }): EventEnvelope => ({
  eventType: "claim.acquired",
  eventVersion: 1,
  tenantId: "org_1",
  projectId: "proj_a",
  actor: { kind: "agent", id: "agent_1" },
  canonicalGeneration: 1841,
  correlationId: "corr_1",
  timestamp: "2026-10-08T00:00:00.000Z",
  payload: {},
  ...over,
});

const encode = (value: unknown) => btoa(JSON.stringify(value));

describe("decodeEnvelope", () => {
  it("decodes a valid base64 envelope", () => {
    const e = event({ eventId: "e1" });
    expect(decodeEnvelope(encode(e))?.eventId).toBe("e1");
  });

  it("returns null for invalid base64, invalid JSON, and invalid envelopes", () => {
    expect(decodeEnvelope("***not-base64***")).toBeNull();
    expect(decodeEnvelope(btoa("{nope"))).toBeNull();
    expect(decodeEnvelope(encode({ eventId: "e1", eventType: "made.up" }))).toBeNull();
  });
});

describe("groupByProject", () => {
  it("groups by project and keeps arrival order", () => {
    const groups = groupByProject([
      event({ eventId: "1", projectId: "proj_a" }),
      event({ eventId: "2", projectId: "proj_b" }),
      event({ eventId: "3", projectId: "proj_a" }),
    ]);
    expect(groups.map(([id, evs]) => [id, evs.map((e) => e.eventId)])).toEqual([
      ["proj_a", ["1", "3"]],
      ["proj_b", ["2"]],
    ]);
  });
});

describe("toViewDelta", () => {
  it("appends the event with a payload-free summary and no generation change", () => {
    const delta = toViewDelta([
      event({ eventId: "e1", resource: "project:acme:cart", payload: { secret: "x" } }),
    ]);
    expect(delta.canonicalGeneration).toBeUndefined();
    expect(delta.appendEvent).toEqual({
      eventId: "e1",
      eventType: "claim.acquired",
      timestamp: "2026-10-08T00:00:00.000Z",
      summary: "claim.acquired on project:acme:cart by agent:agent_1",
    });
  });

  it("sets canonicalGeneration from canonical.advanced and prefers that event", () => {
    const delta = toViewDelta([
      event({
        eventId: "adv",
        eventType: "canonical.advanced",
        timestamp: "2026-10-08T00:00:01.000Z",
        payload: { fromGeneration: 1841, toGeneration: 1842 },
      }),
      event({ eventId: "later", timestamp: "2026-10-08T00:00:05.000Z" }),
    ]);
    expect(delta.canonicalGeneration).toBe(1842);
    expect(delta.appendEvent?.eventId).toBe("adv");
    expect(delta.appendEvent?.summary).toContain("(+1 more)");
  });

  it("uses the highest generation when delivery is out of order", () => {
    const adv = (id: string, to: number, ts: string) =>
      event({
        eventId: id,
        eventType: "canonical.advanced",
        timestamp: ts,
        payload: { toGeneration: to },
      });
    const delta = toViewDelta([
      adv("b", 1843, "2026-10-08T00:00:02.000Z"),
      adv("a", 1842, "2026-10-08T00:00:01.000Z"),
    ]);
    expect(delta.canonicalGeneration).toBe(1843);
  });

  it("ignores a malformed canonical.advanced payload and normalizes offset timestamps", () => {
    const delta = toViewDelta([
      event({
        eventId: "e1",
        eventType: "canonical.advanced",
        timestamp: "2026-10-08T05:30:00+05:30",
        payload: { toGeneration: "1842" },
      }),
    ]);
    expect(delta.canonicalGeneration).toBeUndefined();
    expect(delta.appendEvent?.timestamp).toBe("2026-10-08T00:00:00.000Z");
  });
});

describe("toViewDelta lifecycle", () => {
  const at = (s: number) => `2026-10-08T00:00:0${s}.000Z`;

  it("keeps the newest status per Task, removes completed Tasks, and sleeps their Agents", () => {
    const delta = toViewDelta([
      // Arrival order differs from time order: the newest event per Task must win.
      event({
        eventId: "s1",
        eventType: "task.started",
        taskId: "t1",
        changeId: "c1",
        timestamp: at(3),
      }),
      event({
        eventId: "a1",
        eventType: "task.assigned",
        taskId: "t1",
        changeId: "c1",
        timestamp: at(2),
      }),
      event({
        eventId: "r2",
        eventType: "task.ready",
        taskId: "t2",
        changeId: "c1",
        timestamp: at(1),
        actor: { kind: "system", id: "wf" },
      }),
      event({
        eventId: "d2",
        eventType: "task.completed",
        taskId: "t2",
        changeId: "c1",
        timestamp: at(4),
        actor: { kind: "agent", id: "agent_2" },
      }),
      event({
        eventId: "v1",
        eventType: "verification.started",
        changeId: "c1",
        timestamp: at(5),
        actor: { kind: "system", id: "wf" },
      }),
    ]);
    expect(delta.upsert?.activeTasks).toEqual([{ id: "t1", status: "running", changeId: "c1" }]);
    expect(delta.remove?.activeTasks).toEqual(["t2"]);
    expect(delta.upsert?.activeAgents).toEqual([
      { id: "agent_1", status: "working", changeId: "c1" },
    ]);
    expect(delta.remove?.activeAgents).toEqual(["agent_2"]);
    expect(delta.upsert?.activeChanges).toEqual([{ id: "c1", status: "verifying" }]);
  });

  it("moves a promoted Change to releasing and drops it when it completes or fails", () => {
    const system = { kind: "system", id: "release" } as const;
    const delta = toViewDelta([
      event({
        eventId: "p1",
        eventType: "canonical.promotion.requested",
        changeId: "c1",
        timestamp: at(1),
        actor: system,
      }),
      event({
        eventId: "b1",
        eventType: "build.started",
        changeId: "c1",
        timestamp: at(2),
        actor: system,
      }),
      event({
        eventId: "p2",
        eventType: "canonical.promotion.requested",
        changeId: "c2",
        timestamp: at(1),
        actor: system,
      }),
      event({
        eventId: "d2",
        eventType: "change.completed",
        changeId: "c2",
        timestamp: at(3),
        actor: system,
      }),
      event({
        eventId: "f3",
        eventType: "change.failed",
        changeId: "c3",
        timestamp: at(4),
        actor: system,
      }),
    ]);
    expect(delta.upsert?.activeChanges).toEqual([{ id: "c1", status: "releasing" }]);
    expect(delta.remove?.activeChanges).toEqual(["c2", "c3"]);
  });

  it("adds no list updates for events outside the lifecycle", () => {
    const delta = toViewDelta([event({ eventId: "e1", changeId: "c1", taskId: "t1" })]);
    expect(delta.upsert).toBeUndefined();
    expect(delta.remove).toBeUndefined();
  });
});

describe("planProjects (subrequest budget cap)", () => {
  const groups = Array.from({ length: 20 }, (_, i) => i);

  it("selects at most the remaining budget and defers the rest", () => {
    const { selected, deferred } = planProjects(groups, 15);
    expect(selected).toHaveLength(15);
    expect(deferred).toEqual([15, 16, 17, 18, 19]);
  });

  it("defers everything when the budget is exhausted and never goes negative", () => {
    expect(planProjects(groups, 0).selected).toEqual([]);
    expect(planProjects(groups, -3).selected).toEqual([]);
    expect(planProjects([1, 2], 15).deferred).toEqual([]);
  });
});
