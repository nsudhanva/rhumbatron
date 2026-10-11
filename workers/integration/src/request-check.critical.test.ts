// Real D1 migrations and SQL. Only the platform, model provider, queues, and event transport are adapted.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CompletionResult } from "@rhumbatron/model-router";
import { describe, expect, it, vi } from "vitest";
import { RequestScopes } from "../../coordinator/src/request-scopes.ts";
import { createCandidate } from "./candidate-create.ts";
import { clarifyChange } from "./change-commands.ts";
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
const request = (id: string, user: string): RequestInput => ({
  changeId: id,
  requesterUserId: user,
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
/** One arbiter run. `first` is the side shown as "a" in that run. */
const vote = (verdict: "prefer_a" | "prefer_b" | "ask") =>
  reply("arbitrate_requests", {
    verdict,
    rationale: "Fits the current app",
    citedCriteria: [{ side: "a", id: "c1" }],
    citedItems: ["conflict:1"],
  });
const toolOf = (req: unknown) =>
  (req as { tools?: { function: { name: string } }[] }).tools?.[0]?.function.name;
/**
 * Model replies by tool. Intake calls answer "nothing covered, one reading" unless overridden;
 * every other call takes the next scripted reply in order.
 */
function script(rest: CompletionResult[], intake: Partial<Record<string, CompletionResult>> = {}) {
  vi.mocked(meteredComplete)
    .mockReset()
    .mockImplementation(async (_meter, _gateway, req) => {
      const name = toolOf(req);
      if (name && intake[name]) return intake[name] as CompletionResult;
      if (name === "coverage_review") return reply(name, { items: [] });
      if (name === "list_interpretations")
        return reply(name, { interpretations: [], decisions: [] });
      const next = rest.shift();
      if (!next) throw Error(`unexpected model call ${name}`);
      return next;
    });
}
const callsOf = (name: string) =>
  vi.mocked(meteredComplete).mock.calls.filter((call) => toolOf(call[2]) === name);
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
  const sent: unknown[] = [];
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
        return {
          id,
          status: async () => ({ status: "waiting" }),
          sendEvent: async (event: unknown) => sent.push(event),
        };
      },
    },
    EVIDENCE: { put: async (key: string, value: string) => stored.set(key, value) },
    AGENT_WAKEUPS: { sendBatch: async (list: unknown[]) => dispatched.push(...list) },
  } as unknown as Env;
  const add = (r: RequestInput, status = "compiling") => {
    db.prepare(
      "INSERT INTO changes (id, project_id, goal, status, base_generation, budget_usd, created_by, created_at, updated_at) VALUES (?, 'p', ?, ?, 0, 1, ?, ?, ?)",
    ).run(r.changeId, r.goal, status, r.requesterUserId, now, now);
    scopes.admit(r.changeId, { requesterUserId: r.requesterUserId, requesterRank: 10 });
  };
  const row = (id: string) =>
    db.prepare("SELECT * FROM changes WHERE id = ?").get(id) as Record<string, unknown>;
  const scope = (r: RequestInput) =>
    scopes.register({ ...r, requesterRank: 10, registeredAt: now });
  const steps: string[] = [];
  const sleeps: string[] = [];
  /** Called on each wait; the default lets the day pass with no event. */
  let onWait: (name: string) => Promise<void> = async () => {
    throw Error("timed out");
  };
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
    async waitForEvent(name: string) {
      steps.push(name);
      await onWait(name);
      return { payload: {}, timestamp: new Date(), type: "clarification" };
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
    sent,
    run,
    setWait: (hook: (name: string) => Promise<void>) => {
      onWait = hook;
    },
  };
}

