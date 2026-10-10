// Bounded K2 delivery (AGENTS.md sections 20 and 42.7). A batch that keeps failing must stop
// redelivering after MAX_BATCH_FAILURES: it is recorded once on the dead-letter path, and its events
// become duplicates so a redelivery after a lost ack is a no-op. Real migrations on node:sqlite.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EventEnvelope } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { claimEvents } from "./dedupe.ts";
import {
  batchKey,
  countBatchFailure,
  deadLetterBatch,
  deadLetterQueue,
  MAX_BATCH_FAILURES,
  shouldSkipBatch,
} from "./poison-batch.ts";

const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");
const NOW = "2026-10-09T12:00:00.000Z";

/** D1 over node:sqlite: prepare/bind and an all-or-nothing batch. */
function fakeD1() {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  const exec = (sql: string, params: unknown[]) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql)) {
      return { results: statement.all(...(params as never[])), meta: { changes: 0 } };
    }
    return {
      results: [],
      meta: { changes: Number(statement.run(...(params as never[])).changes) },
    };
  };
  const statement = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...next: unknown[]) => statement(sql, next),
  });
  const d1 = {
    prepare: (sql: string) => statement(sql),
    batch: async (list: { sql: string; params: unknown[] }[]) => {
      db.exec("BEGIN");
      try {
        const out = list.map((s) => exec(s.sql, s.params));
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, d1 };
}

const event = (eventId: string) => ({ eventId, projectId: "proj_1" }) as unknown as EventEnvelope;

describe("poison K2 batch", () => {
  it("keys a batch by its first record only, so later records joining it keep the key", async () => {
    const first = { content: '{"eventId":"e1"}' };
    const key = await batchKey([first, { content: '{"eventId":"e2"}' }]);
    expect(await batchKey([first])).toBe(key);
    expect(await batchKey([{ content: '{"eventId":"e2"}' }])).not.toBe(key);
  });

  it("skips only at the limit, then records it once and turns its events into duplicates", async () => {
    const { db, d1 } = fakeD1();
    const consumer = "causal-router";
    const events = [event("e1"), event("e2"), event("e2")];

    let failures = 0;
    for (let i = 1; i <= MAX_BATCH_FAILURES; i += 1) {
      failures = await countBatchFailure(d1, consumer, "k1", "route failed", NOW);
      expect(failures).toBe(i);
      expect(shouldSkipBatch(failures)).toBe(i === MAX_BATCH_FAILURES);
    }
    // Another consumer's failures on the same batch are counted apart.
    expect(await countBatchFailure(d1, "project-view-projector", "k1", "x", NOW)).toBe(1);

    const batch = { consumer, stream: 3, key: "k1", events, records: 3, failures, error: "boom" };
    await deadLetterBatch(d1, batch, NOW);
    await deadLetterBatch(d1, batch, NOW); // a lost ack redelivers: nothing new is written

    const rows = db.prepare("SELECT * FROM dead_letters").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      command_id: "k2:causal-router:k1",
      command_type: "k2.batch",
      queue: deadLetterQueue(consumer),
      project_id: "proj_1",
      dead_count: 1,
      attempt: MAX_BATCH_FAILURES,
      resolved_at: null,
    });
    expect(JSON.parse(String(rows[0]?.payload_json)).eventIds).toEqual(["e1", "e2"]);

    // The redelivered batch has no fresh events for this consumer, so the router acks it.
    expect(await claimEvents(d1, consumer, ["e1", "e2"])).toEqual(new Set());
    expect(await claimEvents(d1, "project-view-projector", ["e1"])).toEqual(new Set(["e1"]));
  });
});
