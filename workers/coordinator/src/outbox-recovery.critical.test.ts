// P4-12: a K2 outage must not lose or corrupt events (AGENTS.md sections 18 and 42.6).
// Runs the real OutboxPublisher against SQLite (node:sqlite) behind a minimal SqlStorage adapter.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  type K2SendResult,
  MAX_PUBLISH_ATTEMPTS,
  migrateOutbox,
  OutboxPublisher,
} from "./outbox.ts";

function fakeSql(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  const exec = (query: string, ...params: unknown[]) => {
    if (
      params.length === 0 &&
      query
        .trim()
        .split(";")
        .filter((s) => s.trim()).length > 1
    ) {
      db.exec(query);
      return { toArray: () => [], rowsWritten: 0 };
    }
    const statement = db.prepare(query);
    if (statement.columns().length > 0) {
      const rows = statement.all(...(params as never[]));
      return { toArray: () => rows, rowsWritten: 0 };
    }
    const result = statement.run(...(params as never[]));
    return { toArray: () => [], rowsWritten: Number(result.changes) };
  };
  return { exec } as unknown as SqlStorage;
}

function insertEvent(sql: SqlStorage, eventId: string) {
  const envelope = { eventId, eventType: "project.created", projectId: "proj_1" };
  sql.exec(
    "INSERT INTO outbox (event_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)",
    eventId,
    envelope.eventType,
    JSON.stringify(envelope),
    "2026-10-08T00:00:00.000Z",
  );
}

/** A K2 producer whose availability the test controls. Every EVENTS_NN binding points at it. */
function controllableK2() {
  const sent: string[] = [];
  let up = false;
  const producer = {
    send: async (records: { headers?: Record<string, string> }[]): Promise<K2SendResult> => {
      if (!up) return { success: false, error: { message: "K2 unavailable", retryable: true } };
      sent.push(...records.map((r) => r.headers?.["event-id"] ?? ""));
      return { success: true };
    },
  };
  const env = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`EVENTS_${String(i).padStart(2, "0")}`, producer]),
  ) as unknown as Env;
  return { env, sent, recover: () => (up = true) };
}

describe("outbox under a K2 outage", () => {
  it("keeps events during the outage and publishes all of them once K2 recovers", async () => {
    const sql = fakeSql();
    migrateOutbox(sql);
    for (const id of ["e1", "e2", "e3"]) insertEvent(sql, id);
    const k2 = controllableK2();
    const outbox = new OutboxPublisher(sql, k2.env);
    const t0 = 1_000_000;

    // Outage: nothing is published, nothing is lost, and the retry is scheduled with backoff.
    expect(await outbox.publishAllDue(t0)).toBe(0);
    expect(outbox.pending().map((p) => [p.eventId, p.attempts, p.failed])).toEqual([
      ["e1", 1, false],
      ["e2", 1, false],
      ["e3", 1, false],
    ]);
    expect(outbox.nextDueAt()).toBe(t0 + 1000);

    // Not due yet: no tight retry loop.
    expect(await outbox.publishAllDue(t0 + 500)).toBe(0);

    // Recovery: every event is published exactly once, in order.
    k2.recover();
    expect(await outbox.publishAllDue(t0 + 1000)).toBe(3);
    expect(k2.sent).toEqual(["e1", "e2", "e3"]);
    expect(outbox.pending()).toEqual([]);
    expect(outbox.nextDueAt()).toBeNull();
  });

  it("stops after the attempt limit and keeps the event visible as failed", async () => {
    const sql = fakeSql();
    migrateOutbox(sql);
    insertEvent(sql, "e1");
    const outbox = new OutboxPublisher(sql, controllableK2().env);

    let now = 0;
    for (let i = 0; i < MAX_PUBLISH_ATTEMPTS; i += 1) {
      await outbox.publishAllDue(now);
      now += 10 * 60_000;
    }
    expect(outbox.pending()).toEqual([
      { eventId: "e1", eventType: "project.created", attempts: MAX_PUBLISH_ATTEMPTS, failed: true },
    ]);
    expect(outbox.nextDueAt()).toBeNull();
  });
});
