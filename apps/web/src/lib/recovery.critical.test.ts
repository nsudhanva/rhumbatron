import { describe, expect, it } from "vitest";
import { failureOutcome, recoveredTaskFailures } from "./recovery";

const run = (attempt: number, status: "running" | "completed" | "failed") => ({ attempt, status });

describe("failureOutcome", () => {
  const first = run(1, "failed");

  it("reads a failure a later attempt completed as recovered", () => {
    expect(failureOutcome(first, [first, run(2, "completed")], "completed")).toBe("recovered");
    // Every earlier failure is recovered, and the Task status is not needed.
    const second = run(2, "failed");
    const twice = [first, second, run(3, "completed")];
    expect(failureOutcome(first, twice)).toBe("recovered");
    expect(failureOutcome(second, twice)).toBe("recovered");
  });

  it("reads a failure with a later running attempt, or a re-queued Task, as retrying", () => {
    expect(failureOutcome(first, [first, run(2, "running")], "running")).toBe("retrying");
    // dependency_merge_conflict, then the rebase resets the Task to pending before it re-runs.
    expect(failureOutcome(first, [first], "pending")).toBe("retrying");
  });

  it("keeps a failure that nothing recovered as failed", () => {
    expect(failureOutcome(first, [first], "failed")).toBe("failed");
    expect(failureOutcome(first, [first])).toBe("failed");
    // A later failed attempt does not recover an earlier one.
    const both = [first, run(2, "failed")];
    expect(failureOutcome(first, both, "failed")).toBe("failed");
    expect(failureOutcome(first, both, "blocked")).toBe("failed");
  });

  it("never reads an earlier completed attempt as a recovery", () => {
    const last = run(2, "failed");
    expect(failureOutcome(last, [run(1, "completed"), last], "failed")).toBe("failed");
  });
});

describe("recoveredTaskFailures", () => {
  const ev = (seq: number, eventType: string, taskId: string | null) => ({
    eventId: `e${seq}`,
    eventType,
    taskId,
    seq,
    occurredAt: new Date(Date.UTC(2026, 9, 11, 12, 0, seq)).toISOString(),
  });

  it("marks task.failed that a later task.completed of the same Task follows, in any order", () => {
    const events = [
      ev(4, "task.completed", "t1"),
      ev(3, "task.started", "t1"),
      ev(2, "task.failed", "t1"),
      ev(1, "task.failed", "t2"),
    ];
    expect([...recoveredTaskFailures(events)]).toEqual(["e2"]);
    expect([...recoveredTaskFailures([...events].reverse())]).toEqual(["e2"]);
  });

  it("does not mark a failure after the last completion, or one of another Task", () => {
    const events = [
      ev(1, "task.completed", "t1"),
      ev(2, "task.failed", "t1"),
      ev(3, "task.completed", "t2"),
    ];
    expect(recoveredTaskFailures(events).size).toBe(0);
  });

  it("orders by time when a fact has no sequence number", () => {
    const { seq: _a, ...failed } = ev(1, "task.failed", "t1");
    const { seq: _b, ...done } = ev(2, "task.completed", "t1");
    expect([...recoveredTaskFailures([done, failed])]).toEqual(["e1"]);
  });
});
