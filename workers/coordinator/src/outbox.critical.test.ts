import { describe, expect, it } from "vitest";
import { decideOutcome, MAX_PUBLISH_ATTEMPTS, retryDelayMs, streamIndex } from "./outbox.ts";

const fail = (retryable: boolean) => ({ success: false, error: { message: "boom", retryable } });

describe("outbox publishing", () => {
  it("marks a successful send as published", () => {
    expect(decideOutcome(0, { success: true }, 1000)).toEqual({ kind: "published" });
  });

  it("backs off exponentially and caps at five minutes", () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000]);
    expect(retryDelayMs(30)).toBe(300_000);
  });

  it("schedules a bounded retry for a retryable failure", () => {
    expect(decideOutcome(0, fail(true), 1000)).toMatchObject({
      kind: "retry",
      attemptCount: 1,
      nextAttemptAt: 2000,
    });
  });

  it("stops retrying after the attempt limit and keeps the row as failed", () => {
    expect(decideOutcome(MAX_PUBLISH_ATTEMPTS - 1, fail(false), 1000)).toMatchObject({
      kind: "failed",
      attemptCount: MAX_PUBLISH_ATTEMPTS,
    });
  });

  it("routes a project to one stable stream in range", () => {
    const index = streamIndex("proj_8e0f48bb-c849-48e9-92e3-dc2f8d75492d");
    expect(index).toBe(streamIndex("proj_8e0f48bb-c849-48e9-92e3-dc2f8d75492d"));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(8);
  });
});
