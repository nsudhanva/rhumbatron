// Poison command bound: bounded retries, then the dead-letter queue. Consumers retry every failure
// (workers/agents/src/queue-poison.critical.test.ts); the consumer settings decide when a poison
// command stops and moves to the dead-letter queue. A consumer without a dead-letter queue or with
// unbounded retries would retry poison work forever.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { QUEUE_CONSUMERS } from "../../services/core/src/consumers.ts";

const root = resolve(import.meta.dirname, "../..");
const byQueue = new Map(QUEUE_CONSUMERS.map((c) => [c.queue, c]));

describe("Queue consumers send poison commands to the dead-letter queue", () => {
  for (const spec of QUEUE_CONSUMERS) {
    if (spec.queue === "dead-letter" || spec.queue === "indexing") continue;
    it(`${spec.queue} has a dead-letter queue and bounded retries`, () => {
      expect(spec.deadLetter).toBe(true);
      expect(spec.retries).toBeGreaterThanOrEqual(1);
      expect(spec.retries).toBeLessThanOrEqual(5);
    });
  }

  it("the dead-letter queue is consumed by the event router, with bounded retries and no loop", () => {
    const spec = byQueue.get("dead-letter");
    expect(spec?.service).toBe("event-router");
    expect(spec?.deadLetter).toBe(false);
    expect(spec?.retries).toBeGreaterThanOrEqual(1);
    expect(spec?.retries).toBeLessThanOrEqual(5);
  });

  it("the indexing consumer has bounded retries and the indexer records its last failure", () => {
    const spec = byQueue.get("indexing");
    expect(spec?.service).toBe("indexer");
    expect(spec?.deadLetter).toBe(false);
    const indexer = readFileSync(resolve(root, "workers/indexer/src/index.ts"), "utf8");
    expect(indexer).toMatch(new RegExp(`const MAX_RETRIES = ${spec?.retries};`));
    expect(indexer).toMatch(/recordFailure\(/);
  });
});
