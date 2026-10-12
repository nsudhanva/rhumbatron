// Code page edit sessions (ADR 0029). Invariants: a command is refused at the monthly Sandbox cap
// before the Sandbox starts; Sandbox time is billed once for overlapping commands; an expired
// session refuses the request, kills its processes in the awake Sandbox, and deletes its fork.
import { beforeEach, describe, expect, it, vi } from "vitest";

const box = vi.hoisted(() => ({ commands: [] as string[] }));

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: () => ({
    async exec(command: string) {
      box.commands.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  }),
}));

vi.mock("./human-edit.ts", () => ({}));
vi.mock("./code-store.ts", () => ({}));

const { awakeSeconds, execCodeSessionCommand, reserveSessionSeconds } = await import(
  "./code-sessions.ts"
);

const SESSION = `edit_${"ab".repeat(16)}`;

function fakeEnv(options: { atCap?: boolean }) {
  const now = new Date().toISOString();
  const row = {
    id: SESSION,
    project_id: "proj_11111111-aaaa",
    user_id: "usr_owner",
    base_generation: 3,
    base_commit: "c".repeat(40),
    base_tree: "a".repeat(40),
    repo: `edit-${"ab".repeat(16)}`,
    status: "open",
    revision: 0,
    exec_started_at: null,
    sandbox_awake_until: null as number | null,
    created_at: now,
    last_used_at: now,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    change_id: null,
    fork_deleted_at: null,
    org_id: "org_1",
    project_status: "active",
  };
  const runs: { sql: string; args: unknown[] }[] = [];
  const deleted: string[] = [];
  const statement = (sql: string, args: unknown[] = []) => ({
    sql,
    args,
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => {
      if (sql.includes("FROM code_sessions s JOIN projects p")) return row;
      if (sql.includes("INSERT INTO usage_counters")) {
        runs.push({ sql, args });
        return options.atCap ? null : { count: 1 };
      }
      return null;
    },
    all: async () => ({ results: [] }),
    run: async () => {
      runs.push({ sql, args });
      return { meta: { changes: 1 } };
    },
  });
  type Statement = ReturnType<typeof statement>;
  const env = {
    DB: {
      prepare: (sql: string) => statement(sql),
      batch: async (stmts: Statement[]) => Promise.all(stmts.map((s) => s.run())),
    },
    ARTIFACTS: {
      delete: async (name: string) => {
        deleted.push(name);
        return true;
      },
    },
    RESOURCE_SHARD: {
      idFromName: () => "shard",
      get: () => ({ appendEvents: async () => ({ inserted: 1 }) }),
    },
    SANDBOX: {},
    SANDBOX_MONTHLY_SECONDS: "72000",
  } as unknown as Env;
  return { env, runs, deleted, row };
}

beforeEach(() => {
  box.commands.length = 0;
});

describe("terminal commands and the Sandbox meter", () => {
  it("refuses a command at the monthly cap before the Sandbox starts, and releases the lock", async () => {
    const fake = fakeEnv({ atCap: true });
    const outcome = await execCodeSessionCommand(fake.env, {
      sessionId: SESSION,
      userId: "usr_owner",
      command: "bun test",
    });
    expect(outcome).toMatchObject({ status: "refused", reason: "sandbox_cap" });
    expect(box.commands).toEqual([]);
    const reserve = fake.runs.find((r) => r.sql.includes("INSERT INTO usage_counters"));
    // 480 s reserved against the 72,000 s binding.
    expect(reserve?.args).toEqual([expect.stringMatching(/^\d{4}-\d{2}$/), 480, 480, 480, 72000]);
    expect(fake.runs.some((r) => r.sql.includes("SET exec_started_at = NULL"))).toBe(true);
    expect(fake.runs.some((r) => r.sql.includes("code_session_commands"))).toBe(false);
  });

  it("refuses a cwd outside the checkout before any lock or reservation", async () => {
    const fake = fakeEnv({});
    const outcome = await execCodeSessionCommand(fake.env, {
      sessionId: SESSION,
      userId: "usr_owner",
      command: "ls",
      cwd: "../cand-1",
    });
    expect(outcome).toMatchObject({ status: "refused", reason: "invalid_path" });
    expect(fake.runs).toEqual([]);
  });

  it("refuses the session of another user as not found", async () => {
    const fake = fakeEnv({});
    const outcome = await execCodeSessionCommand(fake.env, {
      sessionId: SESSION,
      userId: "usr_admin",
      command: "ls",
    });
    expect(outcome).toMatchObject({ status: "refused", reason: "not_found" });
  });

  it("reserves against the 36,000 s fallback when the binding is absent", async () => {
    const seen: unknown[] = [];
    const db = {
      prepare: () => ({
        bind: (...args: unknown[]) => {
          seen.push(...args);
          return { first: async () => null };
        },
      }),
    } as unknown as D1Database;
    expect(await reserveSessionSeconds(db, 480)).toBe(false);
    expect(seen.at(-1)).toBe(36_000);
  });

  it("bills command time plus one idle tail, and overlapping tails once", () => {
    const first = awakeSeconds({ startedAt: 0, endedAt: 10_000, awakeUntil: null });
    expect(first).toEqual({ seconds: 130, awakeUntil: 130_000 });
    // The next command starts inside the tail: only the extension is billed.
    const second = awakeSeconds({
      startedAt: 60_000,
      endedAt: 70_000,
      awakeUntil: first.awakeUntil,
    });
    expect(second).toEqual({ seconds: 60, awakeUntil: 190_000 });
    // After the Sandbox slept: the full command and tail again.
    expect(
      awakeSeconds({ startedAt: 500_000, endedAt: 505_000, awakeUntil: 190_000 }).seconds,
    ).toBe(125);
  });
});

describe("session expiry", () => {
  it("ends an idle session on its next request: kills its processes, deletes the fork", async () => {
    const fake = fakeEnv({});
    fake.row.last_used_at = new Date(Date.now() - 11 * 60_000).toISOString();
    fake.row.sandbox_awake_until = Date.now() + 60_000;
    const outcome = await execCodeSessionCommand(fake.env, {
      sessionId: SESSION,
      userId: "usr_owner",
      command: "ls",
    });
    expect(outcome).toMatchObject({ status: "refused", reason: "expired" });
    // No command and no reservation: only the stop of the session processes and its directory.
    expect(box.commands).toHaveLength(1);
    expect(box.commands[0]).toContain("kill -s KILL -1");
    expect(fake.runs.some((r) => r.sql.includes("INSERT INTO usage_counters"))).toBe(false);
    expect(fake.deleted).toEqual([`edit-${"ab".repeat(16)}`]);
    const ended = fake.runs.find((r) => r.sql.includes("UPDATE code_sessions SET status"));
    expect(ended?.args.slice(0, 2)).toEqual(["expired", "idle"]);
  });
});
