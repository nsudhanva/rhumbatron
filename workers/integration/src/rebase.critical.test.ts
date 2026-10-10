// Real SQLite migrations exercise the retry transaction, dependency closure, and per-Change bound.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AnyEventEnvelope, type EventEnvelope } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { composeChangeCandidates } from "./candidate-create.ts";
import { raiseChangeBudget } from "./change-commands.ts";
import { dispatchReadyTasks } from "./dispatch.ts";
import {
  failedMergeChangeSet,
  REBASE_BLOCKED_REASON,
  recordSourceConflict,
  recoverSourceConflicts,
  requestCandidateRebase,
} from "./rebase.ts";

const T = "2026-10-10T00:00:00.000Z";
const CHANGE = "chg_rebase";
const PROJECT = "proj_rebase";
const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");

function harness() {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  db.exec(`INSERT INTO projects (id, org_id, name, slug, status, canonical_generation, created_at, updated_at)
    VALUES ('${PROJECT}', 'org_test', 'Test', 'test', 'active', 3, '${T}', '${T}');
    INSERT INTO changes (id, project_id, goal, status, base_generation, budget_usd, created_by, created_at, updated_at)
    VALUES ('${CHANGE}', '${PROJECT}', 'Dark navy with white text', 'verifying', 2, 3, 'usr_test', '${T}', '${T}');`);
  const events = new Map<string, EventEnvelope>();
  const wakes: { commandId: string; taskId: string }[] = [];
  const commands: unknown[] = [];
  let failEvents = false;
  let failWake = false;
  let generation = 3;
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
      getCanonical: async () => ({ generation, artifactRef: "artifacts://test" }),
    }),
    RESOURCE_SHARD: namespace({
      appendEvents: async (list: EventEnvelope[]) => {
        if (failEvents) throw new Error("outbox unavailable");
        for (const e of list) {
          AnyEventEnvelope.parse(e);
          events.set(e.eventId, e);
        }
      },
    }),
    AGENT_WAKEUPS: {
      sendBatch: async (messages: { body: { commandId: string; taskId: string } }[]) => {
        if (failWake) throw new Error("queue unavailable");
        wakes.push(...messages.map((m) => m.body));
      },
    },
    VERIFICATION_COMMANDS: {
      send: async (command: unknown) => {
        commands.push(command);
      },
    },
    CANDIDATE_WORKFLOW: { create: async () => ({}) },
  } as unknown as Env;
  function source(task: string, attempt = 1, base = 2) {
    db.prepare(`INSERT OR IGNORE INTO tasks (id, change_id, kind, status, assigned_agent_id, wake_sent_at,
      created_at, updated_at) VALUES (?, ?, 'implement', 'completed', 'agt_old', ?, ?, ?)`).run(
      `tsk_${task}`,
      CHANGE,
      T,
      T,
      T,
    );
    db.prepare(`INSERT INTO task_runs (id, task_id, agent_id, attempt, tier, status, started_at)
      VALUES (?, ?, 'agt_old', ?, 'sonnet', 'completed', ?)`).run(
      `run_${task}_${attempt}`,
      `tsk_${task}`,
      attempt,
      T,
    );
    const intent = {
      summary: "Test source",
      changeSet: {
        fork: "test-fork",
        commit: "a".repeat(40),
        baseCommit: "b".repeat(40),
        diffStat: "1 file",
        files: ["public/index.html"],
      },
    };
    db.prepare(`INSERT INTO changesets (id, change_id, agent_id, base_generation, intent_json, status, created_at)
      VALUES (?, ?, 'agt_old', ?, ?, 'proposed', ?)`).run(
      `cs_${task}_${attempt}`,
      CHANGE,
      base,
      JSON.stringify(intent),
      T,
    );
  }
  function candidate(id = "cand_conflict", attempt = 1, recomposed: string | null = "cand_old") {
    db.prepare(`INSERT INTO candidates (id, change_id, base_generation, status, status_reason, recomposed_from,
      change_set_ids_json, created_at, updated_at) VALUES (?, ?, 3, 'rejected', ?, ?, ?, ?, ?)`).run(
      id,
      CHANGE,
      `file_conflict: cs_conflict_${attempt} does not merge`,
      recomposed,
      JSON.stringify([`cs_conflict_${attempt}`, "cs_keep_1", `cs_dependent_${attempt}`]),
      T,
      T,
    );
  }
  source("conflict");
  source("keep");
  source("dependent");
  source("grandchild");
  db.exec(`INSERT INTO task_dependencies VALUES ('tsk_dependent', 'tsk_conflict'), ('tsk_dependent', 'tsk_keep'),
    ('tsk_grandchild', 'tsk_dependent')`);
  candidate();
  const task = (id: string) =>
    db.prepare("SELECT * FROM tasks WHERE id = ?").get(`tsk_${id}`) as Record<string, unknown>;
  const change = () =>
    db.prepare("SELECT * FROM changes WHERE id = ?").get(CHANGE) as Record<string, unknown>;
  return {
    db,
    env,
    events,
    wakes,
    commands,
    candidate,
    source,
    task,
    change,
    setGeneration: (g: number) => {
      generation = g;
    },
    failEvents: (fail: boolean) => {
      failEvents = fail;
    },
    failWake: (fail: boolean) => {
      failWake = fail;
    },
  };
}