describe("request selection by the system on real SQLite", () => {
  it("persists one review and one arbitration per pair and reuses them on retry", async () => {
    const h = harness();
    const a = request("chg_a", "alice");
    const b = request("chg_b", "bob");
    h.add(a);
    h.add(b);
    let calls = 0;
    const replies = [conflict(), vote("prefer_a"), vote("prefer_b")];
    const complete = async () => {
      calls++;
      return replies.shift() as CompletionResult;
    };
    const first = await checkRequestPair(h.env, ctx, a, b, complete);
    expect(first).toEqual({ costUsd: 0.03, excluded: ["c1"], stop: null });
    expect(await checkRequestPair(h.env, ctx, a, b, complete)).toEqual({ ...first, costUsd: 0 });
    expect(calls).toBe(3);
    expect(h.row("chg_b")).toMatchObject({
      outcome: "not_selected",
      outcome_winner_change_id: "chg_a",
      outcome_decided_by: "system:arbiter",
    });
    const stored = h.db.prepare("SELECT * FROM request_conflicts").all();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ policy: "system_arbiter", decided_by: "system:arbiter" });
    expect(JSON.stringify(stored)).not.toContain("private reasoning");
    expect(h.db.prepare("SELECT decision_type, verdict FROM change_decisions").all()).toMatchObject(
      [{ decision_type: "REQUEST_ARBITER", verdict: "prefer_a" }],
    );
  });
  it("does not repeat a provider call when saving its result fails, and asks the later requester", async () => {
    const h = harness();
    const a = request("chg_a", "alice");
    const b = request("chg_b", "bob");
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
      stop: "needs_input",
    });
    expect(calls).toBe(1);
    expect(h.row(b.changeId).status).toBe("needs_input");
    expect(JSON.parse(String(h.row(b.changeId).clarification_json))).toMatchObject({
      kind: "conflict",
      relatedChangeId: "chg_a",
      round: 1,
    });
  });
  it("asks the later requester on an unsupported review or a disagreeing arbiter, never deciding by role", async () => {
    for (const replies of [
      [
        reply("review_requests", {
          verdict: "conflicting",
          conflicts: [{ a: "unknown", b: "c1", why: "unsupported" }],
        }),
      ],
      // Both runs prefer the side shown first: position bias, not agreement.
      [conflict(), vote("prefer_a"), vote("prefer_a")],
      [conflict(), vote("ask"), vote("ask")],
    ]) {
      const h = harness();
      const a = request("chg_a", "alice");
      const b = request("chg_b", "bob");
      h.add(a);
      h.add(b);
      const result = await checkRequestPair(
        h.env,
        ctx,
        a,
        b,
        async () => replies.shift() as CompletionResult,
      );
      expect(result.stop).toBe("needs_input");
      expect(h.row(b.changeId).status).toBe("needs_input");
      expect(h.row(a.changeId).status).toBe("compiling");
    }
  });
  it("asks about a cited duplicate with the quoted criterion, and refuses an invented quote", async () => {
    for (const quote of ["sorts chg_a", "sorts by popularity"]) {
      const h = harness();
      const a = request("chg_a", "alice");
      const b = request("chg_b", "bob");
      h.add(a);
      h.add(b);
      await checkRequestPair(h.env, ctx, a, b, async () =>
        reply("review_requests", {
          verdict: "duplicate",
          conflicts: [],
          covered: [{ a: "c1", b: "c1", quote }],
        }),
      );
      const asked = JSON.parse(String(h.row("chg_b").clarification_json));
      if (quote === "sorts chg_a") {
        expect(asked).toMatchObject({ kind: "duplicate", relatedChangeId: "chg_a" });
        expect(asked.questions[0].text).toContain('"sorts chg_a"');
      } else {
        expect(asked.kind).toBe("conflict");
      }
    }
  });
  it("cancels earlier tasks and Candidates when the same requester supersedes them", async () => {
    const h = harness();
    const a = request("chg_a", "alice");
    const b = request("chg_b", "alice");
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
    const a = request("chg_a", "alice");
    const b = request("chg_b", "alice");
    h.add(a, "releasing");
    h.add(b);
    h.db.exec(
      `INSERT INTO candidates (id, change_id, base_generation, status, created_at, updated_at) VALUES ('cand_a', 'chg_a', 0, 'promoted', '${now}', '${now}')`,
    );
    await checkRequestPair(h.env, ctx, a, b, async () => conflict());
    expect(h.row(a.changeId).status).toBe("releasing");
    expect(h.row(b.changeId).outcome).toBe("replaces");
  });
  it("refuses recomposition of a losing, waiting, or duplicate Change before creating a Candidate", async () => {
    for (const [status, outcome] of [
      ["not_selected", null],
      ["cancelled", null],
      ["needs_input", null],
      ["running", "not_selected"],
      ["running", "duplicate"],
    ] as const) {
      const h = harness();
      const a = request("chg_a", "alice");
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
});

describe("ChangeWorkflow with the intake gate on real SQLite", () => {
  it("plans once for independent requests and dispatches selected tasks", async () => {
    const h = harness();
    const a = {
      ...request("chg_a", "alice"),
      criteria: [{ id: "c1", text: "Cart works" }],
      resources: ["cart:checkout"],
    };
    h.add(a);
    h.scope(a);
    h.add(request("chg_b", "bob"), "created");
    script([graph()]);
    expect(await h.run("chg_b")).toMatchObject({ tasks: 1, ready: 1 });
    expect(callsOf("submit_work_graph")).toHaveLength(1);
    expect(h.row("chg_b")).toMatchObject({ status: "running", outcome: null });
    expect(h.steps.indexOf("intake review")).toBeLessThan(h.steps.indexOf("plan work graph"));
    const planned = JSON.parse(h.stored.values().next().value ?? "{}");
    expect(planned.criteria).toEqual([
      { id: "c1", text: "Sort products" },
      { id: "c2", text: "Cart stays available" },
    ]);
    expect(h.db.prepare("SELECT decision_type, verdict FROM change_decisions").all()).toMatchObject(
      [{ decision_type: "INTAKE", verdict: "clear" }],
    );
  });
  it("replans only the selected criteria, or stops entirely when all criteria lost", async () => {
    for (const partial of [true, false]) {
      const h = harness();
      const a = request("chg_a", "alice");
      h.add(a);
      h.scope(a);
      h.add(request("chg_b", "bob"), "created");
      script([
        graph(partial ? undefined : ["Sort products"]),
        conflict(),
        vote("prefer_a"),
        vote("prefer_b"),
        graph(["Cart stays available"]),
      ]);
      const result = await h.run("chg_b");
      if (partial) {
        expect(result).toMatchObject({ ready: 1 });
        expect(h.row("chg_b")).toMatchObject({ status: "running", outcome: "partially_selected" });
        expect(h.scopes.scope("chg_b")?.criteria).toEqual([
          { id: "c2", text: "Cart stays available" },
        ]);
        expect(JSON.stringify(callsOf("submit_work_graph")[1]?.[2])).toContain("Excluded criteria");
        expect(h.dispatched).toHaveLength(1);
        // Intake (2 coverage + 1 clarity), plan, review, 2 arbiter runs, replan: 8 x $0.01.
        const body = (h.dispatched[0] as { body: { payload: { budgetRemainingUsd: number } } })
          .body;
        expect(body.payload.budgetRemainingUsd).toBeCloseTo(0.92);
      } else {
        expect(result).toEqual({ status: "not_selected" });
        expect(h.scopes.scope("chg_b")).toBeNull();
        expect(h.dispatched).toHaveLength(0);
      }
    }
  });
  it("stops the card request fully, keeps an independent extra, and asks on a bad dependent", async () => {
    const owner = {
      ...request("chg_a", "alice"),
      goal: "Show the recipe list as a compact table with one row per recipe",
      criteria: [{ id: "c1", text: "Home page shows recipes as a table with one row per recipe" }],
    };
    const cards = [
      "Recipe list renders as a grid of large cards, three per row",
      "Each card shows the recipe title",
    ];
    const review = (dependentOnConflict?: unknown) =>
      reply("review_requests", {
        verdict: "conflicting",
        conflicts: [{ a: "c1", b: "c1", why: "Table rows versus a card grid" }],
        ...(dependentOnConflict ? { dependentOnConflict } : {}),
      });
    for (const [extra, reviewed, expected] of [
      [[], review(), "not_selected"],
      [[], review([{ side: "b", id: "c2", on: "c1" }]), "not_selected"],
      [["Add a print button to each recipe"], review(), "partially_selected"],
      [[], review([{ side: "b", id: "c2", on: "c9" }]), "needs_input"],
    ] as const) {
      const h = harness();
      h.add(owner);
      h.scope(owner);
      h.add(
        { ...request("chg_b", "bob"), goal: "Design: show the recipe list as cards" },
        "created",
      );
      const arbiter = expected === "needs_input" ? [] : [vote("prefer_a"), vote("prefer_b")];
      script([graph([...cards, ...extra]), reviewed, ...arbiter, graph([...extra])]);
      // The question is never answered here: after 7 days the request is cancelled.
      const result = await h.run("chg_b");
      if (expected === "partially_selected") {
        expect(h.row("chg_b")).toMatchObject({ status: "running", outcome: "partially_selected" });
        expect(h.scopes.scope("chg_b")?.criteria).toEqual([
          { id: "c3", text: "Add a print button to each recipe" },
        ]);
        expect(h.dispatched).toHaveLength(1);
      } else if (expected === "needs_input") {
        expect(result).toEqual({ status: "cancelled" });
        expect(h.row("chg_b")).toMatchObject({
          status: "cancelled",
          blocked_reason: "No answer within 7 days",
        });
        expect(h.dispatched).toHaveLength(0);
      } else {
        expect(result).toEqual({ status: expected });
        expect(h.row("chg_b").status).toBe(expected);
        expect(h.dispatched).toHaveLength(0);
      }
      if (expected !== "needs_input") {
        const stored = h.db.prepare("SELECT review_json FROM request_conflicts").get() as {
          review_json: string;
        };
        expect(JSON.parse(stored.review_json).excluded).toEqual({
          changeId: "chg_b",
          criterionIds: ["c1", "c2"],
        });
      }
    }
  });
  it("records the earlier loser's dependent criteria for the UI", async () => {
    const h = harness();
    const a = {
      ...request("chg_a", "bob"),
      criteria: [
        { id: "c1", text: "Recipe list renders as a grid of large cards" },
        { id: "c2", text: "Each card shows the recipe title" },
        { id: "c3", text: "Add a print button" },
      ],
    };
    const b = {
      ...request("chg_b", "alice"),
      criteria: [{ id: "c1", text: "Home page shows recipes as a table" }],
    };
    h.add(a);
    h.add(b);
    const replies = [
      reply("review_requests", {
        verdict: "conflicting",
        conflicts: [{ a: "c1", b: "c1", why: "Cards versus table" }],
      }),
      vote("prefer_b"),
      vote("prefer_a"),
    ];
    const result = await checkRequestPair(
      h.env,
      ctx,
      a,
      b,
      async () => replies.shift() as CompletionResult,
    );
    expect(result).toMatchObject({ excluded: [], stop: null });
    expect(h.row("chg_a").status).toBe("not_selected");
    const stored = h.db.prepare("SELECT review_json FROM request_conflicts").get() as {
      review_json: string;
    };
    expect(JSON.parse(stored.review_json).excluded).toEqual({
      changeId: "chg_a",
      criterionIds: ["c1", "c2"],
    });
  });
  it("waits ten times for unscoped earlier work, then asks instead of building", async () => {
    const h = harness();
    h.add(request("chg_a", "alice"));
    h.add(request("chg_b", "bob"), "created");
    script([graph(), reply("review_requests", { verdict: "abstain" })]);
    expect(await h.run("chg_b")).toEqual({ status: "cancelled" });
    expect(h.sleeps).toHaveLength(10);
    expect(h.dispatched).toHaveLength(0);
    expect(callsOf("review_requests")[0]?.[2]).toMatchObject({
      tier: "sonnet",
      maxOutputTokens: 1200,
    });
  });
  it("asks before planning, then plans with the answer in the goal", async () => {
    const h = harness();
    h.add({ ...request("chg_b", "bob"), goal: "Add kanban feature" }, "created");
    // The first wait gets the requester's answer through the clarify command.
    h.setWait(async (name) => {
      if (name !== "wait for answer intake 0") throw Error("timed out");
      const outcome = await clarifyChange(h.env, {
        changeId: "chg_b",
        actorUserId: "bob",
        request: { answers: [{ questionId: "q1", text: "One kanban board per mission day" }] },
      });
      expect(outcome).toMatchObject({ status: "recorded", round: 1, changeStatus: "compiling" });
    });
    h.started.add("chg_b");
    script([graph()]);
    expect(await h.run("chg_b")).toMatchObject({ tasks: 1 });
    expect(h.steps).toContain("ask for input");
    expect(h.sent).toEqual([{ type: "clarification", payload: { round: 1 } }]);
    // Rule: "Add kanban feature" names one object, so it asks without a model deciding.
    expect(callsOf("submit_work_graph")).toHaveLength(1);
    expect(JSON.stringify(callsOf("submit_work_graph")[0]?.[2])).toContain(
      "One kanban board per mission day",
    );
    expect(h.row("chg_b")).toMatchObject({ status: "running", clarification_json: null });
    expect(JSON.parse(String(h.row("chg_b").clarification_answers_json))).toMatchObject([
      { round: 1, questionId: "q1", answeredBy: "bob" },
    ]);
  });
});

describe("clarify command on real SQLite", () => {
  const asked = (h: ReturnType<typeof harness>, kind = "unclear", related: string | null = null) =>
    h.db
      .prepare("UPDATE changes SET status = 'needs_input', clarification_json = ? WHERE id = ?")
      .run(
        JSON.stringify({
          kind,
          summary: "s",
          questions: [{ id: "q1", text: "What is different?" }],
          relatedChangeId: related,
          relatedGoal: related ? "Sort chg_a" : null,
          askedAt: now,
          round: 1,
        }),
        "chg_b",
      );
  it("records one answer per round, refuses unknown questions, and wakes the workflow once", async () => {
    const h = harness();
    h.add(request("chg_b", "bob"));
    asked(h);
    h.started.add("chg_b");
    expect(
      await clarifyChange(h.env, {
        changeId: "chg_b",
        actorUserId: "bob",
        request: { answers: [{ questionId: "q9", text: "x" }] },
      }),
    ).toMatchObject({ status: "refused", reason: "unknown_question" });
    const answer = {
      changeId: "chg_b",
      actorUserId: "bob",
      request: { answers: [{ questionId: "q1", text: "A board per day" }] },
    };
    const [one, two] = await Promise.all([
      clarifyChange(h.env, answer),
      clarifyChange(h.env, answer),
    ]);
    expect([one.status, two.status].sort()).toEqual(["recorded", "recorded"]);
    expect([one, two].filter((o) => o.status === "recorded" && o.repeated)).toHaveLength(1);
    expect(JSON.parse(String(h.row("chg_b").clarification_answers_json))).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
    expect(h.row("chg_b").status).toBe("compiling");
  });
  it("withdraws a duplicate as cancelled with the reason and the related Change", async () => {
    const h = harness();
    h.add(request("chg_a", "alice"), "running");
    h.add(request("chg_b", "bob"));
    asked(h, "duplicate", "chg_a");
    h.started.add("chg_b");
    expect(
      await clarifyChange(h.env, {
        changeId: "chg_b",
        actorUserId: "bob",
        request: { action: "withdraw" },
      }),
    ).toMatchObject({ status: "recorded", changeStatus: "cancelled", action: "withdraw" });
    expect(h.row("chg_b")).toMatchObject({
      status: "cancelled",
      outcome: "duplicate",
      outcome_winner_change_id: "chg_a",
      blocked_reason: "Withdrawn by the requester",
    });
    expect(h.row("chg_a").status).toBe("running");
  });
  it("continues a Change whose first workflow already ended in a new instance", async () => {
    const h = harness();
    h.add(request("chg_b", "bob"));
    asked(h, "conflict", null);
    // A Change asked before the gate existed: its first instance has already completed.
    h.started.add("chg_b");
    const get = h.env.CHANGE_WORKFLOW.get.bind(h.env.CHANGE_WORKFLOW);
    h.env.CHANGE_WORKFLOW.get = async (id: string) =>
      id === "chg_b"
        ? ({ id, status: async () => ({ status: "complete" }) } as unknown as WorkflowInstance)
        : get(id);
    await clarifyChange(h.env, {
      changeId: "chg_b",
      actorUserId: "bob",
      request: { action: "proceed_anyway" },
    });
    expect([...h.started]).toEqual(["chg_b", "chg_b_r1"]);
    expect(h.sent).toEqual([]);
  });
});
