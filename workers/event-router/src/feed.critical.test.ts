// Event feed projection invariants (AGENTS.md sections 17.4, 39, 42.1): a redelivered event is one
// row, `seq` only grows, retention keeps exactly the newest rows, and no payload field outside the
// allow-list is stored. Runs the real migrations and SQL against SQLite (node:sqlite).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EventEnvelope } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { claimEvents } from "./dedupe.ts";
import { feedRow, feedStatements } from "./feed.ts";

const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  const d1 = {
    prepare: (sql: string) => ({ bind: (...params: unknown[]) => ({ sql, params }) }),
    batch: async (statements: { sql: string; params: unknown[] }[]) =>
      statements.map(({ sql, params }) => ({
        meta: { changes: Number(db.prepare(sql).run(...(params as never[])).changes) },
      })),
  } as unknown as D1Database;
  return { db, d1 };
}

let counter = 0;
function event(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  counter += 1;
  return {
    eventId: `evt_${counter}`,
    eventType: "task.ready",
    eventVersion: 1,
    tenantId: "org_1",
    projectId: "proj_a",
    changeId: "chg_1",
    taskId: "tsk_1",
    actor: { kind: "system", id: "change-workflow" },
    canonicalGeneration: 0,
    correlationId: "chg_1",
    timestamp: new Date(Date.UTC(2026, 9, 9, 10, 0, counter)).toISOString(),
    payload: { agentId: "agent_1" },
    ...overrides,
  };
}

const seqs = (db: DatabaseSync) =>
  (db.prepare("SELECT seq FROM project_events ORDER BY seq").all() as { seq: number }[]).map(
    (r) => r.seq,
  );

describe("event feed projection", () => {
  it("stores a redelivered event once and keeps seq strictly increasing", async () => {
    const { db, d1 } = fakeD1();
    const a = event();
    const b = event();
    await d1.batch(feedStatements(d1, [a, b]) as never);
    await d1.batch(feedStatements(d1, [b, a]) as never);
    const c = event();
    await d1.batch(feedStatements(d1, [c, a]) as never);
    const rows = db.prepare("SELECT seq, event_id FROM project_events ORDER BY seq").all() as {
      seq: number;
      event_id: string;
    }[];
    expect(rows.map((r) => r.event_id)).toEqual([a.eventId, b.eventId, c.eventId]);
    const order = rows.map((r) => r.seq);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(new Set(order).size).toBe(order.length);
  });

  it("rides in the dedupe batch without changing which events are fresh", async () => {
    const { db, d1 } = fakeD1();
    const a = event();
    const fresh1 = await claimEvents(d1, "project-view-projector", [a.eventId], new Date(), [
      ...feedStatements(d1, [a]),
    ]);
    const fresh2 = await claimEvents(d1, "project-view-projector", [a.eventId], new Date(), [
      ...feedStatements(d1, [a]),
    ]);
    expect([...fresh1]).toEqual([a.eventId]);
    expect([...fresh2]).toEqual([]);
    expect(seqs(db)).toHaveLength(1);
  });

  it("keeps only the newest rows under the retention cap, and never reuses a seq", async () => {
    const { db, d1 } = fakeD1();
    const all: EventEnvelope[] = [];
    for (const size of [3, 4, 1, 6]) {
      const batch = Array.from({ length: size }, () => event());
      all.push(...batch);
      await d1.batch(feedStatements(d1, batch, new Date(), 5) as never);
    }
    const kept = db.prepare("SELECT seq, event_id FROM project_events ORDER BY seq").all() as {
      seq: number;
      event_id: string;
    }[];
    // MAX(seq) - 5 and below are gone: the newest 5 remain.
    expect(kept.map((r) => r.event_id)).toEqual(all.slice(-5).map((e) => e.eventId));
    // AUTOINCREMENT: a new row after deletions gets a larger seq than any row ever written.
    const last = kept.at(-1)?.seq ?? 0;
    await d1.batch(feedStatements(d1, [event()], new Date(), 5) as never);
    expect(seqs(db).at(-1)).toBe(last + 1);
  });

  it("keeps only allow-listed scalar payload fields", () => {
    const row = feedRow(
      event({
        eventType: "verification.check.completed",
        payload: {
          candidateId: "cand_1",
          checkId: "unit",
          status: "pass",
          summary: "x".repeat(500),
          token: "secret",
          metrics: { p95: 120 },
          intent: { summary: "nested" },
        },
      }),
      "2026-10-09T10:00:00.000Z",
    );
    expect(row.candidateId).toBe("cand_1");
    expect(Object.keys(row.data).sort()).toEqual(["candidateId", "checkId", "status", "summary"]);
    expect(String(row.data.summary).length).toBeLessThanOrEqual(200);
    expect(row.summary.length).toBeLessThanOrEqual(200);
  });
});
