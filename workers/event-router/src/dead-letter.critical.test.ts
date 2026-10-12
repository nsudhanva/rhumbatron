// Poison command (P13-10). A command in the dead-letter Queue must be
// recorded once per failure, block the Task that waits on it (never a running one), and stay
// resolved after an operator acts, even when the dead-letter message is delivered again. Also the
// re-admission rule: a Task deferred at the agent limit is dispatched when a slot frees.
// Runs the real migrations and SQL against SQLite (node:sqlite).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  appendChangeEvents: vi.fn(async (_shards: unknown, _ctx: unknown, _events: unknown[]) => {}),
}));
vi.mock("@rhumbatron/integration/events", () => ({
  appendChangeEvents: spies.appendChangeEvents,
  changeEvent: async (
    _ctx: unknown,
    eventType: string,
    payload: unknown,
    extra: { taskId?: string; key?: string },
  ) => ({ eventType, payload, taskId: extra.taskId, key: extra.key }),
}));

const { consumeDeadLetters, originQueue, recordDeadLetter } = await import("./dead-letter.ts");
const { hasDeferredReady } = await import("./causal.ts");

const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");
const NOW = "2026-10-09T12:00:00.000Z";

/** D1 over node:sqlite: prepare/bind/run/first/all and an all-or-nothing batch. */
function fakeD1() {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  const exec = (sql: string, params: unknown[]) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql)) {
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
  db.exec(`
    INSERT INTO projects (id, org_id, name, slug, status, created_at, updated_at)
      VALUES ('proj_1', 'org_1', 'Acme Shop', 'acme-shop', 'active', '${NOW}', '${NOW}');
    INSERT INTO changes (id, project_id, goal, status, base_generation, budget_usd, created_by, created_at, updated_at)
      VALUES ('chg_1', 'proj_1', 'Add shared wishlists', 'running', 1841, 3, 'usr_1', '${NOW}', '${NOW}');
    INSERT INTO tasks (id, change_id, kind, status, created_at, updated_at)
      VALUES ('task_ready', 'chg_1', 'implement', 'ready', '${NOW}', '${NOW}'),
             ('task_running', 'chg_1', 'implement', 'running', '${NOW}', '${NOW}');
  `);
  const env = { DB: d1, RESOURCE_SHARD: {} } as unknown as Pick<Env, "DB" | "RESOURCE_SHARD">;
  return { db, env };
}

const wake = (taskId: string, attempt = 0) => ({
  commandId: `cmd_${taskId}_ready`,
  commandType: "agent.wake",
  projectId: "proj_1",
  changeId: "chg_1",
  taskId,
  attempt,
  createdAt: "2026-10-09T11:00:00.000Z",
  payload: {
    eventId: "evt_1",
    agentId: "agt_1",
    reason: "task_ready",
    contextCursor: "evt_1",
    priority: 5,
    budgetRemainingUsd: 0,
  },
});

const dispatch = {
  commandId: "cmd_evt1_dispatch",
  commandType: "change.dispatch",
  projectId: "proj_1",
  changeId: "chg_1",
  attempt: 0,
  createdAt: "2026-10-09T11:00:00.000Z",
  payload: {},
};

const rows = (db: DatabaseSync) =>
  db.prepare("SELECT command_id, dead_count, resolved_at FROM dead_letters").all();
const task = (db: DatabaseSync, id: string) =>
  db.prepare("SELECT status, blocked_limit, blocked_reason FROM tasks WHERE id = ?").get(id) as {
    status: string;
    blocked_limit: string | null;
    blocked_reason: string | null;
  };

beforeEach(() => spies.appendChangeEvents.mockClear());

