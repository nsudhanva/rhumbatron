// Request review (ADR 0028): include starts the ChangeWorkflow once and is idempotent; decline is
// terminal. Real D1 migrations and SQL; the Durable Objects and the workflow binding are stubs.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  cancelChange,
  declineChange,
  includeChange,
  raiseChangeBudget,
  recordProposal,
} from "./change-commands.ts";

const now = "2026-10-11T00:00:00.000Z";

function harness() {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  const directory = join(import.meta.dirname, "../../../migrations/d1");
  for (const file of readdirSync(directory)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(directory, file), "utf8"));
  db.exec(`
    INSERT INTO projects (id, org_id, name, slug, status, canonical_generation, created_at, updated_at)
      VALUES ('p', 'o', 'Shop', 'shop', 'active', 0, '${now}', '${now}');
    INSERT INTO changes (id, project_id, goal, status, base_generation, budget_usd, created_by,
      review_state, created_at, updated_at) VALUES
      ('chg_a', 'p', 'Add wishlists', 'proposed', 1, 3, 'usr_mia', 'proposed', '${now}', '${now}'),
      ('chg_b', 'p', 'Add reviews', 'proposed', 1, 3, 'usr_mia', 'proposed', '${now}', '${now}');
  `);
  const execute = (sql: string, params: unknown[]) => {
    const statement = db.prepare(sql);
    if (statement.columns().length)
      return { results: statement.all(...(params as never[])), meta: { changes: 0 } };
    return {
      results: [],
      meta: { changes: Number(statement.run(...(params as never[])).changes) },
    };
  };
  const statement = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...values: unknown[]) => statement(sql, values),
    run: async () => execute(sql, params),
    all: async () => execute(sql, params),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
  });
  const events: { eventId: string; eventType: string }[] = [];
  const started: string[] = [];
  const released: string[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => statement(sql),
      batch: async (list: { sql: string; params: unknown[] }[]) =>
        list.map(({ sql, params }) => execute(sql, params)),
    },
    PROJECT_ROOT: {
      idFromName: (name: string) => name,
      get: () => ({
        getCanonical: async () => ({ generation: 7 }),
        release: async (id: string) => released.push(id),
      }),
    },
    RESOURCE_SHARD: {
      idFromName: (name: string) => name,
      get: () => ({
        appendEvents: async (list: { eventId: string; eventType: string }[]) =>
          events.push(...list),
      }),
    },
    CHANGE_WORKFLOW: {
      create: async ({ id }: { id: string }) => {
        if (started.includes(id)) throw Error("exists");
        started.push(id);
      },
      get: async (id: string) => {
        if (!started.includes(id)) throw Error("missing");
        return { id };
      },
    },
  } as unknown as Env;
  const status = (id: string) =>
    db
      .prepare(
        "SELECT status, base_generation, review_state, review_decided_by, outcome, outcome_reason FROM changes WHERE id = ?",
      )
      .get(id);
  return { env, db, events, started, released, status };
}

const actor = { actorUserId: "usr_adam" };

