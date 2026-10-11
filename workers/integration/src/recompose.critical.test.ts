// Real SQLite migrations: a stale Candidate is composed again, or its Change leaves `verifying`
// for a visible `blocked` state. Never a Change in `verifying` with nothing running.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EventEnvelope } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { raiseChangeBudget } from "./change-commands.ts";
import {
  recomposeQuietly,
  recoverStaleCandidates,
  STALE_BLOCKED_REASON,
  STALE_BOUND_REASON,
  settleStaleBehind,
} from "./recompose.ts";

const T = "2026-10-10T21:07:38.176Z";
const PROJECT = "proj_recipe";
const CHANGE = "chg_design";
const STALE = "cand_5bc40ad597183236c994f403";
const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");
// The event router's `canonical.advanced` sweep reason: it carries no "Recomposed as" suffix.
const ROUTER_REASON = "Canonical advanced to S3; this Candidate's base is older.";

function harness(options: { canonical?: () => Promise<unknown> } = {}) {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  // The prod shape: a partially selected Change, its one Task completed, one proposed ChangeSet,
  // and its only Candidate marked stale by the router while its checks ran. Canonical is S4.
  db.exec(`INSERT INTO projects (id, org_id, name, slug, status, canonical_generation, created_at, updated_at)
    VALUES ('${PROJECT}', 'org_1', 'Recipes', 'recipe-app', 'active', 4, '${T}', '${T}');
    INSERT INTO changes (id, project_id, goal, status, base_generation, budget_usd, created_by, created_at, updated_at, outcome)
    VALUES ('${CHANGE}', '${PROJECT}', 'Grid of cards', 'verifying', 2, 1, 'usr_1', '${T}', '${T}', 'partially_selected');
    INSERT INTO tasks (id, change_id, kind, status, created_at, updated_at)
    VALUES ('tsk_1', '${CHANGE}', 'implement', 'completed', '${T}', '${T}');
    INSERT INTO changesets (id, change_id, agent_id, base_generation, intent_json, status, created_at)
    VALUES ('cs_1', '${CHANGE}', 'agt_1', 2, '{}', 'proposed', '${T}');
    INSERT INTO candidates (id, change_id, base_generation, status, status_reason, change_set_ids_json, created_at, updated_at)
    VALUES ('${STALE}', '${CHANGE}', 2, 'stale', '${ROUTER_REASON.replaceAll("'", "''")}', '["cs_1"]', '${T}', '${T}');`);
  const events: EventEnvelope[] = [];
  const commands: { payload: { candidateId: string } }[] = [];
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
      getCanonical:
        options.canonical ?? (async () => ({ generation: 4, artifactRef: "artifacts://recipes" })),
    }),
    RESOURCE_SHARD: namespace({
      appendEvents: async (list: EventEnvelope[]) => {
        events.push(...list);
      },
    }),
    VERIFICATION_COMMANDS: {
      send: async (command: { payload: { candidateId: string } }) => {
        commands.push(command);
      },
    },
    CANDIDATE_WORKFLOW: { create: async () => ({}), get: async () => ({}) },
  } as unknown as Env;
  return {
    db,
    env,
    events,
    commands,
    change: () =>
      db
        .prepare(`SELECT status, blocked_limit, blocked_reason FROM changes WHERE id = ?`)
        .get(CHANGE),
    candidates: () =>
      db
        .prepare(
          `SELECT id, status, status_reason, base_generation, recompose_count, recomposed_from
           FROM candidates ORDER BY created_at, id`,
        )
        .all(),
  };
}

