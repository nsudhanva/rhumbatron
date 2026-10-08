import { describe, expect, it } from "vitest";
import {
  applyDelta,
  detectGap,
  emptySnapshot,
  MAX_RECENT_EVENTS,
  ProjectViewSnapshot,
  type RecentEvent,
} from "./view-model.ts";

const base = () =>
  emptySnapshot({ projectId: "acme", name: "Acme Shop", canonicalGeneration: 1841 });

const event = (n: number): RecentEvent => ({
  eventId: `evt-${n}`,
  eventType: "task.completed",
  timestamp: new Date(Date.UTC(2026, 9, 8, 0, 0, n)).toISOString(),
  summary: `event ${n}`,
});

describe("applyDelta", () => {
  it("updates the canonical generation without touching other fields", () => {
    const next = applyDelta(base(), { canonicalGeneration: 1842 });
    expect(next.canonicalGeneration).toBe(1842);
    expect(next.project).toEqual(base().project);
  });

  it("inserts a new item and replaces an existing one by id", () => {
    const first = applyDelta(base(), {
      upsert: { activeTasks: [{ id: "t1", status: "running" }] },
    });
    const second = applyDelta(first, {
      upsert: {
        activeTasks: [
          { id: "t1", status: "done" },
          { id: "t2", status: "ready" },
        ],
      },
    });
    expect(second.activeTasks).toEqual([
      { id: "t1", status: "done" },
      { id: "t2", status: "ready" },
    ]);
  });

  it("removes items by id and ignores unknown ids", () => {
    const withTasks = applyDelta(base(), {
      upsert: {
        activeAgents: [
          { id: "a1", status: "awake" },
          { id: "a2", status: "awake" },
        ],
      },
    });
    const next = applyDelta(withTasks, { remove: { activeAgents: ["a1", "missing"] } });
    expect(next.activeAgents).toEqual([{ id: "a2", status: "awake" }]);
  });

  it("does not mutate the input snapshot", () => {
    const before = base();
    applyDelta(before, { upsert: { activeChanges: [{ id: "c1", status: "open" }] } });
    expect(before.activeChanges).toEqual([]);
  });

  it("merges a partial cost update", () => {
    const withBudget = applyDelta(base(), { costSummary: { budgetUsd: 3 } });
    const next = applyDelta(withBudget, { costSummary: { spentUsd: 1.42 } });
    expect(next.costSummary).toEqual({ spentUsd: 1.42, budgetUsd: 3 });
  });

  it("keeps at most 50 recent events, newest first", () => {
    let snapshot = base();
    for (let n = 1; n <= MAX_RECENT_EVENTS + 5; n++) {
      snapshot = applyDelta(snapshot, { appendEvent: event(n) });
    }
    expect(snapshot.recentEvents).toHaveLength(MAX_RECENT_EVENTS);
    expect(snapshot.recentEvents[0]?.eventId).toBe(`evt-${MAX_RECENT_EVENTS + 5}`);
    expect(snapshot.recentEvents.at(-1)?.eventId).toBe("evt-6");
    expect(() => ProjectViewSnapshot.parse(snapshot)).not.toThrow();
  });

  it("ignores a duplicate event id", () => {
    const once = applyDelta(base(), { appendEvent: event(1) });
    const twice = applyDelta(once, { appendEvent: event(1) });
    expect(twice.recentEvents).toHaveLength(1);
  });
});

describe("detectGap", () => {
  it("accepts the next sequence", () => expect(detectGap(10, 11)).toBe("ok"));
  it("detects a skipped sequence", () => expect(detectGap(10, 12)).toBe("gap"));
  it("detects a repeated or older sequence", () => {
    expect(detectGap(10, 10)).toBe("duplicate");
    expect(detectGap(10, 3)).toBe("duplicate");
  });
});

describe("ProjectViewSnapshot", () => {
  it("rejects invalid data", () => {
    const valid = base();
    expect(ProjectViewSnapshot.safeParse({ ...valid, canonicalGeneration: -1 }).success).toBe(
      false,
    );
    expect(ProjectViewSnapshot.safeParse({ ...valid, canonicalGeneration: 1.5 }).success).toBe(
      false,
    );
    expect(
      ProjectViewSnapshot.safeParse({ ...valid, project: { id: "", name: "x" } }).success,
    ).toBe(false);
    expect(
      ProjectViewSnapshot.safeParse({ ...valid, costSummary: { spentUsd: -1, budgetUsd: 3 } })
        .success,
    ).toBe(false);
    expect(
      ProjectViewSnapshot.safeParse({
        ...valid,
        recentEvents: Array.from({ length: MAX_RECENT_EVENTS + 1 }, (_, n) => event(n)),
      }).success,
    ).toBe(false);
    const { activeTasks: _omit, ...missing } = valid;
    expect(ProjectViewSnapshot.safeParse(missing).success).toBe(false);
  });
});
