// Production pointer compare-and-swap (P16-11, P16-12; ADR 0020) against the real migrations and
// SQL on SQLite (node:sqlite): a pointer moves only from the row it read, a late release never
// moves it back, and a smoke failure restores the version it replaced.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { movePointer } from "./app-release.ts";

const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");
const P = "proj_1111";
const T = "2026-10-10T00:00:00.000Z";
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const C3 = "3".repeat(40);
const key = (c: string) => `apps/${P}/${c}`;

function harness() {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  db.exec(`INSERT INTO app_deployments (project_id, slug, channel, status, created_at, updated_at)
           VALUES ('${P}', 'acme', 'production', 'building', '${T}', '${T}')`);
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    run: async () => ({
      meta: { changes: Number(db.prepare(sql).run(...(params as never[])).changes) },
    }),
  });
  const env = { DB: { prepare: (sql: string) => statement(sql) } } as unknown as Env;
  const row = () =>
    db
      .prepare(
        "SELECT commit_sha, bundle_key, generation, status FROM app_deployments WHERE channel = 'production'",
      )
      .get() as Record<string, unknown>;
  return { db, env, row };
}

const to = (commit: string, generation: number) => ({
  commit,
  bundleKey: key(commit),
  generation,
});

describe("production pointer compare-and-swap", () => {
  it("moves from a row with no bundle yet, then forward, never back", async () => {
    const h = harness();
    await movePointer(h.env, P, { kind: "release", to: to(C1, 1) });
    expect(h.row()).toMatchObject({ commit_sha: C1, generation: 1, status: "ready" });
    await movePointer(h.env, P, { kind: "release", to: to(C3, 3) });
    const late = await movePointer(h.env, P, { kind: "release", to: to(C2, 2) });
    expect(late.decision).toEqual({ kind: "refuse", reason: "newer" });
    expect(h.row()).toMatchObject({ commit_sha: C3, generation: 3 });
  });

  it("restores the replaced version after a smoke failure, as a new transition", async () => {
    const h = harness();
    await movePointer(h.env, P, { kind: "release", to: to(C1, 1) });
    const moved = await movePointer(h.env, P, { kind: "release", to: to(C2, 2) });
    expect(moved.previous).toMatchObject({ commit: C1, generation: 1 });
    await movePointer(h.env, P, {
      kind: "revert",
      failed: { commit: C2, generation: 2 },
      to: to(C1, 1),
    });
    expect(h.row()).toMatchObject({ commit_sha: C1, bundle_key: key(C1), generation: 1 });
  });

  it("refuses to write when the row changed after it was read", async () => {
    const h = harness();
    await movePointer(h.env, P, { kind: "release", to: to(C1, 1) });
    // Another writer moves the row between this caller's read and its write.
    const prepare = h.env.DB.prepare.bind(h.env.DB);
    let raced = false;
    (h.env.DB as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (!raced && sql.trim().startsWith("UPDATE app_deployments")) {
        raced = true;
        h.db.exec(
          `UPDATE app_deployments SET commit_sha = '${C3}', bundle_key = '${key(C3)}', generation = 3`,
        );
      }
      return prepare(sql);
    };
    await expect(movePointer(h.env, P, { kind: "release", to: to(C2, 2) })).rejects.toThrow(
      /changed concurrently/,
    );
    expect(h.row()).toMatchObject({ commit_sha: C3, generation: 3 });
  });

  it("never serves a removed app again", async () => {
    const h = harness();
    h.db.exec("UPDATE app_deployments SET status = 'removed'");
    const outcome = await movePointer(h.env, P, { kind: "release", to: to(C1, 1) });
    expect(outcome.decision).toEqual({ kind: "refuse", reason: "removed" });
    expect(h.row()).toMatchObject({ status: "removed", commit_sha: null });
  });
});
