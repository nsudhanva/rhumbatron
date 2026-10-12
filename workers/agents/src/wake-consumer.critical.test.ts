// Duplicate Queue command (P13-05). Queues deliver at least once, so a
// redelivered or concurrently delivered wake must not assign the Task twice, record its events twice,
// or start a second agent run (a second run is a second set of model calls).
import { beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  getAgentByName: vi.fn(),
  appendChangeEvents: vi.fn(async () => undefined),
}));

vi.mock("agents", () => ({ getAgentByName: spies.getAgentByName }));
vi.mock("@rhumbatron/integration/events", () => ({
  appendChangeEvents: spies.appendChangeEvents,
  changeEvent: async (_ctx: unknown, eventType: string, payload: unknown) => ({
    eventType,
    payload,
  }),
}));

const { handleWake } = await import("./wake-consumer.ts");

type Row = { status: string; assigned_agent_id: string | null };

/** D1 stand-in for the two statements the consumer runs. Reads return a copy, like D1. */
function fakeEnv(row: Row | null) {
  const metrics: unknown[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (!row) return null;
              return {
                id: "task_1",
                ...row,
                semantic_resource: "wishlist:membership",
                change_id: "chg_1",
                project_id: "proj_1",
                org_id: "org_1",
                slug: "acme-shop",
                base_generation: 1841,
              };
            },
            async run() {
              if (!sql.startsWith("UPDATE tasks") || !row) return { meta: { changes: 0 } };
              if (row.status !== "ready") return { meta: { changes: 0 } };
              row.status = "assigned";
              row.assigned_agent_id = String(args[0]);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const env = {
    DB: db,
    METRICS: { writeDataPoint: (point: unknown) => metrics.push(point) },
    RESOURCE_SHARD: {},
    AGENT: {},
  } as unknown as Env;
  return { env, metrics };
}

const wake = (agentId = "agent_7", reason = "task_ready") => ({
  commandId: "cmd_wake_task_1",
  commandType: "agent.wake",
  projectId: "proj_1",
  changeId: "chg_1",
  taskId: "task_1",
  attempt: 0,
  createdAt: "2026-10-09T00:00:00.000Z",
  payload: {
    eventId: "evt_1",
    agentId,
    reason,
    contextCursor: "0",
    priority: 5,
    budgetRemainingUsd: 0.2,
  },
});

beforeEach(() => {
  spies.start.mockClear();
  spies.appendChangeEvents.mockClear();
  spies.getAgentByName.mockReset();
  spies.getAgentByName.mockResolvedValue({ start: spies.start });
});

describe("handleWake under duplicate delivery", () => {
  it("assigns and starts the Task once; a redelivery of the same command is a no-op", async () => {
    const row: Row = { status: "ready", assigned_agent_id: null };
    const { env, metrics } = fakeEnv(row);

    expect(await handleWake(env, wake())).toBe("woken");
    expect(row).toEqual({ status: "assigned", assigned_agent_id: "agent_7" });
    expect(spies.start).toHaveBeenCalledTimes(1);
    expect(spies.appendChangeEvents).toHaveBeenCalledTimes(1);

    expect(await handleWake(env, wake())).toBe("duplicate");
    expect(spies.start).toHaveBeenCalledTimes(1);
    expect(spies.appendChangeEvents).toHaveBeenCalledTimes(1);
    // A duplicate is neither a useful nor a false wakeup.
    expect(metrics).toHaveLength(1);
  });

  it("lets only one of two concurrent deliveries win the assignment", async () => {
    const row: Row = { status: "ready", assigned_agent_id: null };
    const { env } = fakeEnv(row);

    const outcomes = await Promise.all([handleWake(env, wake()), handleWake(env, wake())]);
    expect(outcomes.sort()).toEqual(["duplicate", "woken"]);
    expect(spies.start).toHaveBeenCalledTimes(1);
    expect(spies.appendChangeEvents).toHaveBeenCalledTimes(1);
  });

  it("terminates a wake for a Task that already moved on, without starting a run", async () => {
    const { env, metrics } = fakeEnv({ status: "completed", assigned_agent_id: "agent_3" });
    expect(await handleWake(env, wake())).toBe("stale");
    expect(spies.getAgentByName).not.toHaveBeenCalled();
    expect(metrics).toEqual([
      expect.objectContaining({ blobs: ["agent_wakeup", "false", "task_ready"] }),
    ]);
  });

  it("acknowledges a malformed command instead of retrying it", async () => {
    const { env } = fakeEnv({ status: "ready", assigned_agent_id: null });
    expect(await handleWake(env, { commandId: "cmd_x" })).toBe("invalid");
    expect(await handleWake(env, wake("agent_7", "not_a_reason"))).toBe("invalid");
    expect(spies.getAgentByName).not.toHaveBeenCalled();
  });
});
