// Section 44 limits at their admission points (AGENTS.md sections 44, 61, 23.3). Each limit must
// refuse exactly at the boundary, start no expensive work when it refuses, keep state durable, and
// name the exact limit. Runs the real migrations and admission SQL against SQLite (node:sqlite).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  meteredComplete,
  monthSpentUsd,
  nextStep,
  reserveSpend,
  settleSpend,
} from "@rhumbatron/model-router";
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

const { admitAgent, admitSandbox, CHANGE_LIMITS, limitAttempts, limitStop, releaseSandbox } =
  await import("./limits.ts");
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

// Monthly Anthropic budget (ADR 0021, rule 50): the only hard money stop. It must refuse exactly
// at the budget, refuse atomically, settle to the exact cost, and stop without another provider.
describe("monthly Anthropic budget", () => {
  const MONTH = "2026-10";

  it("refuses the reservation that would pass the budget, and settles to the exact cost", async () => {
    const { d1 } = fakeD1();
    expect(await reserveSpend(d1, MONTH, 6, 10)).toBe(true);
    expect(await reserveSpend(d1, MONTH, 4, 10)).toBe(true);
    // Exactly at the budget: one more micro-dollar is refused, and nothing is written.
    expect(await reserveSpend(d1, MONTH, 0.000001, 10)).toBe(false);
    expect(await monthSpentUsd(d1, MONTH)).toBe(10);
    // The 4 USD call cost 1.25: settling frees the rest for the next call.
    await settleSpend(d1, MONTH, 4, 1.25);
    expect(await monthSpentUsd(d1, MONTH)).toBeCloseTo(7.25, 6);
    expect(await reserveSpend(d1, MONTH, 2.75, 10)).toBe(true);
    expect(await reserveSpend(d1, "2026-11", 2.75, 10)).toBe(true);
  });

  it("stops the call before the network with spend_limited, and the Task with a budget stop", async () => {
    const { d1 } = fakeD1();
    expect(await reserveSpend(d1, new Date().toISOString().slice(0, 7), 10, 10)).toBe(true);
    let sent = 0;
    const error = await meteredComplete(
      { db: d1, budgetUsd: 10 },
      {
        accountId: "a",
        gatewayId: "g",
        apiKey: "k",
        workspaceId: "w",
        fetch: async () => {
          sent += 1;
          return new Response("{}");
        },
      },
      { tier: "haiku", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 10 },
    ).catch((e: unknown) => e);
    expect(sent).toBe(0);
    expect((error as { kind?: string }).kind).toBe("spend_limited");
    const step = nextStep("haiku", [{ tier: "haiku", kind: "spend_limited" }]);
    expect(step).toEqual({ action: "stop", reason: "monthly_model_spend" });
    expect(limitAttempts(step, [])).toEqual(step);
    const stop = limitStop(step.action === "stop" ? step.reason : "", "15");
    expect(stop?.limit).toBe("monthly_model_spend");
    expect(stop?.text).toContain("$15 per calendar month");
    expect(stop?.text).toContain("No other provider is tried");
    expect(limitStop("monthly_model_spend")?.text).toContain("$10 per calendar month");
  });
});
