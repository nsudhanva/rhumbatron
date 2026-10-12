// Only a completed Work Graph triggers Candidate composition, and the command
// ID is stable per event, so a redelivered event cannot queue a second logical composition.
import type { EventEnvelope } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { composeCommand } from "./causal.ts";

const event = (eventType: string, payload: unknown): EventEnvelope =>
  ({
    eventId: "evt_0123456789abcdef",
    eventType,
    eventVersion: 1,
    tenantId: "org_1",
    projectId: "proj_1",
    changeId: "chg_1",
    actor: { kind: "agent", id: "agt_1" },
    canonicalGeneration: 3,
    correlationId: "chg_1",
    timestamp: "2026-10-09T00:00:00.000Z",
    payload,
  }) as EventEnvelope;

describe("composeCommand", () => {
  it("queues candidate.create with a stable ID after the Work Graph completed", () => {
    const a = composeCommand(event("verification.started", { reason: "work_graph_completed" }));
    const b = composeCommand(event("verification.started", { reason: "work_graph_completed" }));
    expect(a?.commandType).toBe("candidate.create");
    expect(a?.changeId).toBe("chg_1");
    expect(a?.commandId).toBe(b?.commandId);
  });

  it("ignores other verification starts and other events", () => {
    expect(composeCommand(event("verification.started", { reason: "manual" }))).toBeNull();
    expect(composeCommand(event("task.completed", { reason: "work_graph_completed" }))).toBeNull();
  });
});
