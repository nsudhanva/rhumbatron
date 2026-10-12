// P4-11: a duplicate Event must not be applied twice.
// Runs the real dedupe SQL against SQLite (node:sqlite) behind a minimal D1 adapter.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { claimEvents, releaseEvents } from "./dedupe.ts";

function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      join(import.meta.dirname, "../../../migrations/d1/0002_processed_events.sql"),
      "utf8",
    ),
  );
  const prepare = (sql: string) => ({
    bind: (...params: unknown[]) => ({ sql, params }),
  });
  return {
    prepare,
    batch: async (statements: { sql: string; params: unknown[] }[]) =>
      statements.map(({ sql, params }) => ({
        meta: { changes: Number(db.prepare(sql).run(...(params as never[])).changes) },
      })),
  } as unknown as D1Database;
}

describe("event dedupe", () => {
  it("applies an event once and treats a redelivery as a duplicate", async () => {
    const db = fakeD1();
    const first = await claimEvents(db, "project-view-projector", ["e1", "e2"]);
    expect([...first]).toEqual(["e1", "e2"]);

    const redelivered = await claimEvents(db, "project-view-projector", ["e1", "e2"]);
    expect(redelivered.size).toBe(0);
  });

  it("dedupes per consumer group", async () => {
    const db = fakeD1();
    await claimEvents(db, "project-view-projector", ["e1"]);
    expect([...(await claimEvents(db, "causal-router", ["e1"]))]).toEqual(["e1"]);
  });

  it("lets a released (unapplied) event be applied on redelivery", async () => {
    const db = fakeD1();
    await claimEvents(db, "project-view-projector", ["e1"]);
    await releaseEvents(db, "project-view-projector", ["e1"]);
    expect([...(await claimEvents(db, "project-view-projector", ["e1"]))]).toEqual(["e1"]);
  });
});
