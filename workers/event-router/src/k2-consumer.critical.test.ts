import { describe, expect, it } from "vitest";
import {
  APPLY_DELTA_CAP,
  K2Error,
  MAX_CONSUMES_PER_SUBSCRIPTION,
  parseStreamIds,
  SUBSCRIPTIONS,
  sweepStreamIndex,
} from "./k2-consumer.ts";

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

describe("parseStreamIds", () => {
  it("parses a JSON array and treats bad config as empty", () => {
    expect(parseStreamIds('["a","b"]')).toEqual(["a", "b"]);
    expect(parseStreamIds("[]")).toEqual([]);
    expect(parseStreamIds("not json")).toEqual([]);
    expect(parseStreamIds('{"a":1}')).toEqual([]);
  });
});

describe("K2Error", () => {
  it("classifies retryable and lease-gone codes", () => {
    expect(new K2Error("x", 503, 10211).retryable).toBe(true);
    expect(new K2Error("x", 503, 10217).retryable).toBe(true);
    expect(new K2Error("x", 410, 10218).retryable).toBe(false);
    expect(new K2Error("x", 410, 10218).leaseGone).toBe(true);
    expect(new K2Error("x", 500, undefined).retryable).toBe(false);
  });
});

describe("subrequest budget", () => {
  it("keeps the worst case below the Workers Free limit of 50", () => {
    // per subscription: 1 resolve + per consume (consume + ack/nack + D1 claim + D1 release)
    const perSubscription = 1 + 4 * MAX_CONSUMES_PER_SUBSCRIPTION;
    const worst = SUBSCRIPTIONS.length * perSubscription + APPLY_DELTA_CAP;
    expect(worst).toBe(33);
    expect(worst).toBeLessThan(50);
  });
});
