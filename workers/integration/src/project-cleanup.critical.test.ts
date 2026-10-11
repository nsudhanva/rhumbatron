// Cleanup deletes Artifacts repos, which cannot be undone. The invariant: one Project's cleanup
// only ever deletes that Project's repos, and the sweep never deletes a fork a Candidate can need.
import { describe, expect, it } from "vitest";
import {
  CONTENT_TABLES,
  cleanupProject,
  isSweepable,
  projectPrefixes,
  type SweepRow,
} from "./project-cleanup.ts";
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

type FakeOptions = {
  project: { status: string; cleaned_at: string | null };
  /** Rows per D1 table for the Project, to prove bounded delete loops. */
  rows?: Record<string, number>;
  /** Objects in the EVIDENCE bucket. */
  objects?: string[];
  apps?: boolean;
};

/** Minimal D1, R2, and Durable Object stand-ins: D1 answers by SQL shape. The fork queries also
 *  return another Project's rows, as a broken query would, to prove the code-level ownership check. */
function fakeEnv(options: FakeOptions) {
  const { project } = options;
  const deleted: string[] = [];
  const marked: string[] = [];
  const executed: string[] = [];
  const purged: string[] = [];
  const rows = { ...(options.rows ?? {}) };
  const objects = new Set(options.objects ?? []);
  let tasksLeft = true;
  let scrubbed: unknown[] | null = null;
  type Statement = {
    sql: string;
    bind: (...args: unknown[]) => Statement;
    first: () => Promise<unknown>;
    run: () => Promise<unknown>;
    all: () => Promise<{ results: unknown[] }>;
  };
  const isWrite = (sql: string) => sql.startsWith("UPDATE") || sql.startsWith("DELETE");
  const statement = (sql: string, args: unknown[] = []): Statement => ({
    sql,
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => (sql.includes("FROM projects") ? project : null),
    run: async () => {
      executed.push(sql);
      if (sql.startsWith("UPDATE projects")) scrubbed = args;
      if (sql.includes("fork_deleted_at = ?")) {
        marked.push(...(JSON.parse(String(args[1])) as string[]));
      }
      if (sql.startsWith("DELETE FROM tasks")) tasksLeft = false;
      const table = /^DELETE FROM (\w+) WHERE rowid/.exec(sql)?.[1];
      if (table) {
        const n = Math.min(rows[table] ?? 0, Number(args[1]));
        rows[table] = (rows[table] ?? 0) - n;
        return { meta: { changes: n } };
      }
      return { meta: { changes: 1 } };
    },
    all: async () => {
      if (sql.includes("FROM task_runs r")) {
        if (marked.length > 0) return { results: [] };
        return {
          results: [
            { kind: "workspace", id: "run_t1_1", project_id: MINE },
            { kind: "workspace", id: "run_t9_1", project_id: OTHER },
          ],
        };
      }
      if (sql.includes("FROM candidates ca")) {
        if (marked.length > 0) return { results: [] };
        return { results: [{ kind: "candidate", id: "cand_def456", project_id: OTHER }] };
      }
      if (sql.includes("FROM tasks WHERE change_id")) {
        return { results: tasksLeft ? [{ id: "tsk_t1", assigned_agent_id: "agt_t1" }] : [] };
      }
      if (sql.includes("SELECT DISTINCT agent_id")) {
        return { results: [{ agent_id: "agt_t1" }, { agent_id: "human:someone" }] };
      }
      return { results: [] };
    },
  });
  const db = {
    prepare: (sql: string) => statement(sql.trim()),
    batch: async (stmts: Statement[]) =>
      Promise.all(stmts.map((x) => (isWrite(x.sql) ? x.run() : x.all()))),
  };
  const namespace = (binding: string) =>
    ({
      idFromName: (name: string) => name,
      get: (name: string) => ({
        purge: async (projectId: string) => {
          purged.push(`${binding}:${name}:${projectId}`);
          return { purged: true };
        },
      }),
    }) as unknown as DurableObjectNamespace;
  const env = {
    DB: db as unknown as D1Database,
    ARTIFACTS: {
      delete: async (name: string) => {
        deleted.push(name);
        return true;
      },
    } as unknown as Artifacts,
    EVIDENCE: {
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [...objects].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      }),
      delete: async (keys: string[]) => {
        for (const key of keys) objects.delete(key);
      },
    } as unknown as R2Bucket,
    PROJECT_ROOT: namespace("root"),
    PROJECT_VIEW: namespace("view"),
    RESOURCE_SHARD: namespace("shard"),
    AGENT: namespace("agent"),
    ...(options.apps ? { APPS: {} } : {}),
  };
  return { env, deleted, marked, executed, purged, objects, rows, scrubbed: () => scrubbed };
}

const archived = { status: "archived", cleaned_at: null };