describe("include", () => {
  it("starts the ChangeWorkflow once at the current generation, and a repeat returns the same result", async () => {
    const { env, events, started, status } = harness();
    const first = await includeChange(env, { changeId: "chg_a", ...actor });
    expect(first).toEqual({
      result: "recorded",
      changeId: "chg_a",
      status: "created",
      repeated: false,
    });
    expect(status("chg_a")).toMatchObject({
      status: "created",
      base_generation: 7,
      review_state: "included",
      review_decided_by: "usr_adam",
    });
    const again = await includeChange(env, { changeId: "chg_a", ...actor });
    expect(again).toEqual({
      result: "recorded",
      changeId: "chg_a",
      status: "created",
      repeated: true,
    });
    expect(started).toEqual(["chg_a"]);
    // One event ID for both calls: the shard outbox dedupes it.
    const included = events.filter((e) => e.eventType === "change.included");
    expect(new Set(included.map((e) => e.eventId)).size).toBe(1);
  });

  it("starts no second workflow after the Change moved on", async () => {
    const { env, db, started } = harness();
    await includeChange(env, { changeId: "chg_a", ...actor });
    db.exec("UPDATE changes SET status = 'running' WHERE id = 'chg_a'");
    const again = await includeChange(env, { changeId: "chg_a", ...actor });
    expect(again).toMatchObject({ result: "recorded", status: "running", repeated: true });
    expect(started).toEqual(["chg_a"]);
  });

  it("refuses a Change that was never proposed or that was declined", async () => {
    const { env, db, started } = harness();
    db.exec("UPDATE changes SET status = 'created', review_state = NULL WHERE id = 'chg_b'");
    expect(await includeChange(env, { changeId: "chg_b", ...actor })).toMatchObject({
      result: "refused",
      reason: "not_proposed",
    });
    await declineChange(env, { changeId: "chg_a", ...actor, reason: null });
    expect(await includeChange(env, { changeId: "chg_a", ...actor })).toMatchObject({
      result: "refused",
      reason: "not_proposed",
    });
    expect(await includeChange(env, { changeId: "chg_x", ...actor })).toMatchObject({
      result: "refused",
      reason: "not_found",
    });
    expect(started).toEqual([]);
  });
});

describe("decline", () => {
  it("ends the request with the reason, and nothing moves it again", async () => {
    const { env, started, status, events } = harness();
    const declined = await declineChange(env, {
      changeId: "chg_a",
      ...actor,
      reason: "Out of scope",
    });
    expect(declined).toEqual({
      result: "recorded",
      changeId: "chg_a",
      status: "declined",
      repeated: false,
    });
    expect(status("chg_a")).toMatchObject({
      status: "declined",
      review_state: "declined",
      outcome: "declined",
      outcome_reason: "Out of scope",
    });
    expect(
      await declineChange(env, { changeId: "chg_a", ...actor, reason: "Out of scope" }),
    ).toMatchObject({ result: "recorded", repeated: true });
    expect(await cancelChange(env, { changeId: "chg_a", ...actor })).toMatchObject({
      status: "refused",
      reason: "not_cancellable",
    });
    expect(
      await raiseChangeBudget(env, { changeId: "chg_a", budgetUsd: 10, ...actor }),
    ).toMatchObject({ status: "refused", reason: "change_closed" });
    expect(status("chg_a")).toMatchObject({ status: "declined" });
    expect(started).toEqual([]);
    expect(events.map((e) => e.eventType)).toContain("change.declined");
  });

  it("refuses a request that was already included", async () => {
    const { env } = harness();
    await includeChange(env, { changeId: "chg_a", ...actor });
    expect(await declineChange(env, { changeId: "chg_a", ...actor, reason: null })).toMatchObject({
      result: "refused",
      reason: "not_proposed",
    });
  });
});

describe("withdraw and proposal events", () => {
  it("lets the requester withdraw a proposed request without touching ProjectRootDO", async () => {
    const { env, released, status } = harness();
    expect(await cancelChange(env, { changeId: "chg_a", actorUserId: "usr_mia" })).toMatchObject({
      status: "recorded",
      changeStatus: "cancelled",
    });
    expect(status("chg_a")).toMatchObject({ status: "cancelled" });
    expect(released).toEqual([]);
  });

  it("records change.proposed only for a request under review", async () => {
    const { env, db, events } = harness();
    expect(await recordProposal(env, { changeId: "chg_a", actorUserId: "usr_mia" })).toEqual({
      recorded: true,
    });
    db.exec("UPDATE changes SET review_state = NULL WHERE id = 'chg_b'");
    expect(await recordProposal(env, { changeId: "chg_b", actorUserId: "usr_mia" })).toEqual({
      recorded: false,
    });
    expect(events.map((e) => e.eventType)).toEqual(["change.proposed"]);
  });
});
