// Stacked workspaces. A Task starts from its dependencies'
// published work in a fixed order; conflicting dependencies fail the open with nothing left behind
// (no fork, no Sandbox reservation, no slot); a restore after Sandbox loss repeats the same merges.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ExecResult = { exitCode: number; stdout: string; stderr: string };

/** Sandbox stand-in: one checkout whose HEAD is a deterministic function of the merges made. */
const box = vi.hoisted(() => ({
  head: null as string | null,
  conflicting: new Set<string>(),
  conflicted: [] as string[],
  commands: [] as string[],
  envs: [] as (Record<string, string> | undefined)[],
}));

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: () => ({
    async exec(command: string, opts: { env?: Record<string, string> } = {}): Promise<ExecResult> {
      box.commands.push(command);
      box.envs.push(opts.env);
      const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
      if (command.startsWith("rm -rf")) {
        box.head = null;
        return ok();
      }
      if (command.includes(" clone ")) {
        box.head = "fork-main";
        return ok();
      }
      if (command === "git rev-parse HEAD") {
        return box.head ? ok(box.head) : { exitCode: 128, stdout: "", stderr: "not a git repo" };
      }
      const checkout = /^git checkout -q -B main ([0-9a-f]{40})$/.exec(command);
      if (checkout?.[1]) {
        box.head = checkout[1].slice(0, 8);
        return ok();
      }
      const merge = /^git merge -q --no-edit -m "Stack \S+" ([0-9a-f]{40})$/.exec(command);
      if (merge?.[1]) {
        if (box.conflicting.has(merge[1])) {
          box.conflicted = ["src/wishlist.ts"];
          return { exitCode: 1, stdout: "CONFLICT (add/add): src/wishlist.ts", stderr: "" };
        }
        box.head = `${box.head}+${merge[1].slice(0, 4)}@${opts.env?.GIT_COMMITTER_DATE}`;
        return ok();
      }
      if (command === "git diff --name-only --diff-filter=U") return ok(box.conflicted.join("\n"));
      if (
        command.startsWith("git config") ||
        command.includes(" fetch ") ||
        command.startsWith("git cat-file -e") ||
        command === "git merge --abort" ||
        command === "bun install" ||
        command === "git status"
      ) {
        return ok();
      }
      return { exitCode: 127, stdout: "", stderr: `unexpected command ${command}` };
    },
  }),
}));

const { stackFor } = await import("./stack.ts");
const { openWorkspace, runCommand } = await import("./workspace.ts");

const sha = (c: string) => c.repeat(40);
const BASE = sha("0");
const NOW = "2026-10-09T12:00:00.000Z";
const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");
// `using` in workspace.ts disposes each repo handle; the lib target does not type the symbol.
const dispose = (Symbol as unknown as { dispose: symbol }).dispose;

const intent = (fork: string, commit: string | null, files: string[] = []) =>
  JSON.stringify({
    summary: "x",
    ...(commit ? { changeSet: { fork, commit, baseCommit: BASE, diffStat: "", files } } : {}),
  });
const row = (
  id: string,
  task: string,
  at: string,
  commit: string | null,
  files: string[] = [],
) => ({
  id,
  task_id: task,
  intent_json: intent(`ws-${id.slice(3)}`, commit, files),
  created_at: `2026-10-09T10:${at}:00Z`,
});
const edge = (task_id: string, depends_on_task_id: string) => ({ task_id, depends_on_task_id });

describe("stackFor", () => {
  const edges = [
    edge("t5", "t4"),
    edge("t4", "t3"),
    edge("t4", "t2"),
    edge("t3", "t1"),
    edge("t2", "t1"),
    edge("t6", "t1"),
  ];
  const rows = [
    row("cs_t1", "t1", "01", null), // design: Intent only, nothing to merge
    row("cs_t3", "t3", "02", sha("3"), ["src/wishlist.ts"]),
    row("cs_t2", "t2", "03", sha("2"), ["migrations/0004_wishlists.sql"]),
    row("cs_t4a", "t4", "04", sha("a")),
    row("cs_t4b", "t4", "05", sha("4"), ["src/share.ts"]),
    row("cs_t6", "t6", "06", sha("6")),
  ];

  it("closes over dependencies transitively, dependencies first, with a stable tie order", () => {
    const stack = stackFor("t5", edges, rows);
    // t2 and t3 are both ready after t1; t3's ChangeSet is older. t4's latest ChangeSet counts.
    expect(stack.map((s) => s.changeSetId)).toEqual(["cs_t3", "cs_t2", "cs_t4b"]);
    expect(stack[0]).toEqual({
      changeSetId: "cs_t3",
      taskId: "t3",
      fork: "ws-t3",
      commit: sha("3"),
      files: ["src/wishlist.ts"],
    });
    // Same inputs in another order give the same stack: a restore repeats it exactly.
    expect(stackFor("t5", [...edges].reverse(), [...rows].reverse())).toEqual(stack);
    // No unrelated sibling (t6), no Task itself, nothing for a root Task.
    expect(stackFor("t1", edges, rows)).toEqual([]);
  });

  it("refuses a stored commit that is not safe to pass to git", () => {
    expect(() => stackFor("t2", edges, [row("cs_t1", "t1", "01", "HEAD; rm -rf /")])).toThrow(
      /invalid fork or commit/,
    );
  });
});

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
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => exec(sql, params),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    all: async () => exec(sql, params),
  });
  db.exec(`
    INSERT INTO tasks (id, change_id, kind, status, created_at, updated_at)
      VALUES ('tsk_t4', 'chg_1', 'implement', 'running', '${NOW}', '${NOW}');
    INSERT INTO task_runs (id, task_id, agent_id, attempt, tier, status, started_at)
      VALUES ('run_t4_1', 'tsk_t4', 'agt', 1, 'sonnet', 'running', '${NOW}');
  `);
  return {
    db,
    d1: {
      prepare: (sql: string) => statement(sql),
      batch: async (list: ReturnType<typeof statement>[]) => Promise.all(list.map((x) => x.run())),
    } as unknown as D1Database,
  };
}

