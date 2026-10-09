// Dead-letter retry (AGENTS.md sections 42.7, 60). A retry must send the same command (same
// command_id; consumers are idempotent on it) to the Queue it came from, exactly once under
// concurrent clicks, with its Task unblocked first so the command is relevant when it arrives.
// A failed send must leave the dead letter open and the Task blocked. Runs the real migrations and
// SQL against SQLite (node:sqlite).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { type DeadLetterRow, dismissDeadLetter, retryDeadLetter } from "./dead-letters.ts";

const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");
const NOW = "2026-10-09T12:00:00.000Z";
const ID = `dl_${"a".repeat(32)}`;

const command = {
  commandId: "cmd_task_1_ready",
  commandType: "agent.wake",
  projectId: "proj_1",
  changeId: "chg_1",
  taskId: "task_1",
  attempt: 0,
  createdAt: "2026-10-09T11:00:00.000Z",
  payload: { eventId: "evt_1", agentId: "agt_1", reason: "task_ready" },
};

function setup(sendFails = false) {
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
    batch: async (list: { sql: string; params: unknown[] }[]) =>
      list.map((s) => exec(s.sql, s.params)),
  } as unknown as D1Database;
  db.exec(`
    INSERT INTO tasks (id, change_id, kind, status, assigned_agent_id, blocked_limit, blocked_reason, created_at, updated_at)
      VALUES ('task_1', 'chg_1', 'implement', 'blocked', NULL, 'dead_letter', 'Dead-lettered', '${NOW}', '${NOW}');
  `);
  db.prepare(
    `INSERT INTO dead_letters (id, command_id, command_type, queue, project_id, change_id, task_id,
       payload_json, error, attempt, dead_count, first_seen_at, last_seen_at)
     VALUES (?, ?, 'agent.wake', 'agent-wakeups', 'proj_1', 'chg_1', 'task_1', ?, 'failed', 0, 1, ?, ?)`,
  ).run(ID, command.commandId, JSON.stringify(command), NOW, NOW);

  const sent = { wakeups: [] as unknown[], integration: [] as unknown[] };
  const queue = (into: unknown[]) => ({
    send: vi.fn(async (body: unknown) => {
      if (sendFails) throw new Error("Queues unavailable");
      into.push(body);
    }),
  });
  const env = {
    DB: d1,
    AGENT_WAKEUPS: queue(sent.wakeups),
    INTEGRATION_COMMANDS: queue(sent.integration),
  } as unknown as Pick<Env, "DB" | "AGENT_WAKEUPS" | "INTEGRATION_COMMANDS">;
  const row = () =>
    db.prepare("SELECT * FROM dead_letters WHERE id = ?").get(ID) as unknown as DeadLetterRow & {
      resolution: string | null;
    };
  const task = () =>
    db.prepare("SELECT status, blocked_limit FROM tasks WHERE id = 'task_1'").get() as {
      status: string;
      blocked_limit: string | null;
    };
  return { db, env, sent, row, task };
}

describe("dead-letter retry", () => {
  it("sends the same command ID to its original Queue and unblocks the Task", async () => {
    const { env, sent, row, task } = setup();
    const outcome = await retryDeadLetter(env, row(), "usr_1", NOW);

    expect(outcome.ok).toBe(true);
    expect(sent.integration).toEqual([]);
    expect(sent.wakeups).toEqual([{ ...command, attempt: 1 }]);
    expect(row()).toMatchObject({ resolution: "retried", resolved_by: "usr_1" });
    expect(task()).toEqual({ status: "ready", blocked_limit: null });
  });

  it("sends once when two operators retry at the same time", async () => {
    const { env, sent, row } = setup();
    const snapshot = row();
    const outcomes = await Promise.all([
      retryDeadLetter(env, snapshot, "usr_1", NOW),
      retryDeadLetter(env, snapshot, "usr_2", NOW),
    ]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.find((o) => !o.ok)).toMatchObject({ status: 409 });
    expect(sent.wakeups).toHaveLength(1);
  });

  it("keeps the dead letter open and the Task blocked when the send fails", async () => {
    const { env, row, task } = setup(true);
    const outcome = await retryDeadLetter(env, row(), "usr_1", NOW);
    expect(outcome).toMatchObject({ ok: false, status: 502 });
    expect(row()).toMatchObject({ resolved_at: null, resolution: null });
    expect(task()).toEqual({ status: "blocked", blocked_limit: "dead_letter" });
  });

  it("dismiss sends nothing, keeps the Task blocked, and refuses a later retry", async () => {
    const { env, sent, row, task } = setup();
    expect(await dismissDeadLetter(env.DB, row(), "usr_1", NOW)).toBe(true);
    expect(await dismissDeadLetter(env.DB, row(), "usr_1", NOW)).toBe(false);
    expect(await retryDeadLetter(env, row(), "usr_1", NOW)).toMatchObject({ status: 409 });
    expect(sent.wakeups).toEqual([]);
    expect(task()).toEqual({ status: "blocked", blocked_limit: "dead_letter" });
  });
});