describe("rebase by rerun", () => {
  it("reopens only the failed Task and its dependents, keeps merged work, and dispatches once", async () => {
    const h = harness();
    const result = await requestCandidateRebase(h.env, "cand_conflict");
    expect(result).toMatchObject({
      status: "running",
      repeated: false,
      count: 1,
      taskIds: ["tsk_conflict", "tsk_dependent", "tsk_grandchild"],
    });
    expect(h.change()).toMatchObject({
      status: "running",
      base_generation: 3,
      blocked_reason: null,
    });
    expect(h.task("conflict")).toMatchObject({
      status: "ready",
      assigned_agent_id: null,
      attempts_reset_at: expect.any(String),
      blocked_reason: null,
    });
    expect(h.task("dependent").status).toBe("pending");
    expect(h.task("grandchild").status).toBe("pending");
    expect(h.task("keep")).toMatchObject({ status: "completed", attempts_reset_at: null });
    expect(h.db.prepare("SELECT id FROM changesets WHERE status = 'proposed'").all()).toEqual([
      { id: "cs_keep_1" },
    ]);
    expect(h.wakes.map((w) => w.taskId)).toEqual(["tsk_conflict"]);
    expect(
      [...h.events.values()].filter((e) => e.eventType === "candidate.rebase_requested"),
    ).toHaveLength(1);
    const reset = h.task("conflict").attempts_reset_at;
    expect(await requestCandidateRebase(h.env, "cand_conflict")).toMatchObject({
      repeated: true,
      count: 1,
    });
    expect(h.task("conflict").attempts_reset_at).toBe(reset);
    expect(h.wakes).toHaveLength(1);
  });

  it("shares the two-rerun bound across Candidates and then blocks with the plain reason", async () => {
    const h = harness();
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) {
        h.db.exec(`UPDATE tasks SET status = 'completed'; UPDATE changes SET status = 'verifying'`);
        h.source("conflict", attempt, 3);
        h.candidate(`cand_${attempt}`, attempt);
      }
      const result = await requestCandidateRebase(
        h.env,
        attempt === 1 ? "cand_conflict" : `cand_${attempt}`,
      );
      expect(result).toMatchObject({
        count: Math.min(attempt, 2),
        status: attempt === 3 ? "blocked" : "running",
      });
    }
    expect(h.change()).toMatchObject({ status: "blocked", blocked_reason: REBASE_BLOCKED_REASON });
    expect(h.wakes).toHaveLength(2);
    const reset = h.task("conflict").attempts_reset_at;
    await requestCandidateRebase(h.env, "cand_3");
    expect(h.task("conflict").attempts_reset_at).toBe(reset);
    expect(h.wakes).toHaveLength(2);
  });

  it("never reopens a not_selected, cancelled, awaiting_owner, or promoted request", async () => {
    for (const [status, outcome] of [
      ["not_selected", null],
      ["cancelled", null],
      ["awaiting_owner", null],
      ["verifying", "not_selected"],
      ["verifying", "overridden"],
      ["completed", null],
      ["promoting", null],
    ] as const) {
      const h = harness();
      h.db.prepare("UPDATE changes SET status = ?, outcome = ?").run(status, outcome);
      expect(await requestCandidateRebase(h.env, "cand_conflict")).toMatchObject({
        status: "skipped",
      });
      expect(h.task("conflict").status).toBe("completed");
      expect(h.wakes).toHaveLength(0);
    }
  });
  it.each(["running", "awaiting_approval"])(
    "resumes an open %s Change when its Tasks are complete",
    async (status) => {
      const h = harness();
      h.db.prepare("UPDATE changes SET status = ?").run(status);
      expect(await requestCandidateRebase(h.env, "cand_conflict")).toMatchObject({
        status: "running",
        count: 1,
      });
      expect(h.wakes).toHaveLength(1);
    },
  );

  it("does not reset live work or lose a selection race between the read and the transaction", async () => {
    const active = harness();
    active.db.exec("UPDATE tasks SET status = 'running' WHERE id = 'tsk_keep'");
    expect(await requestCandidateRebase(active.env, "cand_conflict")).toEqual({
      status: "skipped",
      reason: "changed",
    });
    expect(active.task("conflict").status).toBe("completed");
    const h = harness();
    const prepare = h.env.DB.prepare.bind(h.env.DB);
    h.env.DB.prepare = (sql: string) => {
      if (sql.startsWith("UPDATE candidates SET score_json"))
        h.db.exec("UPDATE changes SET status = 'not_selected', outcome = 'not_selected'");
      return prepare(sql);
    };
    expect(await requestCandidateRebase(h.env, "cand_conflict")).toEqual({
      status: "skipped",
      reason: "changed",
    });
    expect(h.task("conflict").attempts_reset_at).toBeNull();
    expect(h.wakes).toHaveLength(0);
  });

  it("is idempotent for concurrent duplicate delivery", async () => {
    const h = harness();
    await Promise.all([
      requestCandidateRebase(h.env, "cand_conflict"),
      requestCandidateRebase(h.env, "cand_conflict"),
    ]);
    const receipt = JSON.parse(
      String(
        h.db.prepare("SELECT score_json FROM candidates WHERE id = 'cand_conflict'").get()
          ?.score_json,
      ),
    );
    expect(receipt.rebase.count).toBe(1);
    expect(
      [...h.events.values()].filter((e) => e.eventType === "candidate.rebase_requested"),
    ).toHaveLength(1);
    // At-least-once Queue sends may race; every duplicate has the same logical wake identity.
    expect(new Set(h.wakes.map((w) => w.commandId)).size).toBe(1);
  });

  it("never reruns the same old source through a different rejected sibling", async () => {
    const h = harness();
    h.candidate("cand_sibling");
    await requestCandidateRebase(h.env, "cand_conflict");
    h.db.exec("UPDATE tasks SET status = 'completed'; UPDATE changes SET status = 'verifying'");
    expect(await requestCandidateRebase(h.env, "cand_sibling")).toEqual({
      status: "skipped",
      reason: "superseded",
    });
    expect(h.wakes).toHaveLength(1);
  });

  it.each(["outbox", "queue"])(
    "repairs a lost %s delivery without another reset",
    async (failure) => {
      const h = harness();
      if (failure === "outbox") h.failEvents(true);
      else h.failWake(true);
      await expect(requestCandidateRebase(h.env, "cand_conflict")).rejects.toThrow("unavailable");
      const reset = h.task("conflict").attempts_reset_at;
      h.failEvents(false);
      h.failWake(false);
      await recoverSourceConflicts(h.env);
      expect(h.task("conflict").attempts_reset_at).toBe(reset);
      expect(h.wakes).toHaveLength(1);
    },
  );

  it("recovers a first Candidate with older Task source, but never retries a current-base conflict or check failure", async () => {
    const h = harness();
    h.db.exec("UPDATE candidates SET recomposed_from = NULL");
    expect(await requestCandidateRebase(h.env, "cand_conflict")).toMatchObject({
      status: "running",
    });
    for (const reason of [
      "build check failed",
      "Composition did not finish: timeout",
      "file_conflict: two files overlap",
    ]) {
      const other = harness();
      other.db.prepare("UPDATE candidates SET status_reason = ?").run(reason);
      expect(await requestCandidateRebase(other.env, "cand_conflict")).toMatchObject({
        status: "skipped",
      });
      expect(other.wakes).toHaveLength(0);
    }
    const current = harness();
    current.db.exec(
      "UPDATE candidates SET recomposed_from = NULL; UPDATE changesets SET base_generation = 3",
    );
    expect(await requestCandidateRebase(current.env, "cand_conflict")).toEqual({
      status: "skipped",
      reason: "base_not_moved",
    });
  });

  it("recomposes new work with retained older ChangeSets and wakes dependents only after upstream completion", async () => {
    const h = harness();
    // Earlier rejected alternatives must not exhaust the new composition round's slots.
    h.candidate("cand_alt1", 1, null);
    h.candidate("cand_alt2", 1, null);
    h.db.exec("UPDATE candidates SET recomposed_from = NULL");
    await requestCandidateRebase(h.env, "cand_conflict");
    h.db.exec("UPDATE tasks SET status = 'completed' WHERE id = 'tsk_conflict'");
    await dispatchReadyTasks(
      h.env,
      {
        projectId: PROJECT,
        orgId: "org_test",
        projectSlug: "test",
        changeId: CHANGE,
        baseGeneration: 3,
      },
      3,
    );
    expect(h.wakes.map((w) => w.taskId)).toEqual(["tsk_conflict", "tsk_dependent"]);
    h.source("conflict", 2, 3);
    h.source("dependent", 2, 3);
    h.source("grandchild", 2, 3);
    h.db.exec("UPDATE tasks SET status = 'completed'; UPDATE changes SET status = 'verifying'");
    const outcome = await composeChangeCandidates(h.env, CHANGE);
    expect(outcome.status).toBe("composed");
    const newRow = h.db.prepare("SELECT * FROM candidates WHERE status = 'composing'").get();
    expect(newRow).toMatchObject({
      base_generation: 3,
      recomposed_from: "cand_conflict",
      recompose_count: 1,
    });
    expect(JSON.parse(String(newRow?.change_set_ids_json))).toEqual([
      "cs_conflict_2",
      "cs_dependent_2",
      "cs_grandchild_2",
      "cs_keep_1",
    ]);
  });

  it("repairs existing stuck Changes through the owner budget API and the automatic sweep", async () => {
    const h = harness();
    expect(
      await raiseChangeBudget(h.env, { changeId: CHANGE, budgetUsd: 3, actorUserId: "usr_owner" }),
    ).toMatchObject({ status: "recorded", changeStatus: "running" });
    const sweep = harness();
    expect(await recoverSourceConflicts(sweep.env)).toEqual([
      expect.objectContaining({ status: "running", count: 1 }),
    ]);
  });

  it("records a confirmed merge conflict before requesting normal candidate recovery", async () => {
    const h = harness();
    h.db.exec("UPDATE candidates SET status = 'composing', status_reason = NULL");
    await recordSourceConflict(h.env, {
      candidateId: "cand_conflict",
      projectId: PROJECT,
      changeSetId: "cs_conflict_1",
    });
    expect(h.commands).toEqual([
      expect.objectContaining({ commandType: "candidate.create", changeId: CHANGE }),
    ]);
    expect(await recoverSourceConflicts(h.env, CHANGE)).toEqual([
      expect.objectContaining({ status: "running" }),
    ]);
    expect(failedMergeChangeSet("source_conflict: cs_conflict_1 does not merge")).toBe(
      "cs_conflict_1",
    );
  });
  it("never treats a missing commit or failed merge command as a source conflict", async () => {
    const h = harness();
    h.db.exec("UPDATE candidates SET status = 'composing', status_reason = NULL");
    await recordSourceConflict(h.env, {
      candidateId: "cand_conflict",
      projectId: PROJECT,
      changeSetId: "cs_conflict_1",
      sourceConflict: false,
    });
    expect(h.commands).toHaveLength(0);
    expect(await recoverSourceConflicts(h.env)).toEqual([]);
    expect(await requestCandidateRebase(h.env, "cand_conflict")).toEqual({
      status: "skipped",
      reason: "not_source_conflict",
    });
  });
});
