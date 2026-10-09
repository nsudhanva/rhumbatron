// Section 44 limits at their admission points (AGENTS.md sections 44, 61, 23.3). Each limit must
// refuse exactly at the boundary, start no expensive work when it refuses, keep state durable, and
// name the exact limit. Runs the real migrations and admission SQL against SQLite (node:sqlite).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nextStep } from "@rhumbatron/model-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  appendChangeEvents: vi.fn(async () => undefined),
  getSandbox: vi.fn(),
}));
vi.mock("agents", () => ({ getAgentByName: async () => ({ start: spies.start }) }));
vi.mock("@rhumbatron/integration/events", () => ({
  appendChangeEvents: spies.appendChangeEvents,
  changeEvent: async (_ctx: unknown, eventType: string) => ({ eventType }),
}));
vi.mock("@cloudflare/sandbox", () => ({ getSandbox: spies.getSandbox }));

const {
  admitAgent,
  admitSandbox,
  CHANGE_LIMITS,
  chooseProvider,
  limitAttempts,
  limitStop,
  markProviderFlag,
  releaseSandbox,
} = await import("./limits.ts");
const { handleWake } = await import("./wake-consumer.ts");
const { openWorkspace } = await import("./workspace.ts");

const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");
const NOW = "2026-10-09T12:00:00.000Z";

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
    batch: async (list: { sql: string; params: unknown[] }[]) =>
      list.map((s) => exec(s.sql, s.params)),
  } as unknown as D1Database;
  db.exec(`
    INSERT INTO projects (id, org_id, name, slug, status, created_at, updated_at)
      VALUES ('proj_1', 'org_1', 'Acme Shop', 'acme-shop', 'active', '${NOW}', '${NOW}');
    INSERT INTO changes (id, project_id, goal, status, base_generation, budget_usd, created_by, created_at, updated_at)
      VALUES ('chg_1', 'proj_1', 'Add shared wishlists', 'running', 1841, 3, 'usr_1', '${NOW}', '${NOW}');
  `);
  return { db, d1 };
}

/** Adds `n` Tasks with `status` to chg_1. */
function tasks(db: DatabaseSync, prefix: string, n: number, status: string) {
  for (let i = 0; i < n; i++) {
    db.prepare(
      `INSERT INTO tasks (id, change_id, kind, status, wake_sent_at, created_at, updated_at)
       VALUES (?, 'chg_1', 'implement', ?, ?, ?, ?)`,
    ).run(`${prefix}${i}`, status, NOW, NOW, NOW);
  }
}

const taskRow = (db: DatabaseSync, id: string) =>
  db
    .prepare("SELECT status, blocked_limit, blocked_reason, wake_sent_at FROM tasks WHERE id = ?")
    .get(id) as {
    status: string;
    blocked_limit: string | null;
    blocked_reason: string | null;
    wake_sent_at: string | null;
  };

beforeEach(() => {
  spies.start.mockClear();
  spies.appendChangeEvents.mockClear();
  spies.getSandbox.mockReset();
});

