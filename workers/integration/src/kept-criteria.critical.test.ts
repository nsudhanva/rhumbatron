// Real SQLite migrations: only requests that went live after this one was created are kept.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isQualityGate, keptCriteria, loadKeptCriteria } from "./kept-criteria.ts";

const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");

function db() {
  const sqlite = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  sqlite.exec(`INSERT INTO projects (id, org_id, name, slug, status, canonical_generation, created_at, updated_at)
    VALUES ('proj_k', 'org', 'K', 'k', 'active', 2, '2026-10-13T00:00:00Z', '2026-10-13T00:00:00Z')`);
  const change = (id: string, createdAt: string, criteria: string[]) =>
    sqlite
      .prepare(`INSERT INTO changes (id, project_id, goal, status, base_generation, budget_usd, created_by,
        created_at, updated_at, acceptance_criteria_json) VALUES (?, 'proj_k', 'g', 'running', 0, 3, 'u', ?, ?, ?)`)
      .run(id, createdAt, createdAt, JSON.stringify(criteria));
  const promoted = (changeId: string, at: string) =>
    sqlite
      .prepare(`INSERT INTO candidates (id, change_id, base_generation, status, created_at, updated_at)
        VALUES (?, ?, 0, 'promoted', ?, ?)`)
      .run(`cand_${changeId}`, changeId, at, at);
  const d1 = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        all: async () => ({ results: sqlite.prepare(sql).all(...(params as never[])) }),
      }),
    }),
  } as unknown as D1Database;
  const conflict = (a: string, b: string) =>
    sqlite
      .prepare(`INSERT INTO request_conflicts (id, project_id, change_a, change_b, verdict, policy, created_at)
        VALUES (?, 'proj_k', ?, ?, 'conflicting', 'first_come', '2026-10-13T10:00:00Z')`)
      .run(`rc_${a}_${b}`, a, b);
  return { change, promoted, conflict, d1 };
}

describe("criteria kept from requests that went live meanwhile", () => {
  it("keeps the live request's criteria, not older ones, quality gates, or the request's own", async () => {
    const h = db();
    h.change("chg_old", "2026-10-13T08:00:00Z", ["An old feature works"]);
    h.promoted("chg_old", "2026-10-13T09:00:00Z");
    h.change("chg_me", "2026-10-13T10:00:00Z", [
      "A 64x64 canvas",
      "typecheck, test and contract pass",
    ]);
    h.change("chg_live", "2026-10-13T10:01:00Z", [
      "A toggle switches between the 8-bit and 16-bit palettes",
      "A 64x64 canvas",
      "typecheck, test and contract pass",
    ]);
    h.promoted("chg_live", "2026-10-13T10:05:00Z");
    expect(await loadKeptCriteria(h.d1, "chg_me")).toEqual([
      "A toggle switches between the 8-bit and 16-bit palettes",
    ]);
    expect(await loadKeptCriteria(h.d1, "chg_live")).toEqual([]);
  });

  it("does not keep a live request that this one conflicts with and replaces", async () => {
    const h = db();
    h.change("chg_me", "2026-10-13T10:00:00Z", [
      "A law passes with a simple majority and a quorum",
    ]);
    h.change("chg_two", "2026-10-13T09:59:00Z", [
      "A law passes only with two thirds of the votes cast",
    ]);
    h.promoted("chg_two", "2026-10-13T10:05:00Z");
    h.conflict("chg_me", "chg_two");
    expect(await loadKeptCriteria(h.d1, "chg_me")).toEqual([]);
  });

  it("recognizes a quality-gate-only criterion and caps the list", () => {
    expect(isQualityGate("typecheck, test and contract all pass")).toBe(true);
    expect(isQualityGate("Existing tests are updated and typecheck, test and contract pass")).toBe(
      true,
    );
    expect(isQualityGate("All existing API routes and tests continue to pass")).toBe(true);
    expect(isQualityGate("typecheck, test and contract pass")).toBe(true);
    expect(isQualityGate("A test page lists the posts")).toBe(false);
    expect(isQualityGate("Votes on a closed law do not pass")).toBe(false);
    expect(isQualityGate("The checkout API routes work for guests")).toBe(false);
    const many = Array.from({ length: 20 }, (_, i) => `Feature ${i} works`);
    expect(keptCriteria([many], [])).toHaveLength(12);
  });
});
