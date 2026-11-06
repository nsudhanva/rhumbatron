import { describe, expect, it } from "vitest";
import {
  APPLY_DELTA_CAP,
  MAX_CONSUMES_PER_SUBSCRIPTION,
  SUBSCRIPTIONS,
  sweepStreamIndex,
} from "./event-log.ts";

describe("sweepStreamIndex", () => {
  const minute = 60_000;

  it("rotates one stream per minute", () => {
    const base = 29_000_000 * minute;
    const seen = Array.from({ length: 8 }, (_, i) => sweepStreamIndex(base + i * minute, 8));
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("is stable within one minute and returns -1 with no streams", () => {
    expect(sweepStreamIndex(5 * minute + 1, 8)).toBe(sweepStreamIndex(5 * minute + 59_999, 8));
    expect(sweepStreamIndex(5 * minute, 8)).toBe(5);
    expect(sweepStreamIndex(123_456, 0)).toBe(-1);
  });
});

describe("sweep budget", () => {
  it("bounds the work of one sweep", () => {
    expect(SUBSCRIPTIONS.length * MAX_CONSUMES_PER_SUBSCRIPTION).toBeLessThanOrEqual(4);
    expect(APPLY_DELTA_CAP).toBeGreaterThan(0);
  });
});
