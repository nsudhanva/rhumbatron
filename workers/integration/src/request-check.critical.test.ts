// Real D1 migrations and SQL. Only the platform, model provider, queues, and event transport are adapted.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CompletionResult } from "@rhumbatron/model-router";
import { describe, expect, it, vi } from "vitest";
import { RequestScopes } from "../../coordinator/src/request-scopes.ts";
import { createCandidate } from "./candidate-create.ts";
import { overrideRequest } from "./change-commands.ts";
import { recomposeStaleCandidate } from "./recompose.ts";
import { checkRequestPair } from "./request-check.ts";
import type { RequestInput } from "./request-policy.ts";

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    constructor(
      _ctx: unknown,
      protected env: Env,
    ) {}
  },
}));
vi.mock("@rhumbatron/model-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rhumbatron/model-router")>()),
  meteredComplete: vi.fn(),
}));
const { meteredComplete } = await import("@rhumbatron/model-router");
const { ChangeWorkflow } = await import("./change-workflow.ts");
const now = "2026-10-10T00:00:00Z";
const ctx = {
  projectId: "p",
  orgId: "o",
  projectSlug: "shop",
  changeId: "chg_b",
  baseGeneration: 0,
};
const request = (id: string, user: string, rank: number): RequestInput => ({
  changeId: id,
  requesterUserId: user,
  requesterRank: rank,
  goal: `Sort ${id}`,
  criteria: [{ id: "c1", text: `GET /api/products sorts ${id}` }],
  resources: ["products:sort"],
  scoped: true,
});
function reply(toolName: string, args: unknown): CompletionResult {
  const toolCalls: CompletionResult["toolCalls"] = [
    { id: "call", type: "function", function: { name: toolName, arguments: JSON.stringify(args) } },
  ];
  return {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    tier: "sonnet",
    content: null,
    toolCalls,
    message: { role: "assistant", content: "private reasoning", tool_calls: toolCalls },
    finishReason: "tool_use",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.01,
    latencyMs: 1,
    gatewayLogId: "log",
  };
}
const conflict = () =>
  reply("review_requests", {
    verdict: "conflicting",
    conflicts: [{ a: "c1", b: "c1", why: "Different sort orders" }],
  });
const graph = (criteria = ["Sort products", "Cart stays available"]) =>
  reply("submit_work_graph", {
    acceptanceCriteria: criteria,
    invariants: [],
    riskTier: "low",
    tasks: [
      {
        key: "t1",
        title: "Implement selected criteria",
        kind: "implement",
        objective: "Implement the selected feature",
        semanticResources: ["products:sort"],
        dependsOn: [],
        acceptanceCriteria: criteria,
        riskTier: "low",
        complexity: "small",
        touchesAuthorization: false,
        touchesBilling: false,
        touchesMigration: false,
      },
    ],
  });

