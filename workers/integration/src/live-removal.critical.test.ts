// Real SQLite migrations: a request that removes other people's live features asks first.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CompletionResult } from "@rhumbatron/model-router";
import { AnyEventEnvelope, type EventEnvelope } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { checkLiveRemovals, KEEP_LIVE_QUESTION, mayRemove } from "./live-removal.ts";

const T = "2026-10-14T00:00:00.000Z";
const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");
const ctx = {
  projectId: "proj_q",
  orgId: "org_q",
  projectSlug: "q",
  changeId: "chg_simplify",
  baseGeneration: 5,
};

function harness() {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  db.exec(`INSERT INTO users (id, auth_subject, email, display_name, created_at, updated_at)
      VALUES ('usr_smoke', 'sub_smoke', 's@x', 'Smoke', '${T}', '${T}'), ('usr_s', 'sub_s', 'a@x', 'Sudhanva', '${T}', '${T}');
    INSERT INTO changes (id, project_id, goal, title, status, base_generation, budget_usd, created_by, created_at, updated_at, acceptance_criteria_json)
      VALUES ('chg_board', 'proj_q', 'Leaderboard', 'Weekly leaderboard', 'completed', 3, 3, 'usr_smoke', '${T}', '${T}',
        '["The home page shows a weekly leaderboard of the quietest units", "typecheck, test and contract pass"]'),
      ('chg_own', 'proj_q', 'Gifts', 'Gifting', 'completed', 2, 3, 'usr_s', '${T}', '${T}', '["Units can gift minutes"]'),
      ('chg_simplify', 'proj_q', 'Simplify the home page to a plain list', NULL, 'compiling', 5, 3, 'usr_s', '${T}', '${T}', '[]');
    INSERT INTO candidates (id, change_id, base_generation, status, created_at, updated_at)
      VALUES ('cand_board', 'chg_board', 3, 'promoted', '${T}', '${T}'), ('cand_own', 'chg_own', 2, 'promoted', '${T}', '${T}');`);
  const events: EventEnvelope[] = [];
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
    run: async () => ({
      meta: { changes: Number(db.prepare(sql).run(...(params as never[])).changes) },
    }),
  });
  const env = {
    DB: { prepare: (sql: string) => statement(sql) },
    RESOURCE_SHARD: {
      idFromName: (n: string) => n,
      get: () => ({
        appendEvents: async (list: EventEnvelope[]) => {
          for (const e of list) events.push(AnyEventEnvelope.parse(e));
        },
      }),
    },
  } as unknown as Env;
  const change = () =>
    db
      .prepare("SELECT status, clarification_json FROM changes WHERE id = 'chg_simplify'")
      .get() as {
      status: string;
      clarification_json: string | null;
    };
  return { env, events, change };
}

const reply = (removed: unknown[]) =>
  ({
    toolCalls: [{ function: { name: "review_removals", arguments: JSON.stringify({ removed }) } }],
    costUsd: 0.01,
  }) as unknown as CompletionResult;

describe("live-feature removal check", () => {
  const input = {
    changeId: "chg_simplify",
    goal: "Simplify the home page to a single plain list of units",
    criteria: [{ id: "c1", text: "Leaderboard and forms no longer appear on the home page" }],
    requesterUserId: "usr_s",
    round: 0,
  };

  it("asks the requester, naming the feature and whose it is, before anything is built", async () => {
    const h = harness();
    let seen = "";
    const outcome = await checkLiveRemovals(h.env, ctx, input, async (req) => {
      seen = JSON.stringify(req.messages);
      return reply([{ criterion: "L1c1", why: "The plain list drops the leaderboard" }]);
    });
    expect(outcome).toEqual({ costUsd: 0.01, stop: "needs_input" });
    // Only other people's live requests, without quality-gate criteria.
    expect(seen).toContain("weekly leaderboard");
    expect(seen).not.toContain("Units can gift minutes");
    expect(seen).not.toContain("typecheck, test and contract pass");
    const { status, clarification_json } = h.change();
    expect(status).toBe("needs_input");
    const question = JSON.parse(String(clarification_json));
    expect(question.questions[0]).toMatchObject({ id: KEEP_LIVE_QUESTION });
    expect(question.questions[0].text).toContain("Smoke's request");
    expect(question.relatedChangeId).toBe("chg_board");
    expect(h.events.map((e) => e.eventType)).toEqual(["conflict.reviewed"]);
  });

  it("asks nothing for a request without removal words, an invented citation, or a model failure", async () => {
    expect(mayRemove("Add a CSV export", [{ id: "c1", text: "A CSV file downloads" }])).toBe(false);
    const h = harness();
    expect(
      await checkLiveRemovals(h.env, ctx, input, async () =>
        reply([{ criterion: "L9c9", why: "x" }]),
      ),
    ).toEqual({ costUsd: 0.01, stop: null });
    expect(
      await checkLiveRemovals(h.env, ctx, input, async () => {
        throw new Error("gateway down");
      }),
    ).toEqual({ costUsd: 0, stop: null });
    expect(h.change().status).toBe("compiling");
  });
});
