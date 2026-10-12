// Critical tests for the Worker-side workspace.
// Files are kept in the AgentDO working tree with zero Sandbox calls.
// Sandbox containers start lazily ONLY when run_command is invoked.
// On publish, dirty files are committed to Artifacts fork using isomorphic-git.
import { DatabaseSync } from "node:sqlite";
import { changeSetPatchKey } from "@rhumbatron/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sandboxBox = vi.hoisted(() => ({
  execCalls: [] as { cmd: string; dir: string }[],
  writtenFiles: new Map<string, string>(),
  readFiles: new Map<string, string>(),
  deletedFiles: new Set<string>(),
  statusOutput: "",
}));

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: () => ({
    async exec(cmd: string, opts: { cwd?: string } = {}) {
      sandboxBox.execCalls.push({ cmd, dir: opts.cwd ?? "" });
      if (cmd === "git rev-parse HEAD") {
        return { exitCode: 0, stdout: "a".repeat(40), stderr: "" };
      }
      if (cmd === "git status --porcelain") {
        return { exitCode: 0, stdout: sandboxBox.statusOutput, stderr: "" };
      }
      if (cmd.startsWith("rm -f ")) {
        const path = cmd.replace("rm -f ", "").trim();
        sandboxBox.deletedFiles.add(path);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "ok\n", stderr: "" };
    },
    async writeFile(path: string, content: string) {
      sandboxBox.writtenFiles.set(path, content);
    },
    async readFile(path: string) {
      if (sandboxBox.readFiles.has(path)) {
        return { content: sandboxBox.readFiles.get(path) ?? "" };
      }
      return { content: "updated file content" };
    },
  }),
}));

const gitBox = vi.hoisted(() => ({
  repoFiles: new Map<string, string>([
    ["src/index.ts", "console.log('original index');"],
    ["package.json", '{"name": "test-pkg"}'],
  ]),
  headSha: "1".repeat(40),
  commits: [] as { message: string; author: unknown }[],
  pushes: [] as { ref: string; url?: string }[],
}));

vi.mock("isomorphic-git", () => ({
  default: {
    init: vi.fn(async () => undefined),
    addRemote: vi.fn(async () => undefined),
    fetch: vi.fn(async () => undefined),
    resolveRef: vi.fn(async () => gitBox.headSha),
    writeRef: vi.fn(async () => undefined),
    checkout: vi.fn(async () => undefined),
    merge: vi.fn(async () => ({ oid: "2".repeat(40) })),
    listFiles: vi.fn(async () => [...gitBox.repoFiles.keys()]),
    readBlob: vi.fn(async ({ filepath }: { filepath: string }) => {
      const content = gitBox.repoFiles.get(filepath);
      if (content === undefined) throw new Error(`file ${filepath} not found`);
      return {
        oid: `blob_${filepath}`,
        blob: new TextEncoder().encode(content),
      };
    }),
    remove: vi.fn(async () => undefined),
    add: vi.fn(async () => undefined),
    commit: vi.fn(async ({ message, author }: { message: string; author: unknown }) => {
      gitBox.commits.push({ message, author });
      return `commit_${"3".repeat(33)}`;
    }),
    push: vi.fn(async ({ ref, url }: { ref: string; url?: string }) => {
      gitBox.pushes.push({ ref, ...(url !== undefined ? { url } : {}) });
      return { ok: true, refs: {} };
    }),
  },
}));

const {
  openWorkspace,
  publishWorkspace,
  closeWorkspace,
  readWorkspaceFile,
  writeWorkspaceFile,
  deleteWorkspaceFile,
  listWorkspaceFiles,
  runCommand,
  safePath,
  SqlWorkspaceTree,
  MemoryWorkspaceTree,
} = await import("./workspace.ts");

function mockSqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_workspace_tree (
      run_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, path)
    );
  `);
  return {
    exec<T = unknown>(query: string, ...params: unknown[]) {
      const stmt = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const rows = stmt.all(...(params as never[])) as T[];
        return {
          toArray: () => rows,
          one: () => rows[0] as T,
        };
      }
      stmt.run(...(params as never[]));
      return {
        toArray: () => [] as T[],
        one: () => ({}) as T,
      };
    },
  } as unknown as SqlStorage;
}

function setupEnv() {
  const objects = new Map<string, string>();
  const put = vi.fn(async (key: string, value: string) => {
    objects.set(key, value);
  });
  const statement = {
    bind: () => statement,
    run: async () => ({ meta: { changes: 1 } }),
    first: async () => ({ count: 1 }),
  };
  const repo = {
    fork: vi.fn(async () => ({})),
    info: async () => ({
      remote: "https://user:tok@artifacts.example/repo",
    }),
    createToken: async () => ({ id: "tok_1", plaintext: "private-token?expires=1" }),
    revokeToken: async () => true,
    [Symbol.dispose]() {},
  };
  const env = {
    SANDBOX: {},
    DB: { prepare: () => statement },
    ARTIFACTS: {
      get: async () => repo,
      delete: vi.fn(async () => true),
    },
    EVIDENCE: {
      put,
      get: async (key: string) =>
        objects.has(key) ? { json: async () => JSON.parse(objects.get(key) as string) } : null,
    },
    AGENT_FILES_IN_WORKER: "true",
  } as unknown as Parameters<typeof openWorkspace>[0];

  return { env, put, objects, repo };
}

beforeEach(() => {
  sandboxBox.execCalls = [];
  sandboxBox.writtenFiles.clear();
  sandboxBox.readFiles.clear();
  sandboxBox.deletedFiles.clear();
  sandboxBox.statusOutput = "";
  gitBox.commits = [];
  gitBox.pushes = [];
});

describe("Path validation (safePath)", () => {
  it("normalizes clean paths and removes leading ./", () => {
    expect(safePath("src/index.ts")).toBe("src/index.ts");
    expect(safePath("./src/index.ts")).toBe("src/index.ts");
    expect(safePath("package.json")).toBe("package.json");
  });

  it("rejects path traversal attempting to escape root with ..", () => {
    expect(() => safePath("../outside.ts")).toThrow("invalid path");
    expect(() => safePath("src/../../outside.ts")).toThrow("invalid path");
  });

  it("rejects absolute paths", () => {
    expect(() => safePath("/etc/passwd")).toThrow("invalid path");
    expect(() => safePath("/src/index.ts")).toThrow("invalid path");
  });

  it("rejects writes into .git metadata directory", () => {
    expect(() => safePath(".git/config")).toThrow("invalid path");
    expect(() => safePath(".git/hooks/pre-commit")).toThrow("invalid path");
  });
});

describe("WorkspaceTree storage (SqlWorkspaceTree and MemoryWorkspaceTree)", () => {
  it("MemoryWorkspaceTree tracks entries, listing, and dirty set", () => {
    const tree = new MemoryWorkspaceTree();
    tree.set("src/a.ts", { content: "hello a", deleted: false, dirty: false });
    tree.set("src/b.ts", { content: "hello b", deleted: false, dirty: true });

    expect(tree.list()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(tree.dirty()).toEqual([{ path: "src/b.ts", content: "hello b", deleted: false }]);

    tree.delete("src/a.ts");
    expect(tree.list()).toEqual(["src/b.ts"]);
    expect(tree.dirty()).toEqual([
      { path: "src/a.ts", content: null, deleted: true },
      { path: "src/b.ts", content: "hello b", deleted: false },
    ]);

    tree.clear();
    expect(tree.list()).toEqual([]);
    expect(tree.dirty()).toEqual([]);
  });

  it("SqlWorkspaceTree persists entries in DO SQLite", () => {
    const sql = mockSqlStorage();
    const tree = new SqlWorkspaceTree(sql, "run_test_1");

    tree.set("src/app.ts", { content: "export default 42;", deleted: false, dirty: false });
    expect(tree.get("src/app.ts")).toEqual({
      content: "export default 42;",
      deleted: false,
      dirty: false,
    });
    expect(tree.list()).toEqual(["src/app.ts"]);
    expect(tree.dirty()).toEqual([]);

    tree.set("src/app.ts", { content: "export default 43;", deleted: false, dirty: true });
    expect(tree.dirty()).toEqual([
      { path: "src/app.ts", content: "export default 43;", deleted: false },
    ]);

    tree.delete("src/app.ts");
    expect(tree.list()).toEqual([]);
    expect(tree.dirty()).toEqual([{ path: "src/app.ts", content: null, deleted: true }]);

    tree.clear();
    expect(tree.list()).toEqual([]);
  });
});

describe("Worker-side workspace lifecycle (AGENT_FILES_IN_WORKER = true)", () => {
  it("opens workspace and reads/writes/deletes files without starting a Sandbox", async () => {
    const { env } = setupEnv();
    const sql = mockSqlStorage();

    // 1. Open workspace
    const ws = await openWorkspace(env, {
      projectId: "proj_1",
      change: { changeId: "chg_1", taskId: "tsk_1" },
      runId: "run_worker_1",
      baseCommit: "1".repeat(40),
      sql,
    });
    if ("refused" in ws) throw new Error(ws.message);

    expect(ws.filesInWorker).toBe(true);
    expect(ws.sandboxStarted).toBe(false);

    // Verify ZERO calls to sandbox exec during open
    expect(sandboxBox.execCalls).toHaveLength(0);

    const tree = new SqlWorkspaceTree(sql, ws.runId);

    // 2. Read existing file from working tree
    const indexContent = await readWorkspaceFile(env, ws, "src/index.ts", tree);
    expect(indexContent).toBe("console.log('original index');");
    expect(sandboxBox.execCalls).toHaveLength(0);

    // 3. List files
    const list = await listWorkspaceFiles(env, ws, undefined, tree);
    expect(list.split("\n")).toEqual(["package.json", "src/index.ts"]);
    expect(sandboxBox.execCalls).toHaveLength(0);

    // 4. Write new file and overwrite existing file
    await writeWorkspaceFile(env, ws, "src/new.ts", "export const x = 1;", tree);
    await writeWorkspaceFile(env, ws, "src/index.ts", "console.log('updated index');", tree);
    expect(sandboxBox.execCalls).toHaveLength(0);

    const updatedIndex = await readWorkspaceFile(env, ws, "src/index.ts", tree);
    expect(updatedIndex).toBe("console.log('updated index');");

    const updatedList = await listWorkspaceFiles(env, ws, undefined, tree);
    expect(updatedList.split("\n")).toEqual(["package.json", "src/index.ts", "src/new.ts"]);

    // 5. Delete file
    await deleteWorkspaceFile(env, ws, "package.json", tree);
    expect(sandboxBox.execCalls).toHaveLength(0);

    await expect(readWorkspaceFile(env, ws, "package.json", tree)).rejects.toThrow("No such file");

    const listAfterDelete = await listWorkspaceFiles(env, ws, undefined, tree);
    expect(listAfterDelete.split("\n")).toEqual(["src/index.ts", "src/new.ts"]);

    // Check dirty files
    const dirty = tree.dirty();
    expect(dirty).toEqual([
      { path: "package.json", content: null, deleted: true },
      { path: "src/index.ts", content: "console.log('updated index');", deleted: false },
      { path: "src/new.ts", content: "export const x = 1;", deleted: false },
    ]);

    // 6. Close workspace when run_command was never called: no Sandbox touched, no reservation settled
    await closeWorkspace(env, ws, tree);
    expect(sandboxBox.execCalls).toHaveLength(0);
  });

  it("starts Sandbox lazily ONLY on run_command, syncs dirty files, and reads back changes", async () => {
    const { env } = setupEnv();
    const sql = mockSqlStorage();

    const ws = await openWorkspace(env, {
      projectId: "proj_1",
      change: { changeId: "chg_1", taskId: "tsk_1" },
      runId: "run_worker_cmd",
      baseCommit: "1".repeat(40),
      sql,
    });
    if ("refused" in ws) throw new Error(ws.message);

    const tree = new SqlWorkspaceTree(sql, ws.runId);

    // Write a file before running command
    await writeWorkspaceFile(env, ws, "src/test.ts", "test('ok', () => {});", tree);
    await deleteWorkspaceFile(env, ws, "package.json", tree);

    expect(ws.sandboxStarted).toBe(false);
    expect(sandboxBox.execCalls).toHaveLength(0);

    // Setup command output: command modifies bun.lock
    sandboxBox.statusOutput = " M bun.lock\n";
    sandboxBox.readFiles.set(`${ws.dir}/bun.lock`, "# lockfile v1");

    // Execute run_command
    const cmdResult = await runCommand(env, ws, "bun test", tree);
    expect(cmdResult).toContain("exit 0");
    expect(ws.sandboxStarted).toBe(true);

    // Verify Sandbox container was initialized:
    // 1. git clone
    // 2. bun install
    // 3. sync dirty files: rm -f package.json, writeFile src/test.ts
    // 4. bun test
    // 5. git status --porcelain
    expect(sandboxBox.writtenFiles.get(`${ws.dir}/src/test.ts`)).toBe("test('ok', () => {});");
    expect(sandboxBox.deletedFiles.has(`${ws.dir}/package.json`)).toBe(true);
    expect(sandboxBox.execCalls.some((c) => c.cmd.includes("clone"))).toBe(true);
    expect(sandboxBox.execCalls.some((c) => c.cmd === "bun install")).toBe(true);
    expect(sandboxBox.execCalls.some((c) => c.cmd === "bun test")).toBe(true);

    // Verify changed file from command (bun.lock) was read back into tree
    expect(await readWorkspaceFile(env, ws, "bun.lock", tree)).toBe("# lockfile v1");

    // A second run_command should NOT clone again
    const execCountBefore = sandboxBox.execCalls.length;
    await runCommand(env, ws, "bun run typecheck", tree);
    const newCalls = sandboxBox.execCalls.slice(execCountBefore);
    expect(newCalls.some((c) => c.cmd.includes("clone"))).toBe(false);
  });

  it("publishes workspace by committing dirty files with isomorphic-git and storing patch", async () => {
    const { env, objects } = setupEnv();
    const sql = mockSqlStorage();

    const ws = await openWorkspace(env, {
      projectId: "proj_1",
      change: { changeId: "chg_1", taskId: "tsk_pub" },
      runId: "run_worker_pub",
      baseCommit: "1".repeat(40),
      sql,
    });
    if ("refused" in ws) throw new Error(ws.message);

    const tree = new SqlWorkspaceTree(sql, ws.runId);

    // If no dirty files, publish returns null
    const noChange = await publishWorkspace(env, ws, "no changes", tree);
    expect(noChange).toBeNull();

    // Make dirty changes
    await writeWorkspaceFile(env, ws, "src/new.ts", "console.log('published');", tree);
    await deleteWorkspaceFile(env, ws, "src/index.ts", tree);

    const published = await publishWorkspace(env, ws, "feat: implement feature", tree);
    expect(published).not.toBeNull();
    expect(published?.commit).toContain("commit_");
    expect(published?.files).toEqual(["src/index.ts", "src/new.ts"]);
    expect(published?.diffStat).toContain("files changed");
    expect(published?.patchRef).toBe(changeSetPatchKey("proj_1", "cs_worker_pub"));

    // Check git calls: commit and push
    expect(gitBox.commits).toHaveLength(1);
    expect(gitBox.commits[0]?.message).toBe("feat: implement feature");
    expect(gitBox.commits[0]?.author).toMatchObject({
      name: "Rhumbatron",
      email: "bot@rhumbatron.com",
    });
    expect(gitBox.pushes).toHaveLength(1);
    expect(gitBox.pushes[0]?.ref).toBe("main");

    // Verify patch was stored in EVIDENCE
    const patchKey = changeSetPatchKey("proj_1", "cs_worker_pub");
    expect(objects.has(patchKey)).toBe(true);
  });
});