const repos = { forks: new Set<string>(), deleted: [] as string[], tokens: 0, revoked: 0 };
const artifacts = {
  async get(name: string) {
    return {
      async fork(fork: string) {
        repos.forks.add(fork);
        return { remote: `https://artifacts.example/${fork}.git` };
      },
      async info() {
        return { remote: `https://artifacts.example/${name}.git` };
      },
      async createToken() {
        repos.tokens += 1;
        return { id: `tok_${repos.tokens}`, plaintext: "secret?expires=1" };
      },
      async revokeToken() {
        repos.revoked += 1;
        return true;
      },
      [dispose]() {},
    };
  },
  async delete(name: string) {
    repos.deleted.push(name);
    return repos.forks.delete(name);
  },
};

const stack = [
  { changeSetId: "cs_t3", taskId: "t3", fork: "ws-t3", commit: sha("3"), files: ["src/a.ts"] },
  { changeSetId: "cs_t2", taskId: "t2", fork: "ws-t2", commit: sha("2"), files: ["src/b.ts"] },
];

beforeEach(() => {
  box.head = null;
  box.conflicting = new Set();
  box.conflicted = [];
  box.commands = [];
  box.envs = [];
  repos.forks = new Set();
  repos.deleted = [];
  repos.tokens = 0;
  repos.revoked = 0;
});

describe("openWorkspace with a dependency stack", () => {
  const open = (d1: D1Database) =>
    openWorkspace({ DB: d1, ARTIFACTS: artifacts, SANDBOX: {} } as never, {
      projectId: "proj_1",
      change: { changeId: "chg_1", taskId: "tsk_t4" },
      runId: "run_t4_1",
      baseCommit: BASE,
      stack,
    });

  it("starts from the canonical base plus each dependency, merged in order", async () => {
    const { d1 } = fakeD1();
    const ws = await open(d1);
    if ("refused" in ws) throw new Error(ws.message);
    const merges = box.commands.filter((c) => c.startsWith("git merge"));
    expect(merges).toEqual([
      `git merge -q --no-edit -m "Stack cs_t3" ${sha("3")}`,
      `git merge -q --no-edit -m "Stack cs_t2" ${sha("2")}`,
    ]);
    expect(box.commands.indexOf(`git checkout -q -B main ${BASE}`)).toBeLessThan(
      box.commands.indexOf(merges[0] as string),
    );
    expect(ws.startCommit).toBe(box.head);
    expect(ws.stack?.map((s) => s.changeSetId)).toEqual(["cs_t3", "cs_t2"]);
    // Tokens travel in the environment only, and every one is revoked.
    expect(box.commands.some((c) => c.includes("secret"))).toBe(false);
    expect(repos.revoked).toBe(repos.tokens);
  });

  it("restores the same stacked start after Sandbox loss", async () => {
    const { d1 } = fakeD1();
    const ws = await open(d1);
    if ("refused" in ws) throw new Error(ws.message);
    const firstMerges = box.commands.filter((c) => c.startsWith("git merge"));
    box.head = null; // The container restarted: the checkout is gone.
    box.commands = [];
    const out = await runCommand(
      { DB: d1, ARTIFACTS: artifacts, SANDBOX: {} } as never,
      ws,
      "git status",
    );
    expect(out).toContain("workspace was restored");
    expect(box.commands.filter((c) => c.startsWith("git merge"))).toEqual(firstMerges);
    expect(box.head).toBe(ws.startCommit);
    // A different merge date would give a different start commit: the restore refuses it.
    box.head = null;
    await expect(
      runCommand(
        { DB: d1, ARTIFACTS: artifacts, SANDBOX: {} } as never,
        { ...ws, stackTime: 1 },
        "git status",
      ),
    ).rejects.toThrow(/not the recorded start/);
  });

  it("fails cleanly on a dependency merge conflict: no fork, no reservation, no slot", async () => {
    const { db, d1 } = fakeD1();
    box.conflicting = new Set([sha("2")]);
    const ws = await open(d1);
    expect(ws).toMatchObject({
      refused: "dependency_merge_conflict",
      changeSetId: "cs_t2",
      files: ["src/wishlist.ts"],
    });
    expect("refused" in ws && ws.message).toContain("cs_t2 does not merge with cs_t3");
    expect(box.commands).toContain("git merge --abort");
    expect(box.commands).not.toContain("bun install");
    expect(repos.deleted).toEqual(["ws-t4_1"]);
    expect(repos.forks.size).toBe(0);
    expect(repos.revoked).toBe(repos.tokens);
    expect(
      db.prepare("SELECT count FROM usage_counters WHERE counter = 'sandbox-seconds'").get(),
    ).toEqual({ count: 0 });
    const run = db
      .prepare(
        "SELECT workspace_opened_at, workspace_closed_at FROM task_runs WHERE id = 'run_t4_1'",
      )
      .get() as { workspace_opened_at: string | null; workspace_closed_at: string | null };
    expect(run.workspace_opened_at).not.toBeNull();
    expect(run.workspace_closed_at).not.toBeNull();
  });
});
