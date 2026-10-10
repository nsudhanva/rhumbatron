// Conflict review orchestration (AGENTS.md sections 22.4, 32.3, 34.4.2, 44; P9-05, P9-06). Runs the
// real migrations and review SQL against SQLite (node:sqlite) with a scripted model. A budget
// refusal must leave the conflict unchanged and call no model; an applied dismissal must leave a
// Decision Receipt; an unsupported finding must not change state; a high-risk disagreement goes to
// Opus once, and each tier reviews a conflict at most once.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { detectConflicts } from "@rhumbatron/conflict";
import type { CompletionRequest, CompletionResult } from "@rhumbatron/model-router";
import type { Intent } from "@rhumbatron/protocol";
import { describe, expect, it, vi } from "vitest";

vi.mock("@rhumbatron/integration/events", () => ({
  appendChangeEvents: async () => undefined,
  qualify: (_ctx: unknown, resource: string) => `project:acme:${resource}`,
  changeEvent: async (_ctx: unknown, eventType: string, payload: unknown) => ({
    eventType,
    payload,
  }),
}));

const { reviewConflict } = await import("./conflict-review.ts");
const { conflictId } = await import("./conflicts.ts");

const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");
const NOW = "2026-10-09T12:00:00.000Z";
const ctx = {
  projectId: "prj_1",
  orgId: "org_1",
  projectSlug: "acme",
  changeId: "chg_1",
  baseGeneration: 1841,
};