describe("max active reasoning agents per Change", () => {
  it("admits the 8th agent and refuses the 9th, which waits and names the limit", async () => {
    const { db, d1 } = fakeD1();
    tasks(db, "task_run", CHANGE_LIMITS.maxActiveAgentsPerChange - 1, "running");
    tasks(db, "task_ready", 2, "ready");
    const admit = (taskId: string) =>
      admitAgent(d1, { taskId, changeId: "chg_1", agentId: `agt_${taskId}`, now: NOW });

    expect(await admit("task_ready0")).toEqual({ kind: "admitted" });
    expect(await admit("task_ready1")).toEqual({ kind: "deferred", active: 8 });

    const waiting = taskRow(db, "task_ready1");
    expect(waiting).toMatchObject({
      status: "ready",
      blocked_limit: "max_active_agents_per_change",
      // No wake in flight: the next dispatch after a slot frees wakes it again.
      wake_sent_at: null,
    });
    expect(waiting.blocked_reason).toContain("limit 8 per Change");

    // A slot frees: the same Task is admitted and the limit note clears.
    db.exec("UPDATE tasks SET status = 'completed' WHERE id = 'task_run0'");
    expect(await admit("task_ready1")).toEqual({ kind: "admitted" });
    expect(taskRow(db, "task_ready1")).toMatchObject({ status: "assigned", blocked_limit: null });
  });

  it("lets concurrent admissions take the last slot only once", async () => {
    const { db, d1 } = fakeD1();
    tasks(db, "task_run", CHANGE_LIMITS.maxActiveAgentsPerChange - 1, "running");
    tasks(db, "task_ready", 3, "ready");
    const outcomes = await Promise.all(
      [0, 1, 2].map((i) =>
        admitAgent(d1, { taskId: `task_ready${i}`, changeId: "chg_1", agentId: "agt", now: NOW }),
      ),
    );
    expect(outcomes.filter((o) => o.kind === "admitted")).toHaveLength(1);
    const active = db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('assigned', 'running')")
      .get() as { n: number };
    expect(active.n).toBe(CHANGE_LIMITS.maxActiveAgentsPerChange);
  });

  it("a deferred wake starts no agent run and records no events", async () => {
    const { db, d1 } = fakeD1();
    tasks(db, "task_run", CHANGE_LIMITS.maxActiveAgentsPerChange, "running");
    tasks(db, "task_ready", 1, "ready");
    const env = {
      DB: d1,
      METRICS: { writeDataPoint: vi.fn() },
      RESOURCE_SHARD: {},
      AGENT: {},
    } as unknown as Env;
    const outcome = await handleWake(env, {
      commandId: "cmd_task_ready0_ready",
      commandType: "agent.wake",
      projectId: "proj_1",
      changeId: "chg_1",
      taskId: "task_ready0",
      attempt: 0,
      createdAt: NOW,
      payload: {
        eventId: "evt_1",
        agentId: "agt_1",
        reason: "task_ready",
        contextCursor: "evt_1",
        priority: 5,
        budgetRemainingUsd: 0,
      },
    });
    expect(outcome).toBe("deferred");
    expect(spies.start).not.toHaveBeenCalled();
    expect(spies.appendChangeEvents).not.toHaveBeenCalled();
    expect(taskRow(db, "task_ready0").status).toBe("ready");
  });
});

describe("max active coding Sandboxes per Change", () => {
  /** `n` running runs of chg_1; the first `open` hold an open workspace. */
  function runs(db: DatabaseSync, n: number, open: number) {
    tasks(db, "task_ws", n, "running");
    for (let i = 0; i < n; i++) {
      db.prepare(
        `INSERT INTO task_runs (id, task_id, agent_id, attempt, tier, status, started_at, workspace_opened_at)
         VALUES (?, ?, 'agt', 1, 'sonnet', 'running', ?, ?)`,
      ).run(`run_${i}`, `task_ws${i}`, NOW, i < open ? NOW : null);
    }
  }

  it("opens the 4th Sandbox, refuses the 5th, and reopens after one closes", async () => {
    const { db, d1 } = fakeD1();
    runs(db, 5, CHANGE_LIMITS.maxActiveSandboxesPerChange - 1);
    const admit = (runId: string) => admitSandbox(d1, { runId, changeId: "chg_1", now: NOW });

    expect(await admit("run_3")).toBe(true);
    expect(await admit("run_4")).toBe(false);
    await releaseSandbox(d1, "run_0", NOW);
    expect(await admit("run_4")).toBe(true);
    // Releasing twice is safe and frees nothing more.
    await releaseSandbox(d1, "run_0", NOW);
    expect(await admit("run_0")).toBe(false);
  });

  it("a refused workspace forks nothing, reserves no Sandbox time, and names the limit", async () => {
    const { db, d1 } = fakeD1();
    runs(db, 5, CHANGE_LIMITS.maxActiveSandboxesPerChange);
    const artifacts = { get: vi.fn(), delete: vi.fn() };
    const ws = await openWorkspace({ DB: d1, ARTIFACTS: artifacts, SANDBOX: {} } as never, {
      projectId: "proj_1",
      change: { changeId: "chg_1", taskId: "task_ws4" },
      runId: "run_4",
      baseCommit: "abc",
    });
    expect(ws).toMatchObject({ refused: "max_active_sandboxes_per_change" });
    expect(artifacts.get).not.toHaveBeenCalled();
    expect(spies.getSandbox).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_counters").get()).toEqual({ n: 0 });
    expect(taskRow(db, "task_ws4")).toMatchObject({
      status: "running",
      blocked_limit: "max_active_sandboxes_per_change",
    });
  });
});

