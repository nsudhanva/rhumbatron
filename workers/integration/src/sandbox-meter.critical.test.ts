// Real SQLite migrations: overlapping uses of one container are charged once, idle tails merge.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  awakeCharge,
  refundSandboxSeconds,
  reserveSandboxSeconds,
  settleSandboxUse,
} from "./sandbox-meter.ts";

const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");
const S = 1000;
const T0 = Date.parse("2026-10-13T10:00:00Z");

function harness() {
  const sqlite = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...(params as never[])) ?? null,
    run: async () => ({
      meta: { changes: Number(sqlite.prepare(sql).run(...(params as never[])).changes) },
    }),
  });
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (list: ReturnType<typeof statement>[]) => {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of list) out.push(await s.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  const meter = () =>
    (
      sqlite.prepare("SELECT count FROM usage_counters WHERE counter = 'sandbox-seconds'").get() as
        | { count: number }
        | undefined
    )?.count ?? 0;
  return { db, meter };
}

describe("Sandbox meter", () => {
  it("adds only the time a use adds to the awake block", () => {
    const first = awakeCharge(null, { startedAt: 0, endedAt: 60 * S });
    expect(first).toEqual({ seconds: 180, block: { from: 0, until: 180 * S } });
    // Overlaps the block: only the part past its end counts.
    expect(awakeCharge(first.block, { startedAt: 30 * S, endedAt: 100 * S }).seconds).toBe(40);
    // Started before the block: the earlier part counts too.
    expect(awakeCharge(first.block, { startedAt: -20 * S, endedAt: 10 * S }).seconds).toBe(20);
    // After the block ended (the container slept): a new block.
    expect(awakeCharge(first.block, { startedAt: 500 * S, endedAt: 510 * S })).toEqual({
      seconds: 130,
      block: { from: 500 * S, until: 630 * S },
    });
  });

  it("charges four parallel agents of one container once, and refunds every reservation", async () => {
    const h = harness();
    const project = "proj_aaaaaaaa-0000-0000-0000-000000000000";
    for (let i = 0; i < 4; i++) expect(await reserveSandboxSeconds(h.db, 300, "72000")).toBe(true);
    expect(h.meter()).toBe(1200);
    // Four sessions of 5 minutes, all inside the same 6 minutes.
    for (let i = 0; i < 4; i++)
      await settleSandboxUse(h.db, {
        projectId: project,
        startedAt: T0 + i * 20 * S,
        endedAt: T0 + (300 + i * 20) * S,
        reservedSeconds: 300,
      });
    // Union: 0 .. 360 s, plus one 120 s tail.
    expect(h.meter()).toBe(480);
    // Another Project's container is separate.
    await reserveSandboxSeconds(h.db, 300, "72000");
    await settleSandboxUse(h.db, {
      projectId: "proj_bbbbbbbb-0000-0000-0000-000000000000",
      startedAt: T0,
      endedAt: T0 + 60 * S,
      reservedSeconds: 300,
    });
    expect(h.meter()).toBe(480 + 180);
    await reserveSandboxSeconds(h.db, 300, "72000");
    await refundSandboxSeconds(h.db, 300);
    expect(h.meter()).toBe(660);
  });

  it("refuses a reservation past the monthly cap", async () => {
    const h = harness();
    expect(await reserveSandboxSeconds(h.db, 500, "600")).toBe(true);
    expect(await reserveSandboxSeconds(h.db, 200, "600")).toBe(false);
    expect(h.meter()).toBe(500);
  });
});