function fakeD1() {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  const exec = (sql: string, params: unknown[]) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql) || /\breturning\b/i.test(sql)) {
      return { results: statement.all(...(params as never[])), meta: { changes: 0 } };
    }
    return {
      results: [],
      meta: { changes: Number(statement.run(...(params as never[])).changes) },
    };
  };
  const statement = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => exec(sql, params),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    all: async () => exec(sql, params),
  });
  const d1 = {
    prepare: (sql: string) => statement(sql),
    batch: async (list: { sql: string; params: unknown[] }[]) => {
      db.exec("BEGIN");
      try {
        const out = list.map((s) => exec(s.sql, s.params));
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, d1 };
}

const intent = (id: string, patch: Partial<Intent>): Intent => ({
  intentId: `int_${id}`,
  taskId: `tsk_${id}`,
  agentId: `agt_${id}`,
  summary: "Tune search ranking",
  semanticResources: ["catalog:search"],
  expectedFiles: [`src/search/${id}.ts`],
  expectedSymbols: [],
  expectedContractChanges: [
    { target: "GET /v1/search", kind: "modify", description: "Change search results" },
  ],
  expectedDataChanges: [],
  expectedSideEffects: [],
  assumptions: [],
  createdAt: NOW,
  ...patch,
});

/** Low risk: one resource, no data, auth, or release signal. */
const searchPair = [intent("a", {}), intent("b", { summary: "Add search filters" })];
/** Data semantics: both modify one table. */
const dataPair = [
  intent("c", {
    expectedDataChanges: [
      { entity: "wishlist_items", kind: "modify", model: "mutable_table", description: "" },
    ],
  }),
  intent("d", {
    expectedDataChanges: [
      { entity: "wishlist_items", kind: "modify", model: "mutable_table", description: "" },
    ],
  }),
];

type Reply = { verdict: string; rationale: string; citations: string[] } | string;

function setup(
  pair: Intent[],
  replies: Partial<Record<string, Reply>>,
  budgetUsd = 3,
  allowOpus = true,
) {
  const { db, d1 } = fakeD1();
  db.prepare(
    `INSERT INTO changes (id, project_id, goal, status, base_generation, budget_usd, created_by, created_at, updated_at)
     VALUES ('chg_1', 'prj_1', 'Goal', 'running', 1841, ?, 'usr_1', ?, ?)`,
  ).run(budgetUsd, NOW, NOW);
  for (const i of pair) {
    db.prepare(
      `INSERT INTO tasks (id, change_id, kind, status, task_key, title, created_at, updated_at)
       VALUES (?, 'chg_1', 'implement', 'completed', ?, 'Task', ?, ?)`,
    ).run(i.taskId, i.taskId.toUpperCase(), NOW, NOW);
    db.prepare(
      `INSERT INTO changesets (id, change_id, agent_id, base_generation, intent_json, status, created_at)
       VALUES (?, 'chg_1', ?, 1841, ?, 'proposed', ?)`,
    ).run(
      `cs_${i.intentId.slice(4)}`,
      i.agentId,
      JSON.stringify({ changeSet: { diffStat: "1 file changed", files: i.expectedFiles } }),
      NOW,
    );
  }
  const calls: { tier: string }[] = [];
  const events: unknown[] = [];
  const deps = {
    db: d1,
    now: () => NOW,
    intents: async () => pair,
    createChallenge: async () => true,
    emit: async (list: unknown[]) => {
      events.push(...list);
    },
    callModel: async (req: CompletionRequest): Promise<CompletionResult> => {
      calls.push({ tier: req.tier });
      const reply = replies[req.tier];
      const content = typeof reply === "string" ? reply : JSON.stringify(reply);
      return {
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        tier: req.tier,
        content,
        toolCalls: [],
        message: { role: "assistant", content },
        finishReason: "end_turn",
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.0015,
        latencyMs: 10,
        gatewayLogId: null,
      };
    },
    allowOpus,
    storePacket: async () => undefined,
    metric: () => undefined,
  };
  return { db, deps, calls, events };
}

async function record(db: DatabaseSync, pair: Intent[]) {
  const [report] = detectConflicts(pair, { includeDismissed: false });
  if (!report) throw new Error("no conflict");
  const id = await conflictId(report);
  const sides = pair.map((i) => ({
    intentId: i.intentId,
    taskId: i.taskId,
    taskKey: "",
    title: "",
  }));
  db.prepare(
    `INSERT INTO conflicts (id, change_id, resource, state, recommended_action, report_json, intents_json,
       review_json, fork_decision_json, challenge_id, created_at, updated_at)
     VALUES (?, 'chg_1', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    report.resource,
    report.state,
    report.recommendedAction,
    JSON.stringify(report),
    JSON.stringify(sides),
    JSON.stringify({
      state: report.state,
      recommendedAction: report.recommendedAction,
      decidedBy: "rules",
    }),
    JSON.stringify({ kind: "no_fork", reason: "needs_review" }),
    NOW,
    NOW,
  );
  return id;
}

const row = (db: DatabaseSync, id: string) =>
  db
    .prepare("SELECT state, recommended_action, review_json FROM conflicts WHERE id = ?")
    .get(id) as {
    state: string;
    recommended_action: string;
    review_json: string;
  };
const receipts = (db: DatabaseSync) =>
  db
    .prepare("SELECT decision_type, selected_tier, decided_by, receipt_json FROM decision_receipts")
    .all() as {
    decision_type: string;
    selected_tier: string;
    decided_by: string;
    receipt_json: string;
  }[];

describe("conflict review", () => {
  it("refuses at the Change budget: no model call, state unchanged", async () => {
    const t = setup(searchPair, { sonnet: "unused" }, 0.002);
    const id = await record(t.db, searchPair);
    t.db
      .prepare(
        `INSERT INTO task_runs (id, task_id, agent_id, attempt, tier, status, cost_usd, started_at)
         VALUES ('run_x', 'tsk_a', 'agt_a', 1, 'sonnet', 'completed', 0.0019, ?)`,
      )
      .run(NOW);
    expect(await reviewConflict(t.deps, ctx, id)).toEqual([]);
    expect(t.calls).toEqual([]);
    const after = row(t.db, id);
    expect(after).toMatchObject({ state: "suspected", recommended_action: "review" });
    expect(JSON.parse(after.review_json).reviews.sonnet).toMatchObject({
      status: "refused",
      reason: "max_cost_usd_per_change",
    });
    expect(receipts(t.db)).toEqual([]);
  });

  it("dismisses a benign overlap with a Decision Receipt, once per tier", async () => {
    const t = setup(searchPair, {
      sonnet: {
        verdict: "benign_overlap",
        rationale: "Ranking and filters change disjoint parts of the search response.",
        citations: ["intent:int_a:contract:0", "changeset:cs_b"],
      },
    });
    const id = await record(t.db, searchPair);
    expect(await reviewConflict(t.deps, ctx, id)).toEqual(["sonnet"]);
    const after = row(t.db, id);
    expect(after).toMatchObject({ state: "resolved", recommended_action: "dismiss" });
    expect(JSON.parse(after.review_json)).toMatchObject({ decidedBy: "sonnet" });
    const [receipt] = receipts(t.db);
    expect(receipt).toMatchObject({
      decision_type: "CONFLICT_REVIEW",
      selected_tier: "sonnet",
      decided_by: "rules",
    });
    expect(JSON.parse(receipt?.receipt_json ?? "{}")).toMatchObject({
      verdict: "benign_overlap",
      outcome: "dismissed",
      stateBefore: "suspected",
      stateAfter: "resolved",
      support: "supported",
    });
    expect(t.events).toHaveLength(1);
    // Already reviewed: no second Sonnet call.
    expect(await reviewConflict(t.deps, ctx, id)).toEqual([]);
    expect(t.calls).toHaveLength(1);
  });

  it("records an unsupported finding without changing state", async () => {
    const t = setup(searchPair, {
      sonnet: {
        verdict: "benign_overlap",
        rationale: "Looks fine.",
        citations: ["evidence:invented-id"],
      },
    });
    const id = await record(t.db, searchPair);
    await reviewConflict(t.deps, ctx, id);
    const after = row(t.db, id);
    expect(after).toMatchObject({ state: "suspected", recommended_action: "review" });
    const review = JSON.parse(after.review_json);
    expect(review.decidedBy).toBe("rules");
    expect(review.reviews.sonnet).toMatchObject({
      support: "unsupported",
      outcome: "rejected_unsupported",
    });
  });

  it("escalates a high-risk conflict to Opus, which decides once", async () => {
    const t = setup(dataPair, {
      sonnet: {
        verdict: "benign_overlap",
        rationale: "Both update the same table.",
        citations: ["intent:int_c:data:0"],
      },
      opus: {
        verdict: "needs_more_evidence",
        rationale: "Concurrent updates may lose writes; tests can decide.",
        citations: ["intent:int_c:data:0", "intent:int_d:data:0"],
      },
    });
    const id = await record(t.db, dataPair);
    expect(await reviewConflict(t.deps, ctx, id)).toEqual(["sonnet", "opus"]);
    expect(t.calls.map((c) => c.tier)).toEqual(["sonnet", "opus"]);
    const after = row(t.db, id);
    // Sonnet's dismissal waited for Opus; Opus asked evidence to decide, so the conflict forks.
    expect(after).toMatchObject({ state: "fork_required", recommended_action: "fork_candidates" });
    const review = JSON.parse(after.review_json);
    expect(review.reviews.sonnet).toMatchObject({ deferred: true, verdict: "benign_overlap" });
    expect(review.reviews.opus).toMatchObject({ outcome: "needs_evidence", support: "supported" });
    expect(
      receipts(t.db)
        .map((r) => r.selected_tier)
        .sort(),
    ).toEqual(["opus", "sonnet"]);
    // Review spend counts against the Change budget.
    const spent = t.db
      .prepare(
        "SELECT json_extract(review_json, '$.reviews.sonnet.costUsd') + json_extract(review_json, '$.reviews.opus.costUsd') AS n FROM conflicts WHERE id = ?",
      )
      .get(id) as { n: number };
    expect(spent.n).toBeCloseTo(0.003);
    expect(await reviewConflict(t.deps, ctx, id)).toEqual([]);
    expect(t.calls).toHaveLength(2);
  });

  it("keeps Sonnet's verdict final and calls no Opus while Opus is off", async () => {
    const t = setup(
      dataPair,
      {
        sonnet: {
          verdict: "needs_more_evidence",
          rationale: "Concurrent updates may lose writes; tests can decide.",
          citations: ["intent:int_c:data:0", "intent:int_d:data:0"],
        },
      },
      3,
      false,
    );
    const id = await record(t.db, dataPair);
    expect(await reviewConflict(t.deps, ctx, id)).toEqual(["sonnet"]);
    expect(t.calls.map((c) => c.tier)).toEqual(["sonnet"]);
    const review = JSON.parse(row(t.db, id).review_json);
    expect(review.reviews.sonnet.deferred).toBeUndefined();
    expect(review.reviews.opus).toBeUndefined();
  });
});
