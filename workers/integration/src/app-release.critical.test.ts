// Production pointer compare-and-swap (ADR 0020) against the real migrations and
// SQL on SQLite (node:sqlite): a pointer moves only from the row it read, a late release never
// moves it back, and a smoke failure restores the version it replaced. A removed app keeps a
// tombstone row, so its hosts answer 410 after cleanup.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { movePointer, removeApp } from "./app-release.ts";

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
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
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

describe("app removal", () => {
  it("deletes data, bundles, and preview rows but keeps a tombstone that answers 410", async () => {
    const h = harness();
    await movePointer(h.env, P, { kind: "release", to: to(C1, 1) });
    h.db.exec(`INSERT INTO app_deployments (project_id, slug, channel, commit_sha, bundle_key,
               status, created_at, updated_at)
               VALUES ('${P}', 'acme', 'preview:v0000001', '${C1}', '${key(C1)}', 'ready', '${T}', '${T}')`);
    const objects = new Set([`${key(C1)}/bundle.json`, `app-previews/${P}/x/bundle.json`]);
    const wiped: string[] = [];
    const env = {
      ...h.env,
      APPS: {
        wipeData: async (names: string[]) => {
          wiped.push(...names);
          return { wiped: names.length };
        },
      },
      EVIDENCE: {
        list: async ({ prefix }: { prefix: string }) => ({
          objects: [...objects].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k })),
          truncated: false,
        }),
        delete: async (keys: string[]) => {
          for (const k of keys) objects.delete(k);
        },
      },
    } as unknown as Env;

    expect((await removeApp(env, P)).status).toBe("done");
    expect(objects.size).toBe(0);
    expect(wiped).toEqual([`${P}#preview:v0000001`, P]);
    const rows = h.db.prepare("SELECT channel, status FROM app_deployments").all();
    expect(rows).toEqual([{ channel: "production", status: "removed" }]);
    expect(h.row()).toMatchObject({ status: "removed", commit_sha: null, bundle_key: null });

    // A repeated delivery finds only the tombstone: done, nothing wiped again.
    expect((await removeApp(env, P)).status).toBe("done");
    expect(wiped).toHaveLength(2);
  });
});