describe("cleanupProject", () => {
  it("deletes only the archived Project's forks and its canonical repo", async () => {
    const fake = fakeEnv({ project: archived });
    const result = await cleanupProject(fake.env, MINE);
    expect(fake.deleted).toEqual(["ws-t1_1", MINE]);
    expect(fake.deleted).not.toContain(OTHER);
    expect(fake.marked).toEqual(["run_t1_1"]);
    expect(result.status).toBe("done");
    expect(fake.scrubbed()).not.toBeNull();
  });

  it("deletes every per-Project R2 prefix and leaves shared and foreign objects", async () => {
    const mine = projectPrefixes(MINE).map((prefix) => `${prefix}x/object.json`);
    const keep = [
      `evidence/${OTHER}/chg/cand/check/report.json`,
      `source/${OTHER}/blobs/aa`,
      "events/2026/10/09/stream-03/part-1.ndjson.gz",
      `index/${MINE}/vectors.json`,
    ];
    const fake = fakeEnv({ project: archived, objects: [...mine, ...keep] });
    await cleanupProject(fake.env, MINE);
    expect([...fake.objects].sort()).toEqual([...keep].sort());
    for (const prefix of ["evidence/", "work-graphs/", "workspace/"]) {
      expect(projectPrefixes(MINE)).toContain(`${prefix}${MINE}/`);
    }
  });

  it("purges the root, the view, all 32 shards and the agents of the Project's Tasks", async () => {
    const fake = fakeEnv({ project: archived });
    await cleanupProject(fake.env, MINE);
    expect(fake.purged).toContain(`root:${MINE}:${MINE}`);
    expect(fake.purged).toContain(`view:${MINE}:${MINE}`);
    expect(fake.purged.filter((p) => p.startsWith("shard:"))).toHaveLength(32);
    expect(fake.purged).toContain(`shard:${MINE}:shard-31:${MINE}`);
    // Only DO-shaped agent names: a human actor ID never reaches the AgentDO namespace.
    expect(fake.purged.filter((p) => p.startsWith("agent:"))).toEqual([`agent:agt_t1:${MINE}`]);
  });

  it("deletes the D1 content rows in bounded batches and never touches the spend meter", async () => {
    const fake = fakeEnv({
      project: archived,
      rows: { project_events: 1200, changes: 3, project_invitations: 2 },
    });
    const result = await cleanupProject(fake.env, MINE);
    expect(result.status).toBe("done");
    expect(fake.rows.project_events).toBe(0);
    const deletes = fake.executed.filter((sql) => sql.startsWith("DELETE FROM project_events"));
    expect(deletes).toHaveLength(3);
    for (const { table } of CONTENT_TABLES) {
      expect(fake.executed.some((sql) => sql.startsWith(`DELETE FROM ${table} `))).toBe(true);
    }
    for (const table of ["task_runs", "decision_receipts", "task_dependencies", "tasks"]) {
      expect(fake.executed.some((sql) => sql.startsWith(`DELETE FROM ${table} `))).toBe(true);
    }
    // ADR 0021: the monthly Anthropic budget sums usage_counters, a global table.
    expect(fake.executed.filter((sql) => sql.includes("usage_counters"))).toEqual([]);
    expect(CONTENT_TABLES.map((t) => t.table)).not.toContain("usage_counters");
    // The app host answer (410) needs its tombstone: app rows are never bulk-deleted by Project.
    expect(CONTENT_TABLES.map((t) => t.table)).not.toContain("app_deployments");
    expect(String(fake.scrubbed()?.[0])).toBeTruthy();
  });

  it("deletes children before the rows they reference", () => {
    const order = CONTENT_TABLES.map((t) => t.table);
    const precedes = (child: string, parent: string) =>
      expect(order.indexOf(child)).toBeLessThan(order.indexOf(parent));
    precedes("evidence_index", "candidates");
    precedes("approvals", "candidates");
    precedes("candidates", "changes");
    precedes("changesets", "changes");
    precedes("conflicts", "changes");
  });

  it("waits for the apps Worker to wipe app data stores when it is bound", async () => {
    const fake = fakeEnv({ project: archived, apps: true });
    const original = fake.env.DB.prepare.bind(fake.env.DB);
    fake.env.DB.prepare = ((sql: string) => {
      const base = original(sql);
      if (!sql.includes("FROM app_deployments")) return base;
      return {
        ...base,
        bind: () => ({
          all: async () => ({
            results: [
              { channel: "production", status: "removed", commit_sha: "a1", bundle_key: "k" },
            ],
          }),
        }),
      };
    }) as typeof fake.env.DB.prepare;
    const result = await cleanupProject(fake.env, MINE);
    expect(result.status).toBe("partial");
    expect(fake.scrubbed()).toBeNull();
    expect(fake.purged.some((p) => p.startsWith("shard:"))).toBe(false);
  });

  it("does nothing for an active Project", async () => {
    const fake = fakeEnv({
      project: { status: "active", cleaned_at: null },
      objects: [`evidence/${MINE}/a`],
    });
    expect((await cleanupProject(fake.env, MINE)).status).toBe("skipped");
    expect(fake.deleted).toEqual([]);
    expect(fake.purged).toEqual([]);
    expect(fake.objects.size).toBe(1);
    expect(fake.executed).toEqual([]);
  });

  it("does nothing once the Project is cleaned, so a repeat is idempotent", async () => {
    const fake = fakeEnv({
      project: { status: "archived", cleaned_at: "2026-10-01T00:00:00.000Z" },
    });
    expect((await cleanupProject(fake.env, MINE)).status).toBe("done");
    expect(fake.deleted).toEqual([]);
    expect(fake.purged).toEqual([]);
    expect(fake.executed).toEqual([]);
  });

  it("repeats safely after a partial run", async () => {
    const fake = fakeEnv({ project: archived, objects: [`evidence/${MINE}/a`] });
    await cleanupProject(fake.env, MINE);
    const again = await cleanupProject(fake.env, MINE);
    expect(again.status).toBe("done");
    expect(fake.objects.size).toBe(0);
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
