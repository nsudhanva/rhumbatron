// Real SQLite migrations exercise the restack transaction, its bound, and the failed end state.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AnyEventEnvelope, type EventEnvelope } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { dependencyConflict, MAX_TASK_RESTACKS, planTaskRestack, settleChange } from "./settle.ts";

const T = "2026-10-10T00:00:00.000Z";
const CHANGE = "chg_settle";
const PROJECT = "proj_settle";
const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");
const MERGE_FAILURE =
  "dependency_merge_conflict: cs_t3_1 does not merge with cs_t1_1, cs_t2_1 (src/app.ts). The dependencies of this Task conflict, so it cannot start from their work.";

/** The r/place shape: t2 and t3 both build on t1 and edit src/app.ts; t4 needs both; t5 needs all. */
function harness() {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  db.exec(`INSERT INTO projects (id, org_id, name, slug, status, canonical_generation, created_at, updated_at)
    VALUES ('${PROJECT}', 'org_test', 'Place', 'place', 'active', 0, '${T}', '${T}');
    INSERT INTO changes (id, project_id, goal, status, base_generation, budget_usd, created_by, created_at, updated_at)
    VALUES ('${CHANGE}', '${PROJECT}', 'A live pixel canvas', 'running', 0, 3, 'usr_test', '${T}', '${T}');`);
  const task = (key: string, status: string, resource: string) =>
    db
      .prepare(`INSERT INTO tasks (id, change_id, kind, status, semantic_resource, created_at, updated_at)
        VALUES (?, ?, 'implement', ?, ?, ?, ?)`)
      .run(`tsk_${key}`, CHANGE, status, `project:place:${resource}`, T, T);
  const run = (key: string, status: string, kind: string | null, reason: string | null) =>
    db
      .prepare(`INSERT INTO task_runs (id, task_id, agent_id, attempt, tier, status, failure_kind,
        outcome_json, started_at) VALUES (?, ?, ?, 1, 'sonnet', ?, ?, ?, ?)`)
      .run(
        `run_${key}_1`,
        `tsk_${key}`,
        `agt_${key}`,
        status,
        kind,
        reason ? JSON.stringify({ reason }) : null,
        T,
      );
  for (const [key, resource] of [
    ["t1", "app:bootstrap"],
    ["t2", "canvas:pixels"],
    ["t3", "identity:demo-user"],
  ] as const) {
    task(key, "completed", resource);
    run(key, "completed", null, null);
    db.prepare(`INSERT INTO changesets (id, change_id, agent_id, base_generation, intent_json, status, created_at)
      VALUES (?, ?, ?, 0, '{}', 'proposed', ?)`).run(`cs_${key}_1`, CHANGE, `agt_${key}`, T);
  }
  task("t4", "failed", "canvas:activity");
  run("t4", "failed", "dependency_merge_conflict", MERGE_FAILURE);
  task("t5", "blocked", "canvas:ui");
  db.exec(`INSERT INTO task_dependencies VALUES ('tsk_t2', 'tsk_t1'), ('tsk_t3', 'tsk_t1'),
    ('tsk_t4', 'tsk_t2'), ('tsk_t4', 'tsk_t3'), ('tsk_t5', 'tsk_t2'), ('tsk_t5', 'tsk_t3'),
    ('tsk_t5', 'tsk_t4')`);

  const events = new Map<string, EventEnvelope>();
  const wakes: { taskId: string }[] = [];
  const released: string[] = [];
  let generation = 0;
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
    run: async () => ({
      meta: { changes: Number(db.prepare(sql).run(...(params as never[])).changes) },
    }),
    execute: () => {
      const stmt = db.prepare(sql);
      if (/^\s*SELECT/.test(sql))
        return { results: stmt.all(...(params as never[])), meta: { changes: 0 } };
      return { results: [], meta: { changes: Number(stmt.run(...(params as never[])).changes) } };
    },
  });
  const namespace = (stub: object) => ({ idFromName: (n: string) => n, get: () => stub });
  const env = {
    DB: {
      prepare: (sql: string) => statement(sql),
      batch: async (statements: ReturnType<typeof statement>[]) => {
        db.exec("BEGIN");
        try {
          const results = statements.map((s) => s.execute());
          db.exec("COMMIT");
          return results;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
    PROJECT_ROOT: namespace({
      release: async (id: string) => void released.push(id),
      getCanonical: async () => ({ generation, artifactRef: "artifacts://place" }),
    }),
    RESOURCE_SHARD: namespace({
      appendEvents: async (list: EventEnvelope[]) => {
        for (const e of list) {
          AnyEventEnvelope.parse(e);
          events.set(e.eventId, e);
        }
      },
    }),
    AGENT_WAKEUPS: {
      sendBatch: async (messages: { body: { taskId: string } }[]) => {
        wakes.push(...messages.map((m) => m.body));
      },
    },
  } as unknown as Env;
  const row = (id: string) =>
    db.prepare("SELECT * FROM tasks WHERE id = ?").get(`tsk_${id}`) as Record<string, unknown>;
  const change = () =>
    db.prepare("SELECT * FROM changes WHERE id = ?").get(CHANGE) as Record<string, unknown>;
  const types = () => [...events.values()].map((e) => e.eventType);
  const setGeneration = (g: number) => {
    generation = g;
  };
  return { db, env, wakes, released, row, change, types, setGeneration };
}

describe("settle a failed Task", () => {
  it("parses the merge failure and never plans a cycle", () => {
    expect(dependencyConflict(MERGE_FAILURE)).toEqual({
      changeSetId: "cs_t3_1",
      before: ["cs_t1_1", "cs_t2_1"],
    });
    expect(dependencyConflict("timeout: the model did not answer")).toBeNull();
    const edges = [
      { task_id: "b", depends_on_task_id: "a" },
      { task_id: "c", depends_on_task_id: "b" },
    ];
    expect(planTaskRestack("b", ["a", "c"], edges)).toEqual({
      rerunTaskIds: ["b", "c"],
      onto: ["a"],
    });
    expect(planTaskRestack("b", ["c"], edges)).toBeNull();
  });

  it("re-runs the dependency that did not merge on the others, with every Task built on it", async () => {
    const h = harness();
    expect(await settleChange(h.env, CHANGE)).toBe("restacked");
    expect(
      h.db
        .prepare(
          "SELECT depends_on_task_id FROM task_dependencies WHERE task_id = 'tsk_t3' ORDER BY 1",
        )
        .all(),
    ).toEqual([{ depends_on_task_id: "tsk_t1" }, { depends_on_task_id: "tsk_t2" }]);
    // t3 is ready on top of t2; t4 and t5 wait for it; completed work stays.
    expect(h.row("t3")).toMatchObject({ status: "ready", attempts_reset_at: expect.any(String) });
    expect(h.row("t4").status).toBe("pending");
    expect(h.row("t5").status).toBe("pending");
    expect(h.row("t2").status).toBe("completed");
    expect(JSON.parse(String(h.row("t3").route_json)).integrate).toMatchObject({
      withTaskId: "tsk_t2",
    });
    expect(
      h.db.prepare("SELECT id FROM changesets WHERE status = 'proposed' ORDER BY id").all(),
    ).toEqual([{ id: "cs_t1_1" }, { id: "cs_t2_1" }]);
    expect(h.change().status).toBe("running");
    expect(h.wakes.map((w) => w.taskId)).toEqual(["tsk_t3"]);
    expect(h.types()).toContain("conflict.integrated");
    // A repeat while t3 works changes nothing.
    h.db.exec("UPDATE tasks SET status = 'running' WHERE id = 'tsk_t3'");
    expect(await settleChange(h.env, CHANGE)).toBe("waiting");
  });

  it("re-runs the Tasks on the moved canonical base when another request promoted meanwhile", async () => {
    const h = harness();
    const base =
      "dependency_merge_conflict: cs_t1_1 does not merge with the canonical base (src/app.ts, package.json). The dependencies of this Task conflict, so it cannot start from their work.";
    h.db
      .prepare("UPDATE task_runs SET outcome_json = ? WHERE id = 'run_t4_1'")
      .run(JSON.stringify({ reason: base }));
    // The base did not move: nothing to re-run on, so the Change ends with its reason.
    const still = harness();
    still.db
      .prepare("UPDATE task_runs SET outcome_json = ? WHERE id = 'run_t4_1'")
      .run(JSON.stringify({ reason: base }));
    expect(await settleChange(still.env, CHANGE)).toBe("failed");

    h.setGeneration(1);
    expect(await settleChange(h.env, CHANGE)).toBe("restacked");
    expect(h.change()).toMatchObject({ status: "running", base_generation: 1 });
    expect(h.row("t1").status).toBe("ready");
    for (const t of ["t2", "t3", "t4", "t5"]) expect(h.row(t).status).toBe("pending");
    expect(JSON.parse(String(h.row("t3").route_json)).rebase).toEqual({
      fromGeneration: 0,
      toGeneration: 1,
    });
    expect(
      h.db.prepare("SELECT COUNT(*) AS n FROM changesets WHERE status = 'proposed'").get(),
    ).toEqual({
      n: 0,
    });
    expect(h.types()).toEqual(["candidate.rebase_requested", "task.ready"]);
    expect(h.wakes.map((w) => w.taskId)).toEqual(["tsk_t1"]);
  });

  it("ends the Change failed with the reason after the restack bound, and releases its scope", async () => {
    const h = harness();
    for (let n = 1; n <= MAX_TASK_RESTACKS; n++)
      h.db
        .prepare(`INSERT INTO decision_receipts (id, task_id, agent_id, decision_type, decided_by,
          selected_tier, receipt_json, created_at) VALUES (?, 'tsk_t3', 'change-settle', 'TASK_RESTACK', 'rules', 'haiku', ?, ?)`)
        .run(`rcpt_rst_settle_${n}`, JSON.stringify({ changeId: CHANGE }), T);
    expect(await settleChange(h.env, CHANGE)).toBe("failed");
    expect(h.change()).toMatchObject({ status: "failed" });
    expect(String(h.change().blocked_reason)).toMatch(
      /^The Task on canvas:activity failed: dependency_merge_conflict: .*Submit the request again\.$/,
    );
    expect(h.types()).toEqual(["change.failed"]);
    expect(h.released).toEqual([CHANGE]);
    expect(await settleChange(h.env, CHANGE)).toBe("skipped");
  });

  it("ends a Change whose other failure leaves nothing to run, but waits while a Task works", async () => {
    const h = harness();
    h.db.exec(`UPDATE task_runs SET failure_kind = 'tool_error',
      outcome_json = '{"reason":"the build kept failing."}' WHERE id = 'run_t4_1';
      UPDATE tasks SET status = 'running' WHERE id = 'tsk_t2'`);
    expect(await settleChange(h.env, CHANGE)).toBe("waiting");
    h.db.exec("UPDATE tasks SET status = 'completed' WHERE id = 'tsk_t2'");
    expect(await settleChange(h.env, CHANGE)).toBe("failed");
    expect(h.change().blocked_reason).toBe(
      "The Task on canvas:activity failed: the build kept failing. Submit the request again.",
    );
  });

  it("ends a verifying Change with its newest Candidate's reason, not an older merge rejection", async () => {
    const h = harness();
    h.db.exec(`UPDATE changes SET status = 'verifying', updated_at = '${T}';
      UPDATE tasks SET status = 'completed';
      INSERT INTO candidates (id, change_id, base_generation, status, status_reason, change_set_ids_json, created_at, updated_at)
      VALUES ('cand_old', '${CHANGE}', 0, 'rejected', 'file_conflict: cs_t1_1 does not merge', '["cs_t1_1"]', '2026-10-10T00:00:00.000Z', '${T}'),
        ('cand_new', '${CHANGE}', 1, 'rejected', 'Preview check failed: GET /api/canvas returned 500.', '["cs_t2_1"]', '2026-10-10T00:05:00.000Z', '${T}')`);
    h.db.exec(
      'UPDATE candidates SET score_json = \'{"rebase":{"requested":true,"delivered":true}}\' WHERE id = \'cand_old\'',
    );
    expect(await settleChange(h.env, CHANGE)).toBe("failed");
    expect(h.change().blocked_reason).toBe(
      "No Candidate passed its required checks: Preview check failed: GET /api/canvas returned 500. Submit the request again.",
    );
  });

  it("ends a verifying Change whose only Candidate failed a merge that no rebase can re-run", async () => {
    const h = harness();
    h.db.exec(`UPDATE changes SET status = 'verifying', updated_at = '${T}';
      UPDATE tasks SET status = 'completed';
      INSERT INTO candidates (id, change_id, base_generation, status, status_reason, change_set_ids_json, created_at, updated_at)
      VALUES ('cand_one', '${CHANGE}', 0, 'rejected', 'file_conflict: cs_t3_1 does not merge', '["cs_t3_1"]', '${T}', '${T}')`);
    expect(await settleChange(h.env, CHANGE)).toBe("failed");
    expect(h.change().blocked_reason).toBe(
      "The agents' work did not merge (file_conflict: cs_t3_1 does not merge). Submit the request again.",
    );
  });
});
