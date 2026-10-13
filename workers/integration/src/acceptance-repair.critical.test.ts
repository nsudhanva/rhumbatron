// Real SQLite migrations: one repair Task, built on the Candidate's work, at most once per Change.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AnyEventEnvelope, type EventEnvelope } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { requestAcceptanceRepair, unmetCriteria } from "./acceptance-repair.ts";

const T = "2026-10-13T00:00:00.000Z";
const CHANGE = "chg_rep";
const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");
const ACCEPTANCE = JSON.stringify([
  { criterion: "A member can propose a law", status: "met", citations: [] },
  {
    criterion: "A law passes when yes votes are a majority of votes cast",
    status: "not_met",
    citations: [],
  },
  { criterion: "The page is pleasant", status: "unclear", citations: [] },
]);

function harness(changeStatus = "verifying", candidateStatus = "verified") {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  db.exec(`INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('org', 'Org', '${T}', '${T}');
    INSERT INTO projects (id, org_id, name, slug, status, canonical_generation, created_at, updated_at)
    VALUES ('proj_rep', 'org', 'P', 'p', 'active', 0, '${T}', '${T}');
    INSERT INTO changes (id, project_id, goal, status, base_generation, budget_usd, created_by, created_at, updated_at)
    VALUES ('${CHANGE}', 'proj_rep', 'g', '${changeStatus}', 0, 3, 'u', '${T}', '${T}');`);
  for (const [key, criteria, resources] of [
    ["t1", ["A member can propose a law"], ["project:p:laws:api"]],
    ["t2", ["A law passes when yes votes are a majority of votes cast"], ["project:p:laws:voting"]],
  ] as const) {
    db.prepare(`INSERT INTO tasks (id, change_id, kind, status, task_key, acceptance_criteria_json,
      semantic_resources_json, created_at, updated_at) VALUES (?, ?, 'implement', 'completed', ?, ?, ?, ?, ?)`).run(
      `tsk_rep_${key}`,
      CHANGE,
      key,
      JSON.stringify(criteria),
      JSON.stringify(resources),
      T,
      T,
    );
    db.prepare(`INSERT INTO task_runs (id, task_id, agent_id, attempt, tier, status, started_at)
      VALUES (?, ?, 'a', 1, 'sonnet', 'completed', ?)`).run(
      `run_rep_${key}_1`,
      `tsk_rep_${key}`,
      T,
    );
    db.prepare(`INSERT INTO changesets (id, change_id, agent_id, base_generation, intent_json, status, created_at)
      VALUES (?, ?, 'a', 0, '{}', 'proposed', ?)`).run(`cs_rep_${key}_1`, CHANGE, T);
  }
  db.prepare(`INSERT INTO candidates (id, change_id, base_generation, status, change_set_ids_json, acceptance_json,
    created_at, updated_at) VALUES ('cand_rep', ?, 0, ?, '["cs_rep_t1_1","cs_rep_t2_1"]', ?, ?, ?)`).run(
    CHANGE,
    candidateStatus,
    ACCEPTANCE,
    T,
    T,
  );
  const events = new Map<string, EventEnvelope>();
  const wakes: { taskId: string }[] = [];
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
    RESOURCE_SHARD: {
      idFromName: (n: string) => n,
      get: () => ({
        appendEvents: async (list: EventEnvelope[]) => {
          for (const e of list) events.set(e.eventId, AnyEventEnvelope.parse(e));
        },
      }),
    },
    AGENT_WAKEUPS: {
      sendBatch: async (messages: { body: { taskId: string } }[]) => {
        wakes.push(...messages.map((m) => m.body));
      },
    },
  } as unknown as Env;
  const one = (sql: string) => db.prepare(sql).get() as Record<string, unknown>;
  return { db, env, wakes, one };
}

describe("acceptance repair", () => {
  it("reads only not_met criteria", () => {
    expect(unmetCriteria(ACCEPTANCE)).toEqual([
      "A law passes when yes votes are a majority of votes cast",
    ]);
  });

  it("adds one repair Task on the Candidate's work, replaces the Candidate, and runs the Change", async () => {
    const h = harness();
    expect(
      await requestAcceptanceRepair(h.env, { candidateId: "cand_rep", trigger: "acceptance" }),
    ).toBe(true);
    const task = h.one("SELECT * FROM tasks WHERE task_key = 'repair'");
    expect(task).toMatchObject({ status: "ready", semantic_resource: "project:p:laws:voting" });
    expect(String(task.objective)).toContain(
      "A law passes when yes votes are a majority of votes cast",
    );
    expect(
      h.db.prepare("SELECT depends_on_task_id d FROM task_dependencies ORDER BY 1").all(),
    ).toEqual([{ d: "tsk_rep_t1" }, { d: "tsk_rep_t2" }]);
    expect(h.one("SELECT status FROM candidates")).toEqual({ status: "rejected" });
    expect(h.one("SELECT status FROM changes")).toEqual({ status: "running" });
    expect(h.wakes.map((w) => w.taskId)).toEqual(["tsk_rep_repair"]);
    // Once per Change: a second shortfall goes to a person.
    h.db.exec(
      "UPDATE changes SET status = 'verifying'; UPDATE tasks SET status = 'completed'; UPDATE candidates SET status = 'verified'",
    );
    expect(
      await requestAcceptanceRepair(h.env, { candidateId: "cand_rep", trigger: "acceptance" }),
    ).toBe(false);
  });

  it("applies a person's requested changes after a rejection, and never repairs without a reason", async () => {
    const h = harness("verifying", "rejected");
    h.db.exec(`UPDATE candidates SET acceptance_json = '[]'`);
    expect(
      await requestAcceptanceRepair(h.env, { candidateId: "cand_rep", trigger: "approver" }),
    ).toBe(false);
    expect(
      await requestAcceptanceRepair(h.env, {
        candidateId: "cand_rep",
        trigger: "approver",
        reason: "Count only the votes cast",
      }),
    ).toBe(true);
    expect(
      String(h.one("SELECT objective FROM tasks WHERE task_key = 'repair'").objective),
    ).toContain("A reviewer asked: Count only the votes cast");
  });
});
