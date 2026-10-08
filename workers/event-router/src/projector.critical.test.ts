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
