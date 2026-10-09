// Wake decisions and readiness: a wrong answer wakes an unrelated agent or starts a Task too early.
import { describe, expect, it } from "vitest";
import { isWakeStillRelevant, routeEvent } from "./causal-router.ts";
import { blockedByFailure, type GraphTask, newlyReadyAfter, readyTaskIds } from "./scheduler.ts";

const t = (id: string, status: GraphTask["status"], dependsOn: string[] = []): GraphTask => ({
  id,
  status,
  dependsOn,
});

describe("scheduler", () => {
  it("never treats an unknown dependency as done", () => {
    expect(readyTaskIds([t("a", "pending", ["ghost"]), t("b", "pending")])).toEqual(["b"]);
  });

  it("waits for every branch of a diamond", () => {
    const g = [
      t("a", "completed"),
      t("b", "completed", ["a"]),
      t("c", "running", ["a"]),
      t("d", "pending", ["b", "c"]),
    ];
    expect(readyTaskIds(g)).toEqual([]);
    expect(newlyReadyAfter("c", g)).toEqual(["d"]);
  });

  it("newlyReadyAfter ignores non-dependents and stale status", () => {
    const g = [t("a", "running"), t("b", "pending", ["a"]), t("x", "pending")];
    expect(newlyReadyAfter("a", g)).toEqual(["b"]);
  });

  it("blockedByFailure walks transitive pending dependents only", () => {
    const g = [
      t("a", "failed"),
      t("b", "pending", ["a"]),
      t("c", "pending", ["b"]),
      t("d", "completed", ["a"]),
      t("e", "pending"),
    ];
    expect(blockedByFailure("a", g)).toEqual(["b", "c"]);
  });
});

const agents = [
  { agentId: "a1", taskId: "t1", resources: ["project:acme:wishlist:membership"] },
  { agentId: "a2", taskId: "t2", resources: ["project:acme:cart"] },
  { agentId: "a3", taskId: "t3", resources: ["project:acme:wishlist"] },
  { agentId: "a4", taskId: "t4", resources: ["project:acme:wish"] },
];
const route = (eventType: string, extra: object = {}) =>
  routeEvent({ eventId: "e1", eventType, ...extra }, { activeAgents: agents }, []);

describe("routeEvent", () => {
  it("does not wake an unrelated Task after an unrelated Event", () => {
    const d = route("intent.declared", { resource: "project:acme:catalog", taskId: "tx" });
    expect(d.wake).toEqual([]);
    expect(d.ambiguous).toEqual([]);
  });

  it("separates exact, segment-prefix and non-prefix matches", () => {
    const d = route("challenge.created", {
      resource: "project:acme:wishlist:membership",
      taskId: "tx",
    });
    expect(d.wake).toEqual([{ agentId: "a1", taskId: "t1", reason: "challenge" }]);
    expect(d.ambiguous.map((w) => w.agentId)).toEqual(["a3"]);
  });

  it("never wakes the agent for its own event", () => {
    const d = route("intent.changed", { resource: "project:acme:cart", taskId: "t2" });
    expect(d.wake).toEqual([]);
  });

  it("is silent for informational events and resource events without a resource", () => {
    expect(route("agent.woken", { resource: "project:acme:cart" })).toEqual({
      wake: [],
      ready: [],
      ambiguous: [],
      informational: true,
    });
    expect(route("intent.declared").wake).toEqual([]);
  });

  it("dedupes per agent and task, exact winning over prefix", () => {
    const multi = [{ agentId: "a1", taskId: "t1", resources: ["p:a", "p:a:b", "p:a:b"] }];
    const d = routeEvent(
      { eventId: "e", eventType: "claim.expired", resource: "p:a:b" },
      { activeAgents: [...multi, ...multi] },
      [],
    );
    expect(d.wake).toHaveLength(1);
    expect(d.ambiguous).toEqual([]);
  });

  it("task.completed yields ready tasks and wakes nobody; canonical.advanced wakes all", () => {
    const g = [t("t1", "running"), t("t9", "pending", ["t1"])];
    const d = routeEvent(
      { eventId: "e", eventType: "task.completed", taskId: "t1" },
      { activeAgents: agents },
      g,
    );
    expect(d.ready).toEqual(["t9"]);
    expect(d.wake).toEqual([]);
    expect(route("canonical.advanced").wake).toHaveLength(4);
  });
});

describe("isWakeStillRelevant", () => {
  it("terminates stale wakes", () => {
    expect(isWakeStillRelevant({ taskId: "t", reason: "task_ready" }, { status: "ready" })).toBe(
      true,
    );
    expect(isWakeStillRelevant({ taskId: "t", reason: "task_ready" }, { status: "running" })).toBe(
      false,
    );
    expect(isWakeStillRelevant({ taskId: "t", reason: "challenge" }, { status: "running" })).toBe(
      true,
    );
    expect(isWakeStillRelevant({ taskId: "t", reason: "challenge" }, { status: "completed" })).toBe(
      false,
    );
    expect(isWakeStillRelevant({ taskId: "t", reason: "challenge" }, null)).toBe(false);
  });
});