describe("max model attempts per Task at one tier", () => {
  const run = (tier: "haiku" | "sonnet" | "opus", failure_kind: string | null) => ({
    tier,
    failure_kind,
  });

  it("refuses a third attempt at a tier: escalates after an intelligence failure", () => {
    // timeout, then agent_failed at haiku: nextStep alone would retry haiku a third time.
    const previous = [run("haiku", "timeout"), run("haiku", "agent_failed")];
    const step = nextStep("haiku", [
      { tier: "haiku", kind: "timeout" },
      { tier: "haiku", kind: "agent_failed" },
    ]);
    expect(step).toMatchObject({ action: "retry", tier: "haiku" });
    expect(limitAttempts(step, previous)).toEqual({
      action: "escalate",
      tier: "sonnet",
      reason: "max_attempts_at_haiku",
    });
  });

  it("stops for re-plan at the top tier, and allows the second attempt", () => {
    const opus = [run("opus", "agent_failed"), run("opus", "timeout")];
    expect(limitAttempts({ action: "retry", tier: "opus", reason: "x" }, opus)).toEqual({
      action: "stop",
      reason: "max_attempts_per_tier",
    });
    expect(
      limitAttempts({ action: "retry", tier: "sonnet", reason: "x" }, [run("sonnet", "timeout")]),
    ).toMatchObject({ action: "retry", tier: "sonnet" });
  });

  it("names the exact limit for a budget stop, and none for an ordinary failure", () => {
    expect(limitStop("max_attempts_per_tier")).toMatchObject({ limit: "max_attempts_per_tier" });
    expect(limitStop("two_failures_at_opus")?.text).toContain("2 attempts per Task per tier");
    expect(limitStop("budget_exhausted")?.text).toContain("400 calls per UTC day");
    expect(limitStop("repeated_transport_failure")).toBeNull();
  });
});

// Gemini overflow (ADR 0016): the provider of a new run comes from today's D1 counters.
describe("chooseProvider", () => {
  const DAY = "2026-10-09";
  const count = (db: DatabaseSync, counter: string, n: number, day = DAY) =>
    db
      .prepare("INSERT INTO usage_counters (day, counter, count) VALUES (?, ?, ?)")
      .run(day, counter, n);

  it("uses OpenRouter until it is used up today, then Vertex", async () => {
    const { db, d1 } = fakeD1();
    const choose = () => chooseProvider(d1, { day: DAY, vertexConfigured: true });
    expect((await choose()).provider).toBe("openrouter");
    count(db, "openrouter-calls", 44);
    expect((await choose()).provider).toBe("openrouter");
    db.prepare("UPDATE usage_counters SET count = 45 WHERE counter = 'openrouter-calls'").run();
    expect(await choose()).toEqual({
      provider: "google-vertex-ai",
      reason: "openrouter_daily_cap",
    });
  });

  it("moves to Vertex after a rate limit today, and back to OpenRouter the next day", async () => {
    const { d1 } = fakeD1();
    await markProviderFlag(d1, DAY, "openrouter-exhausted");
    await markProviderFlag(d1, DAY, "openrouter-exhausted");
    expect((await chooseProvider(d1, { day: DAY, vertexConfigured: true })).provider).toBe(
      "google-vertex-ai",
    );
    expect((await chooseProvider(d1, { day: "2026-10-10", vertexConfigured: true })).provider).toBe(
      "openrouter",
    );
  });

  it("starts nothing once the Vertex spend cap was hit today, and names the $9 per 30 days cap", async () => {
    const { d1 } = fakeD1();
    await markProviderFlag(d1, DAY, "openrouter-exhausted");
    await markProviderFlag(d1, DAY, "vertex-spend-limited");
    const choice = await chooseProvider(d1, { day: DAY, vertexConfigured: true });
    expect(choice).toEqual({ provider: null, reason: "vertex_spend_limit" });
    const stop = limitStop(choice.reason);
    expect(stop?.limit).toBe("vertex_spend_limit");
    expect(stop?.text).toContain("$9 per 30 days");
    // ADR 0017: each environment names its own share of the cap from its binding.
    expect(limitStop(choice.reason, "4.5")?.text).toContain("$4.50 per 30 days");
    // The spend-limit failure stops the Task; it never schedules a retry.
    expect(nextStep("haiku", [{ tier: "haiku", kind: "spend_limited" }])).toEqual({
      action: "stop",
      reason: "vertex_spend_limit",
    });
    expect(limitAttempts({ action: "stop", reason: "vertex_spend_limit" }, [])).toEqual({
      action: "stop",
      reason: "vertex_spend_limit",
    });
  });
});