describe("stale Candidate of a verifying Change (prod chg_2ed2e016)", () => {
  it("a router-staled Candidate is composed again on the new canonical state", async () => {
    const h = harness();
    try {
      const outcome = await recomposeQuietly(h.env, STALE);
      expect(outcome).toMatchObject({ status: "recomposed", baseGeneration: 4, count: 1 });
      if (outcome.status !== "recomposed") throw new Error("not recomposed");
      const [old, next] = h.candidates();
      expect(old).toMatchObject({ id: STALE, status: "stale" });
      expect(old?.status_reason).toContain(`Recomposed as ${outcome.candidateId}`);
      expect(next).toMatchObject({
        id: outcome.candidateId,
        status: "composing",
        base_generation: 4,
        recompose_count: 1,
        recomposed_from: STALE,
      });
      expect(h.commands.map((c) => c.payload.candidateId)).toEqual([outcome.candidateId]);
      expect(h.change()).toMatchObject({ status: "verifying", blocked_reason: null });
      // A repeat (a redelivered step) finds the same Candidate and creates nothing new.
      expect(await recomposeQuietly(h.env, STALE)).toMatchObject({
        candidateId: outcome.candidateId,
      });
      expect(h.candidates()).toHaveLength(2);
    } finally {
      h.db.close();
    }
  });

  it("a recompose that throws blocks the Change with a plain reason", async () => {
    const h = harness({
      canonical: async () => {
        throw new Error("ProjectRootDO unavailable");
      },
    });
    try {
      expect(await recomposeQuietly(h.env, STALE)).toEqual({ status: "skipped", reason: "error" });
      expect(h.change()).toEqual({
        status: "blocked",
        blocked_limit: null,
        blocked_reason: STALE_BLOCKED_REASON,
      });
      expect(
        h.events.map((e) => [e.eventType, (e.payload as { changeStatus?: string }).changeStatus]),
      ).toEqual([["candidate.stale", "blocked"]]);
    } finally {
      h.db.close();
    }
  });

  it("a skipped recompose (archived Project) blocks the Change", async () => {
    const h = harness();
    try {
      h.db.prepare("UPDATE projects SET status = 'archived'").run();
      expect(await recomposeQuietly(h.env, STALE)).toMatchObject({ status: "skipped" });
      expect(h.change()).toMatchObject({ status: "blocked", blocked_reason: STALE_BLOCKED_REASON });
    } finally {
      h.db.close();
    }
  });

  it("the recomposition bound blocks the Change, not only the Candidate", async () => {
    const h = harness();
    try {
      h.db.prepare("UPDATE candidates SET recompose_count = 2").run();
      expect(await recomposeQuietly(h.env, STALE)).toMatchObject({ status: "blocked" });
      expect(h.change()).toMatchObject({ status: "blocked", blocked_reason: STALE_BOUND_REASON });
    } finally {
      h.db.close();
    }
  });

  it("does not block while another Candidate of the Change is still active", async () => {
    const h = harness({
      canonical: async () => {
        throw new Error("ProjectRootDO unavailable");
      },
    });
    try {
      h.db.exec(`INSERT INTO candidates (id, change_id, base_generation, status, change_set_ids_json, created_at, updated_at)
        VALUES ('cand_other', '${CHANGE}', 4, 'verifying', '["cs_1"]', '${T}', '${T}')`);
      await recomposeQuietly(h.env, STALE);
      expect(h.change()).toMatchObject({ status: "verifying", blocked_reason: null });
      expect(h.events).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  it("the owner budget action recomposes a stuck verifying Change (same amount)", async () => {
    const h = harness();
    try {
      const result = await raiseChangeBudget(h.env, {
        changeId: CHANGE,
        budgetUsd: 1,
        actorUserId: "usr_owner",
      });
      expect(result).toMatchObject({ status: "recorded", changeStatus: "verifying" });
      expect(h.candidates()[1]).toMatchObject({
        status: "composing",
        base_generation: 4,
        recomposed_from: STALE,
      });
      // Nothing left to recover: a repeat composes no second lineage.
      expect(await recoverStaleCandidates(h.env, CHANGE)).toBeNull();
      expect(h.candidates()).toHaveLength(2);
    } finally {
      h.db.close();
    }
  });

  it("the owner budget action returns a stale-blocked Change to verifying", async () => {
    let fail = true;
    const h = harness({
      canonical: async () => {
        if (fail) throw new Error("ProjectRootDO unavailable");
        return { generation: 4, artifactRef: "artifacts://recipes" };
      },
    });
    try {
      await recomposeQuietly(h.env, STALE);
      expect(h.change()).toMatchObject({ status: "blocked" });
      fail = false;
      const result = await raiseChangeBudget(h.env, {
        changeId: CHANGE,
        budgetUsd: 1,
        actorUserId: "usr_owner",
      });
      expect(result).toMatchObject({ status: "recorded", changeStatus: "verifying" });
      expect(h.change()).toEqual({
        status: "verifying",
        blocked_limit: null,
        blocked_reason: null,
      });
      expect(h.candidates()).toHaveLength(2);
    } finally {
      h.db.close();
    }
  });

  it("does not touch a Change blocked for another reason", async () => {
    const h = harness();
    try {
      h.db.prepare("UPDATE changes SET status = 'blocked', blocked_reason = 'Other stop'").run();
      expect(await recoverStaleCandidates(h.env, CHANGE)).toBeNull();
      expect(h.candidates()).toHaveLength(1);
    } finally {
      h.db.close();
    }
  });
});

// Prod chg_5154e643: its only Candidate was verified and held for acceptance (`awaiting_approval`).
// A parallel Change promoted; the event router's `canonical.advanced` sweep marked the held
// Candidate stale and returned the Change to `verifying` before the promotion's own sweep ran, and
// that sweep read only `verified` Candidates. Nothing composed it again or blocked the Change.
describe("stale sweep after canonical.advanced (prod chg_5154e643)", () => {
  it("composes a Candidate the router sweep already marked stale", async () => {
    const h = harness();
    try {
      expect(await settleStaleBehind(h.env, PROJECT, 4)).toEqual([STALE]);
      const [old, next] = h.candidates();
      expect(old).toMatchObject({ id: STALE, status: "stale" });
      expect(next).toMatchObject({
        status: "composing",
        base_generation: 4,
        recompose_count: 1,
        recomposed_from: STALE,
      });
      expect(h.commands.map((c) => c.payload.candidateId)).toEqual([next?.id]);
      expect(h.change()).toMatchObject({ status: "verifying", blocked_reason: null });
      // The promotion sweep and the router command both run: the second finds nothing to settle.
      expect(await settleStaleBehind(h.env, PROJECT, 4)).toEqual([]);
      expect(h.candidates()).toHaveLength(2);
    } finally {
      h.db.close();
    }
  });

  it("marks a held verified Candidate stale and composes it when it runs first", async () => {
    const h = harness();
    try {
      h.db.exec(`UPDATE candidates SET status = 'verified', status_reason = 'Held for acceptance';
        UPDATE changes SET status = 'awaiting_approval';`);
      expect(await settleStaleBehind(h.env, PROJECT, 4)).toEqual([STALE]);
      expect(h.candidates()[0]).toMatchObject({
        status: "stale",
        status_reason: expect.stringContaining("Recomposed as"),
      });
      expect(h.candidates()[1]).toMatchObject({ status: "composing", base_generation: 4 });
      expect(h.change()).toMatchObject({ status: "verifying" });
      expect(h.events.map((e) => e.eventType)).toEqual(["candidate.stale", "candidate.forked"]);
    } finally {
      h.db.close();
    }
  });

  it("blocks the Change visibly when the stale Candidate cannot be composed again", async () => {
    const h = harness();
    try {
      h.db.prepare("UPDATE candidates SET recompose_count = 2").run();
      expect(await settleStaleBehind(h.env, PROJECT, 4)).toEqual([STALE]);
      expect(h.change()).toMatchObject({ status: "blocked", blocked_reason: STALE_BOUND_REASON });
    } finally {
      h.db.close();
    }
  });

  it("leaves closed Changes and Changes with an active Candidate alone", async () => {
    const h = harness();
    try {
      h.db.exec(`INSERT INTO candidates (id, change_id, base_generation, status, change_set_ids_json, created_at, updated_at)
        VALUES ('cand_other', '${CHANGE}', 2, 'verifying', '["cs_1"]', '${T}', '${T}')`);
      expect(await settleStaleBehind(h.env, PROJECT, 4)).toEqual([]);
      h.db.exec(`DELETE FROM candidates WHERE id = 'cand_other';
        UPDATE changes SET status = 'cancelled';`);
      expect(await settleStaleBehind(h.env, PROJECT, 4)).toEqual([]);
      expect(h.candidates()).toHaveLength(1);
    } finally {
      h.db.close();
    }
  });
});