describe("dead-letter consumer", () => {
  it("records a command once, blocks its ready Task, and ignores a redelivery", async () => {
    const { db, env } = fakeD1();
    expect(await recordDeadLetter(env, wake("task_ready"), NOW)).toBe("recorded");
    expect(await recordDeadLetter(env, wake("task_ready"), NOW)).toBe("duplicate");

    expect(rows(db)).toEqual([
      { command_id: "cmd_task_ready_ready", dead_count: 1, resolved_at: null },
    ]);
    expect(task(db, "task_ready")).toMatchObject({
      status: "blocked",
      blocked_limit: "dead_letter",
    });
    expect(task(db, "task_ready").blocked_reason).toContain("cmd_task_ready_ready");
    // The fact goes through the shard outbox with a stable key, so the outbox ignores the repeat.
    const keys = spies.appendChangeEvents.mock.calls.flatMap(([, , events]) =>
      (events as { eventType: string; key: string }[]).map((e) => `${e.eventType}:${e.key}`),
    );
    expect(new Set(keys)).toEqual(new Set(["task.failed:dead_letter:cmd_task_ready_ready:1"]));
  });

  it("never blocks a running Task: the dead letter is only a lost notification", async () => {
    const { db, env } = fakeD1();
    await recordDeadLetter(env, wake("task_running"), NOW);
    expect(task(db, "task_running")).toMatchObject({ status: "running", blocked_limit: null });
    expect(rows(db)).toHaveLength(1);
    expect(spies.appendChangeEvents).not.toHaveBeenCalled();
  });

  it("names the failure on the Change when the command has no Task", async () => {
    const { db, env } = fakeD1();
    await recordDeadLetter(env, dispatch, NOW);
    const change = db
      .prepare("SELECT status, blocked_limit FROM changes WHERE id = 'chg_1'")
      .get() as { status: string; blocked_limit: string };
    // Status is untouched: other flows keep their conditional transitions.
    expect(change).toEqual({ status: "running", blocked_limit: "dead_letter" });
    expect(db.prepare("SELECT queue FROM dead_letters").get()).toEqual({ queue: "integration" });
  });

  it("stays resolved after an operator acts, but reopens when the retried copy fails again", async () => {
    const { db, env } = fakeD1();
    await recordDeadLetter(env, wake("task_ready"), NOW);
    db.exec(`UPDATE dead_letters SET resolved_at = '${NOW}', resolution = 'retried'`);

    // The same dead-letter message delivered again: still resolved, no second count.
    expect(await recordDeadLetter(env, wake("task_ready"), NOW)).toBe("duplicate");
    expect(rows(db)).toEqual([
      { command_id: "cmd_task_ready_ready", dead_count: 1, resolved_at: NOW },
    ]);

    // The retried copy (attempt + 1, same command ID) dead-letters again: one row, reopened.
    expect(await recordDeadLetter(env, wake("task_ready", 1), NOW)).toBe("reopened");
    expect(rows(db)).toEqual([
      { command_id: "cmd_task_ready_ready", dead_count: 2, resolved_at: null },
    ]);
  });

  it("acks a malformed body and retries a storage failure", async () => {
    const { env } = fakeD1();
    const ok = { body: { nope: true }, ack: vi.fn(), retry: vi.fn() };
    const broken = {
      body: wake("task_ready"),
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const failing = {
      ...env,
      DB: {
        ...env.DB,
        batch: async () => {
          throw new Error("D1 down");
        },
      },
    } as unknown as typeof env;
    await consumeDeadLetters(env, [ok], () => {});
    await consumeDeadLetters(failing, [broken], () => {});
    expect(ok.ack).toHaveBeenCalledOnce();
    expect(broken.ack).not.toHaveBeenCalled();
    expect(broken.retry).toHaveBeenCalledOnce();
  });

  it("sends a retry back to the Queue the command came from", () => {
    expect(originQueue("agent.wake")).toBe("agent-wakeups");
    for (const type of ["change.dispatch", "candidate.verify", "project.provision"]) {
      expect(originQueue(type)).toBe("integration");
    }
    expect(originQueue("verification.start")).toBe("verification");
    expect(originQueue("release.start")).toBe("release");
  });
});

describe("agent-limit re-admission", () => {
  const row = (status: string, wake_sent_at: string | null, blocked_limit: string | null) =>
    ({
      id: "task_x",
      change_id: "chg_1",
      status,
      assigned_agent_id: null,
      semantic_resources_json: "[]",
      title: null,
      wake_sent_at,
      blocked_limit,
    }) as Parameters<typeof hasDeferredReady>[0][number];

  it("dispatches again only for a ready Task without a wake in flight", () => {
    expect(hasDeferredReady([row("ready", null, "max_active_agents_per_change")], "chg_1")).toBe(
      true,
    );
    // A late dispatch write set wake_sent_at after the deferral: still deferred.
    expect(hasDeferredReady([row("ready", NOW, "max_active_agents_per_change")], "chg_1")).toBe(
      true,
    );
    expect(hasDeferredReady([row("ready", NOW, null)], "chg_1")).toBe(false);
    expect(hasDeferredReady([row("running", null, null)], "chg_1")).toBe(false);
    expect(hasDeferredReady([row("ready", null, null)], "chg_other")).toBe(false);
  });
});