function harness() {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  const directory = join(import.meta.dirname, "../../../migrations/d1");
  for (const file of readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(directory, file), "utf8"));
  db.exec(
    `INSERT INTO projects (id, org_id, name, slug, status, canonical_generation, created_at, updated_at) VALUES ('p', 'o', 'Shop', 'shop', 'active', 0, '${now}', '${now}')`,
  );
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
  const scopes = new RequestScopes({
    exec(sql: string, ...params: unknown[]) {
      const result = execute(sql, params);
      return { toArray: () => result.results };
    },
  } as unknown as SqlStorage);
  scopes.migrate();
  const events: unknown[] = [];
  const started = new Set<string>();
  const dispatched: unknown[] = [];
  const stored = new Map<string, string>();
  const env = {
    DB: {
      prepare: (sql: string) => statement(sql),
      batch: async (statements: { sql: string; params: unknown[] }[]) => {
        db.exec("BEGIN");
        try {
          const result = statements.map(({ sql, params }) => execute(sql, params));
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
    PROJECT_ROOT: {
      idFromName: (name: string) => name,
      get: () => ({
        admit: async (id: string, requester?: { requesterUserId: string; requesterRank: number }) =>
          scopes.admit(id, requester),
        registerScope: async (input: Parameters<RequestScopes["register"]>[0]) =>
          scopes.register(input),
        updateScope: async (input: Parameters<RequestScopes["update"]>[0]) => scopes.update(input),
        getScope: async (id: string) => scopes.scope(id),
        release: async (id: string) => scopes.release(id),
        getCanonical: async () => null,
      }),
    },
    RESOURCE_SHARD: {
      idFromName: (name: string) => name,
      get: () => ({ appendEvents: async (list: unknown[]) => events.push(...list) }),
    },
    CHANGE_WORKFLOW: {
      create: async ({ id }: { id: string }) => {
        if (started.has(id)) throw Error("exists");
        started.add(id);
      },
      get: async (id: string) => {
        if (!started.has(id)) throw Error("missing");
        return { id };
      },
    },
    EVIDENCE: { put: async (key: string, value: string) => stored.set(key, value) },
    AGENT_WAKEUPS: { sendBatch: async (list: unknown[]) => dispatched.push(...list) },
  } as unknown as Env;
  const add = (r: RequestInput, status = "compiling") => {
    db.prepare(
      "INSERT INTO changes (id, project_id, goal, status, base_generation, budget_usd, created_by, requester_rank, created_at, updated_at) VALUES (?, 'p', ?, ?, 0, 1, ?, ?, ?, ?)",
    ).run(r.changeId, r.goal, status, r.requesterUserId, r.requesterRank, now, now);
    scopes.admit(r.changeId, r);
  };
  const row = (id: string) =>
    db.prepare("SELECT * FROM changes WHERE id = ?").get(id) as Record<string, unknown>;
  const scope = (r: RequestInput) => scopes.register({ ...r, registeredAt: now });
  const steps: string[] = [];
  const sleeps: string[] = [];
  const step = {
    async do(name: string, configOrRun: unknown, callback?: () => Promise<unknown>) {
      steps.push(name);
      const run = callback ?? (configOrRun as () => Promise<unknown>);
      const value = await run();
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    },
    async sleep(name: string) {
      sleeps.push(name);
    },
    async sleepUntil() {},
    async waitForEvent() {
      throw new Error("not used by this Workflow");
    },
  } as Parameters<InstanceType<typeof ChangeWorkflow>["run"]>[1];
  const run = (id: string) =>
    new ChangeWorkflow({} as ExecutionContext, env).run(
      { payload: { changeId: id } } as Parameters<InstanceType<typeof ChangeWorkflow>["run"]>[0],
      step,
    );
  return {
    db,
    env,
    add,
    row,
    scope,
    scopes,
    events,
    started,
    dispatched,
    stored,
    steps,
    sleeps,
    run,
  };
}

describe("request selection and owner override on real SQLite", () => {
  it("persists one review per sorted pair and reuses it on retry without another model call", async () => {
    const h = harness();
    const a = request("chg_a", "alice", 0);
    const b = request("chg_b", "bob", 10);
    h.add(a);
    h.add(b);
    let calls = 0;
    const complete = async () => {
      calls++;
      return conflict();
    };
    const first = await checkRequestPair(h.env, ctx, a, b, complete);
    expect(first).toEqual({ costUsd: 0.01, excluded: ["c1"], stop: null });
    expect(await checkRequestPair(h.env, ctx, a, b, complete)).toEqual(first);
    expect(calls).toBe(1);
    expect(h.row("chg_b")).toMatchObject({
      outcome: "not_selected",
      outcome_winner_change_id: "chg_a",
      outcome_decided_by: "policy:priority_wins",
    });
    const stored = h.db.prepare("SELECT * FROM request_conflicts").all();
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain("private reasoning");
  });
  it("does not repeat a provider call when saving its result fails", async () => {
    const h = harness();
    const a = request("chg_a", "alice", 0);
    const b = request("chg_b", "bob", 10);
    h.add(a);
    h.add(b);
    const prepare = h.env.DB.prepare.bind(h.env.DB);
    let fail = true;
    h.env.DB.prepare = (sql: string) => {
      if (fail && sql.startsWith("UPDATE request_conflicts SET verdict")) {
        fail = false;
        throw Error("D1 transient failure");
      }
      return prepare(sql);
    };
    let calls = 0;
    const complete = async () => {
      calls++;
      return conflict();
    };
    await expect(checkRequestPair(h.env, ctx, a, b, complete)).rejects.toThrow(
      "D1 transient failure",
    );
    expect(await checkRequestPair(h.env, ctx, a, b, complete)).toMatchObject({
      stop: "awaiting_owner",
    });
    expect(calls).toBe(1);
    expect(h.row(b.changeId).outcome_reason).toBe("review could not confirm compatibility");
  });
  it("awaits the owner on an unsupported review and on equal rank, without rejecting earlier work", async () => {
    for (const unsupported of [true, false]) {
      const h = harness();
      const a = request("chg_a", "alice", 0);
      const b = request("chg_b", "bob", unsupported ? 10 : 0);
      h.add(a);
      h.add(b);
      const result = await checkRequestPair(h.env, ctx, a, b, async () =>
        unsupported
          ? reply("review_requests", {
              verdict: "conflicting",
              conflicts: [{ a: "unknown", b: "c1", why: "unsupported" }],
            })
          : conflict(),
      );
      expect(result.stop).toBe("awaiting_owner");
      expect(h.row(b.changeId).status).toBe("awaiting_owner");
      expect(h.row(a.changeId).status).toBe("compiling");
    }
  });
  it("cancels earlier tasks and Candidates when the same requester supersedes them", async () => {
    const h = harness();
    const a = request("chg_a", "alice", 0);
    const b = request("chg_b", "alice", 0);
    h.add(a, "running");
    h.add(b);
    h.db.exec(
      `INSERT INTO tasks (id, change_id, kind, status, created_at, updated_at) VALUES ('t', 'chg_a', 'implement', 'running', '${now}', '${now}'); INSERT INTO candidates (id, change_id, base_generation, status, created_at, updated_at) VALUES ('cand_a', 'chg_a', 0, 'verified', '${now}', '${now}')`,
    );
    await checkRequestPair(h.env, ctx, a, b, async () => conflict());
    expect(h.row(a.changeId)).toMatchObject({ status: "not_selected", outcome: "not_selected" });
    expect(h.db.prepare("SELECT status FROM tasks WHERE id = 't'").get()).toMatchObject({
      status: "cancelled",
    });
    expect(h.db.prepare("SELECT status FROM candidates WHERE id = 'cand_a'").get()).toMatchObject({
      status: "rejected",
    });
    expect(h.scopes.scope(a.changeId)).toBeNull();
  });
  it("preserves a promoted earlier loser and records replaces on the later winner", async () => {
    const h = harness();
    const a = request("chg_a", "alice", 0);
    const b = request("chg_b", "alice", 0);
    h.add(a, "releasing");
    h.add(b);
    h.db.exec(
      `INSERT INTO candidates (id, change_id, base_generation, status, created_at, updated_at) VALUES ('cand_a', 'chg_a', 0, 'promoted', '${now}', '${now}')`,
    );
    await checkRequestPair(h.env, ctx, a, b, async () => conflict());
    expect(h.row(a.changeId).status).toBe("releasing");
    expect(h.row(b.changeId).outcome).toBe("replaces");
  });
  it("creates and starts one attributed override Change under concurrent calls, and resumes after a lost reply", async () => {
    const h = harness();
    const a = request("chg_a", "alice", 0);
    const b = request("chg_b", "bob", 10);
    h.add(a, "running");
    h.add(b, "not_selected");
    h.db
      .prepare(
        "INSERT INTO request_conflicts (id, project_id, change_a, change_b, verdict, winner_change_id, loser_change_id, created_at) VALUES ('rc', 'p', 'chg_a', 'chg_b', 'conflicting', 'chg_a', 'chg_b', ?)",
      )
      .run(now);
    const input = { changeId: b.changeId, actorUserId: "alice" };
    const [one, two] = await Promise.all([
      overrideRequest(h.env, input),
      overrideRequest(h.env, input),
    ]);
    expect(one.status).toBe("recorded");
    expect(two).toMatchObject({
      status: "recorded",
      changeId: one.status === "recorded" ? one.changeId : "",
    });
    if (one.status !== "recorded") throw Error("override refused");
    expect(h.row(one.changeId)).toMatchObject({
      created_by: "bob",
      requester_rank: 10,
      supersedes_change_id: "chg_b",
      budget_usd: 1,
      outcome_decided_by: "alice",
    });
    expect(h.row("chg_b")).toMatchObject({ status: "not_selected", outcome: "overridden" });
    expect(h.row("chg_a")).toMatchObject({
      status: "not_selected",
      outcome_reason: "Replaced by the owner's choice",
      outcome_decided_by: "alice",
    });
    expect(h.started.size).toBe(1);
    expect(
      h.db
        .prepare(
          "SELECT policy, decided_by, winner_change_id FROM request_conflicts WHERE winner_change_id = ?",
        )
        .get(one.changeId),
    ).toMatchObject({
      policy: "owner_override",
      decided_by: "alice",
      winner_change_id: one.changeId,
    });
    expect(await overrideRequest(h.env, input)).toMatchObject({
      changeId: one.changeId,
      repeated: true,
    });
    // Even if the old winner's scope is encountered after a cached registration, the owner's choice wins.
    const next = { ...b, changeId: one.changeId, supersedesChangeId: b.changeId };
    const decision = await checkRequestPair(
      h.env,
      { ...ctx, changeId: next.changeId },
      a,
      next,
      async () => {
        throw Error("must not re-review owner choice");
      },
    );
    expect(decision).toMatchObject({ excluded: [], stop: null });
  });
  it("resumes an override after its Workflow start fails and leaves promoted winners untouched", async () => {
    const h = harness();
    const a = request("chg_a", "alice", 0);
    const b = request("chg_b", "bob", 10);
    h.add(a, "completed");
    h.add(b, "not_selected");
    h.db
      .prepare(
        "INSERT INTO request_conflicts (id, project_id, change_a, change_b, verdict, winner_change_id, loser_change_id, created_at) VALUES ('rc', 'p', 'chg_a', 'chg_b', 'conflicting', 'chg_a', 'chg_b', ?)",
      )
      .run(now);
    h.db.exec(
      `INSERT INTO candidates (id, change_id, base_generation, status, created_at, updated_at) VALUES ('cand_a', 'chg_a', 0, 'promoted', '${now}', '${now}')`,
    );
    const original = h.env.CHANGE_WORKFLOW.create;
    h.env.CHANGE_WORKFLOW.create = async () => {
      throw Error("transport failure");
    };
    await expect(
      overrideRequest(h.env, { changeId: b.changeId, actorUserId: "alice" }),
    ).rejects.toThrow("transport failure");
    h.env.CHANGE_WORKFLOW.create = original;
    expect(
      await overrideRequest(h.env, { changeId: b.changeId, actorUserId: "alice" }),
    ).toMatchObject({ status: "recorded", repeated: true });
    expect(h.started.size).toBe(1);
    expect(h.row(a.changeId)).toMatchObject({ status: "completed", outcome: null });
    expect(
      await overrideRequest(h.env, { changeId: a.changeId, actorUserId: "alice" }),
    ).toMatchObject({ status: "refused", reason: "not_overridable" });
  });
  it("records the owner choice on a failed winner that never promoted", async () => {
    const h = harness();
    const a = request("chg_a", "alice", 0);
    const b = request("chg_b", "bob", 10);
    h.add(a, "failed");
    h.add(b, "not_selected");
    h.db
      .prepare(
        "INSERT INTO request_conflicts (id, project_id, change_a, change_b, verdict, winner_change_id, loser_change_id, created_at) VALUES ('rc', 'p', 'chg_a', 'chg_b', 'conflicting', 'chg_a', 'chg_b', ?)",
      )
      .run(now);
    await overrideRequest(h.env, { changeId: b.changeId, actorUserId: "alice" });
    expect(h.row(a.changeId)).toMatchObject({
      status: "not_selected",
      outcome_reason: "Replaced by the owner's choice",
      outcome_decided_by: "alice",
    });
  });
  it("overrides an equal-rank pending choice and does not grant unrelated pairs owner priority", async () => {
    const h = harness();
    const a = request("chg_a", "alice", 10);
    const b = request("chg_b", "bob", 10);
    const c = request("chg_c", "carol", 0);
    h.add(a);
    h.add(b, "awaiting_owner");
    h.add(c);
    h.db
      .prepare(
        "INSERT INTO request_conflicts (id, project_id, change_a, change_b, verdict, created_at) VALUES ('rc', 'p', 'chg_a', 'chg_b', 'conflicting', ?)",
      )
      .run(now);
    const result = await overrideRequest(h.env, { changeId: b.changeId, actorUserId: "owner" });
    if (result.status !== "recorded") throw Error("override refused");
    expect(h.row(a.changeId).status).toBe("not_selected");
    let calls = 0;
    h.db.prepare("UPDATE changes SET status = 'compiling' WHERE id = ?").run(result.changeId);
    const next = { ...b, changeId: result.changeId, supersedesChangeId: b.changeId };
    await checkRequestPair(h.env, { ...ctx, changeId: next.changeId }, c, next, async () => {
      calls++;
      return conflict();
    });
    expect(calls).toBe(1);
    expect(h.row(next.changeId).outcome).toBe("not_selected");
  });
  it("refuses recomposition of a losing or overridden Change before creating a Candidate", async () => {
    for (const [status, outcome] of [
      ["not_selected", null],
      ["cancelled", null],
      ["awaiting_owner", null],
      ["running", "not_selected"],
      ["running", "overridden"],
    ] as const) {
      const h = harness();
      const a = request("chg_a", "alice", 0);
      h.add(a, status);
      h.db.prepare("UPDATE changes SET outcome = ? WHERE id = ?").run(outcome, a.changeId);
      h.db.exec(
        `INSERT INTO candidates (id, change_id, base_generation, status, created_at, updated_at) VALUES ('cand_a', 'chg_a', 0, 'stale', '${now}', '${now}')`,
      );
      expect(await recomposeStaleCandidate(h.env, "cand_a")).toMatchObject({
        status: "skipped",
        reason: "change_closed",
      });
      expect(await createCandidate(h.env, { changeId: a.changeId })).toMatchObject({
        status: "refused",
        reason: "change_closed",
      });
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM candidates").get()).toMatchObject({ n: 1 });
    }
  });
  it("plans once for independent requests and dispatches selected tasks", async () => {
    const h = harness();
    const a = {
      ...request("chg_a", "alice", 0),
      criteria: [{ id: "c1", text: "Cart works" }],
      resources: ["cart:checkout"],
    };
    h.add(a);
    h.scope(a);
    h.add(request("chg_b", "bob", 10), "created");
    vi.mocked(meteredComplete).mockResolvedValue(graph());
    expect(await h.run("chg_b")).toMatchObject({ tasks: 1, ready: 1 });
    expect(meteredComplete).toHaveBeenCalledTimes(1);
    expect(h.row("chg_b")).toMatchObject({ status: "running", outcome: null });
    const planned = JSON.parse(h.stored.values().next().value ?? "{}");
    expect(planned.criteria).toEqual([
      { id: "c1", text: "Sort products" },
      { id: "c2", text: "Cart stays available" },
    ]);
    vi.mocked(meteredComplete).mockClear();
  });
  it("replans only the selected criteria, or stops entirely when all criteria lost", async () => {
    for (const partial of [true, false]) {
      const h = harness();
      const a = request("chg_a", "alice", 0);
      h.add(a);
      h.scope(a);
      h.add(request("chg_b", "bob", 10), "created");
      vi.mocked(meteredComplete)
        .mockReset()
        .mockResolvedValueOnce(graph(partial ? undefined : ["Sort products"]))
        .mockResolvedValueOnce(conflict())
        .mockResolvedValueOnce(graph(["Cart stays available"]));
      const result = await h.run("chg_b");
      if (partial) {
        expect(result).toMatchObject({ ready: 1 });
        expect(h.row("chg_b")).toMatchObject({ status: "running", outcome: "partially_selected" });
        expect(h.scopes.scope("chg_b")?.criteria).toEqual([
          { id: "c2", text: "Cart stays available" },
        ]);
        expect(JSON.stringify(vi.mocked(meteredComplete).mock.calls[2]?.[2])).toContain(
          "Excluded criteria",
        );
        expect(h.dispatched).toHaveLength(1);
        expect(h.dispatched[0]).toMatchObject({ body: { payload: { budgetRemainingUsd: 0.97 } } });
      } else {
        expect(result).toEqual({ status: "not_selected" });
        expect(h.scopes.scope("chg_b")).toBeNull();
        expect(h.dispatched).toHaveLength(0);
      }
    }
  });
  it("waits ten times for unscoped earlier work, then fails closed without dispatch", async () => {
    const h = harness();
    h.add(request("chg_a", "alice", 0));
    h.add(request("chg_b", "bob", 10), "created");
    vi.mocked(meteredComplete)
      .mockReset()
      .mockResolvedValueOnce(graph())
      .mockResolvedValueOnce(reply("review_requests", { verdict: "abstain" }));
    expect(await h.run("chg_b")).toEqual({ status: "awaiting_owner" });
    expect(h.sleeps).toHaveLength(10);
    expect(h.dispatched).toHaveLength(0);
    expect(vi.mocked(meteredComplete).mock.calls[1]?.[2]).toMatchObject({
      tier: "sonnet",
      maxOutputTokens: 1200,
    });
  });
});
