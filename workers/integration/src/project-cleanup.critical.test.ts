// Cleanup deletes Artifacts repos, which cannot be undone. The invariant: one Project's cleanup
// only ever deletes that Project's repos, and the sweep never deletes a fork a Candidate can need.
import { describe, expect, it } from "vitest";
import { cleanupProject, isSweepable, type SweepRow } from "./project-cleanup.ts";
import { type ForkRow, forksOwnedBy } from "./repo-names.ts";

const MINE = "proj_11111111-aaaa";
const OTHER = "proj_22222222-bbbb";

describe("forksOwnedBy", () => {
  it("keeps only the Project's own forks and derives their repo names", () => {
    const rows: ForkRow[] = [
      { kind: "workspace", id: "run_t1_1", project_id: MINE },
      { kind: "candidate", id: "cand_abc123", project_id: MINE },
      { kind: "workspace", id: "run_t9_1", project_id: OTHER },
      { kind: "candidate", id: "cand_def456", project_id: OTHER },
    ];
    expect(forksOwnedBy(MINE, rows).map((f) => f.name)).toEqual(["ws-t1_1", "cand-abc123"]);
  });

  it("drops IDs that do not have the expected shape", () => {
    const rows: ForkRow[] = [
      { kind: "workspace", id: OTHER, project_id: MINE },
      { kind: "candidate", id: "run_t1_1", project_id: MINE },
      { kind: "workspace", id: "run_../x", project_id: MINE },
    ];
    expect(forksOwnedBy(MINE, rows)).toEqual([]);
  });

  it("returns nothing for an invalid Project ID", () => {
    expect(forksOwnedBy("", [{ kind: "workspace", id: "run_t1_1", project_id: "" }])).toEqual([]);
  });
});

/** Minimal D1 stand-in: answers by SQL shape. The fork queries also return another Project's rows,
 *  as a broken query would, to prove the code-level ownership check. */
function fakeEnv(project: { status: string; cleaned_at: string | null }) {
  const deleted: string[] = [];
  const marked: string[] = [];
  let cleaned = false;
  type Statement = {
    sql: string;
    bind: (...args: unknown[]) => Statement;
    first: () => Promise<unknown>;
    run: () => Promise<unknown>;
    all: () => Promise<{ results: unknown[] }>;
  };
  const statement = (sql: string, args: unknown[] = []): Statement => ({
    sql,
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => (sql.includes("FROM projects") ? project : null),
    run: async () => {
      if (sql.startsWith("UPDATE projects")) cleaned = true;
      if (sql.includes("fork_deleted_at = ?")) {
        marked.push(...(JSON.parse(String(args[1])) as string[]));
      }
      return { meta: { changes: 1 } };
    },
    all: async () => {
      if (marked.length > 0) return { results: [] };
      if (sql.includes("FROM task_runs")) {
        return {
          results: [
            { kind: "workspace", id: "run_t1_1", project_id: MINE },
            { kind: "workspace", id: "run_t9_1", project_id: OTHER },
          ],
        };
      }
      if (sql.includes("FROM candidates ca")) {
        return { results: [{ kind: "candidate", id: "cand_def456", project_id: OTHER }] };
      }
      return { results: [] };
    },
  });
  const db = {
    prepare: (sql: string) => statement(sql.trim()),
    batch: async (stmts: Statement[]) =>
      Promise.all(stmts.map((s) => (s.sql.startsWith("UPDATE") ? s.run() : s.all()))),
  };
  const env = {
    DB: db as unknown as D1Database,
    ARTIFACTS: {
      delete: async (name: string) => {
        deleted.push(name);
        return true;
      },
    } as unknown as Artifacts,
    EVIDENCE: {
      list: async () => ({ objects: [], truncated: false }),
      delete: async () => undefined,
    } as unknown as R2Bucket,
  };
  return { env, deleted, marked, isCleaned: () => cleaned };
}

describe("cleanupProject", () => {
  it("deletes only the archived Project's forks and its canonical repo", async () => {
    const fake = fakeEnv({ status: "archived", cleaned_at: null });
    const result = await cleanupProject(fake.env, MINE);
    expect(fake.deleted).toEqual(["ws-t1_1", MINE]);
    expect(fake.deleted).not.toContain(OTHER);
    expect(fake.marked).toEqual(["run_t1_1"]);
    expect(result.status).toBe("done");
    expect(fake.isCleaned()).toBe(true);
  });

  it("does nothing for an active Project", async () => {
    const fake = fakeEnv({ status: "active", cleaned_at: null });
    expect((await cleanupProject(fake.env, MINE)).status).toBe("skipped");
    expect(fake.deleted).toEqual([]);
  });

  it("does nothing once the Project is cleaned", async () => {
    const fake = fakeEnv({ status: "archived", cleaned_at: "2026-10-01T00:00:00.000Z" });
    expect((await cleanupProject(fake.env, MINE)).status).toBe("done");
    expect(fake.deleted).toEqual([]);
  });
});

describe("isSweepable", () => {
  const cutoff = "2026-10-02T00:00:00.000Z";
  const old = "2026-09-01T00:00:00.000Z";
  const run = (patch: Partial<SweepRow>): SweepRow => ({
    kind: "workspace",
    id: "run_t1_1",
    project_id: MINE,
    project_status: "active",
    finished_at: old,
    run_status: "completed",
    task_kind: "implement",
    change_status: "verifying",
    has_change_set: 1,
    ...patch,
  });
  const candidate = (status: string, patch: Partial<SweepRow> = {}): SweepRow => ({
    kind: "candidate",
    id: "cand_abc123",
    project_id: MINE,
    project_status: "active",
    finished_at: old,
    candidate_status: status,
    ...patch,
  });

  it("keeps a ChangeSet fork while its Change can still compose a Candidate", () => {
    expect(isSweepable(run({}), cutoff)).toBe(false);
    expect(isSweepable(run({ change_status: "completed" }), cutoff)).toBe(true);
  });

  it("deletes forks of failed runs and runs without a ChangeSet", () => {
    expect(isSweepable(run({ run_status: "failed" }), cutoff)).toBe(true);
    expect(isSweepable(run({ has_change_set: 0 }), cutoff)).toBe(true);
  });

  it("keeps running runs and forks inside the retention period", () => {
    expect(isSweepable(run({ run_status: "running", has_change_set: 0 }), cutoff)).toBe(false);
    expect(isSweepable(run({ run_status: "failed", finished_at: cutoff }), cutoff)).toBe(false);
    expect(isSweepable(run({ run_status: "failed", finished_at: null }), cutoff)).toBe(false);
  });

  it("deletes Candidate forks only in a final state", () => {
    for (const status of ["composing", "composed", "verifying", "verified"]) {
      expect(isSweepable(candidate(status), cutoff)).toBe(false);
    }
    for (const status of ["rejected", "stale", "promoted"]) {
      expect(isSweepable(candidate(status), cutoff)).toBe(true);
    }
  });

  it("leaves archived Projects to project.cleanup", () => {
    expect(isSweepable(candidate("rejected", { project_status: "archived" }), cutoff)).toBe(false);
  });
});
