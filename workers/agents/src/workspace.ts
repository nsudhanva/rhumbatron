import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import {
  boundPatch,
  changeSetPatchKey,
  patchCommand,
  patchMetadata,
  unifiedFilePatch,
  WorkspaceManifest,
  workspaceManifestKey,
} from "@rhumbatron/protocol";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { createFsFromVolume, Volume } from "memfs";
import {
  admitSandbox,
  type LimitKey,
  noteSandboxRefused,
  releaseSandbox,
  sandboxLimitReason,
} from "./limits.ts";
import { type StackSource, stackedOn } from "./stack.ts";

/**
 * Task Workspace (AGENTS.md sections 29.2 and 30):
 *
 * When AGENT_FILES_IN_WORKER is "true" (opt-in; off by default):
 * - Keeps the agent's working tree in the AgentDO (DO SQLite or memory storage), plus a dirty set.
 * - list_files, read_file, write_file, and delete_file work with NO Sandbox container time.
 * - On publish, commits dirty files to the Artifacts fork with isomorphic-git in the Worker.
 * - Stacked tasks start from the merged ChangeSet commit, evaluated via isomorphic-git.
 * - run_command starts a Sandbox container lazily only when called, syncing dirty files before
 *   execution and reading back changed files afterwards. If run_command is never called, no
 *   container starts.
 *
 * Otherwise (the default):
 * - Falls back to the original Sandbox container checkout for all file tools and commands.
 */

const DIR = "/repo";
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type MemFs = Parameters<typeof git.init>[0]["fs"] & {
  promises: {
    readFile(p: string, o?: string): Promise<string | Uint8Array>;
    writeFile(p: string, c: string | Uint8Array): Promise<void>;
    unlink(p: string): Promise<void>;
    mkdir(p: string, o?: object): Promise<void>;
  };
};

/**
 * Hard stop at the monthly Sandbox hours, counted conservatively. ADR 0017 splits the approved
 * 20 hours between dev (5) and prod (15): each environment's `SANDBOX_MONTHLY_SECONDS` binding
 * sets its own meter. This is the fallback when the binding is absent.
 */
const MONTHLY_SECONDS = 36_000;

/** This environment's monthly Sandbox cap: the binding when it is a positive integer, else 36,000. */
const monthlySeconds = (configured?: string) => {
  const n = Number(configured);
  return configured && Number.isInteger(n) && n > 0 ? n : MONTHLY_SECONDS;
};
/** Charged when a session opens; the rest is settled when it closes. */
const OPEN_RESERVATION_SECONDS = 300;
/** Idle time billed after the last command, until the Sandbox sleeps. Below the open reservation. */
const SLEEP_TAIL_SECONDS = 120;
/** Increment when ALLOWED or FORBIDDEN_CHARS changes. */
const COMMAND_ALLOWLIST_VERSION = 2;
const WORKSPACE_TOOLS = [
  "list_files",
  "read_file",
  "write_file",
  "delete_file",
  "run_command",
  "complete_task",
  "fail_task",
];
const sandboxId = (projectId: string) => `proj-${projectId.slice(5)}`;
const COMMAND_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 12_000;

/** Commands an agent may run. No shell metacharacters, no network tools, no package publishing. */
const ALLOWED = [
  /^bun install( --frozen-lockfile)?$/,
  /^bun test( [\w./-]+)*$/,
  /^bun run (typecheck|test|bench|contract)$/,
  /^bunx tsc --noEmit$/,
  /^git (status|diff|log)( [\w./:=-]+)*$/,
  /^ls( -[al]+)?( [\w./-]+)?$/,
];
const FORBIDDEN_CHARS = /[;&|`$<>\\\n]/;

const month = () => new Date().toISOString().slice(0, 7);

/** Reserves Sandbox seconds. False when the monthly cap would be exceeded. */
async function reserveSeconds(env: WorkspaceEnv, seconds: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `INSERT INTO usage_counters (day, counter, count) VALUES (?, 'sandbox-seconds', ?)
       ON CONFLICT (day, counter) DO UPDATE SET count = count + ? WHERE count + ? <= ?
       RETURNING count`,
  )
    .bind(month(), seconds, seconds, seconds, monthlySeconds(env.SANDBOX_MONTHLY_SECONDS))
    .first<{ count: number }>();
  return row !== null;
}

async function settleSeconds(db: D1Database, seconds: number) {
  if (seconds === 0) return;
  await db
    .prepare(
      "UPDATE usage_counters SET count = count + ? WHERE day = ? AND counter = 'sandbox-seconds'",
    )
    .bind(seconds, month())
    .run();
}

export type WorkspaceRef = {
  projectId: string;
  runId: string;
  /** Fork repo name in Artifacts. */
  fork: string;
  dir: string;
  baseCommit: string;
  openedAt: number;
  /** Dependency ChangeSets merged onto the base, in merge order. Absent on refs from before stacking. */
  stack?: StackSource[];
  /** HEAD after the stacked merges: where the agent's edits start. */
  startCommit?: string;
  /** Fixed git date (Unix seconds) of the stack merge commits, so a restore reproduces `startCommit`. */
  stackTime?: number;
  /** Also retained in AgentDO state, so a failed R2 open write can be retried on publish/close. */
  manifest?: WorkspaceManifest;
  /** Present when the agent's working tree is maintained in the Worker without an initial Sandbox container. */
  filesInWorker?: boolean;
  /** True when the Sandbox container has been started lazily for run_command. */
  sandboxStarted?: boolean;
};

export type Published = {
  fork: string;
  commit: string;
  baseCommit: string;
  diffStat: string;
  files: string[];
  /** ChangeSet IDs this one was built on (stacked workspace), in merge order. */
  stackedOn: string[];
  /** Present when the workspace stacked dependencies: the agent's starting point and own files. */
  startCommit?: string;
  ownFiles?: string[];
  /** R2 key of this ChangeSet's stored `git diff` (section 15.4). Absent when it was not stored. */
  patchRef?: string;
};

export type WorkspaceEnv = {
  SANDBOX: DurableObjectNamespace;
  ARTIFACTS: Artifacts;
  DB: D1Database;
  EVIDENCE: R2Bucket;
  SANDBOX_MONTHLY_SECONDS?: string;
  AGENT_FILES_IN_WORKER?: string;
  HTTP?: typeof http;
};

/* ------------------------------------------------------------------------------------------ */
/* Working Tree Storage (AgentDO SQLite or in-memory)                                         */
/* ------------------------------------------------------------------------------------------ */

export type TreeEntry = {
  content: string | null;
  deleted: boolean;
  dirty: boolean;
};

export interface WorkspaceTree {
  get(path: string): TreeEntry | undefined;
  set(path: string, entry: TreeEntry): void;
  delete(path: string): void;
  list(): string[];
  dirty(): { path: string; content: string | null; deleted: boolean }[];
  clear(): void;
}

export class SqlWorkspaceTree implements WorkspaceTree {
  constructor(
    private readonly sql: SqlStorage,
    private readonly runId: string,
  ) {}

  get(path: string): TreeEntry | undefined {
    const row = this.sql
      .exec<{ content: string | null; deleted: number; dirty: number }>(
        "SELECT content, deleted, dirty FROM run_workspace_tree WHERE run_id = ? AND path = ?",
        this.runId,
        path,
      )
      .toArray()[0];
    if (!row) return undefined;
    return {
      content: row.content,
      deleted: row.deleted === 1,
      dirty: row.dirty === 1,
    };
  }

  set(path: string, entry: TreeEntry): void {
    this.sql.exec(
      `INSERT INTO run_workspace_tree (run_id, path, content, deleted, dirty)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id, path) DO UPDATE SET
         content = excluded.content,
         deleted = excluded.deleted,
         dirty = excluded.dirty`,
      this.runId,
      path,
      entry.content,
      entry.deleted ? 1 : 0,
      entry.dirty ? 1 : 0,
    );
  }

  delete(path: string): void {
    this.sql.exec(
      `INSERT INTO run_workspace_tree (run_id, path, content, deleted, dirty)
       VALUES (?, ?, NULL, 1, 1)
       ON CONFLICT(run_id, path) DO UPDATE SET
         content = NULL,
         deleted = 1,
         dirty = 1`,
      this.runId,
      path,
    );
  }

  list(): string[] {
    return this.sql
      .exec<{ path: string }>(
        "SELECT path FROM run_workspace_tree WHERE run_id = ? AND deleted = 0 ORDER BY path",
        this.runId,
      )
      .toArray()
      .map((r) => r.path);
  }

  dirty(): { path: string; content: string | null; deleted: boolean }[] {
    return this.sql
      .exec<{ path: string; content: string | null; deleted: number }>(
        "SELECT path, content, deleted FROM run_workspace_tree WHERE run_id = ? AND dirty = 1 ORDER BY path",
        this.runId,
      )
      .toArray()
      .map((r) => ({
        path: r.path,
        content: r.content,
        deleted: r.deleted === 1,
      }));
  }

  clear(): void {
    this.sql.exec("DELETE FROM run_workspace_tree WHERE run_id = ?", this.runId);
  }
}

export class MemoryWorkspaceTree implements WorkspaceTree {
  private readonly entries = new Map<string, TreeEntry>();

  get(path: string): TreeEntry | undefined {
    return this.entries.get(path);
  }

  set(path: string, entry: TreeEntry): void {
    this.entries.set(path, entry);
  }

  delete(path: string): void {
    this.entries.set(path, { content: null, deleted: true, dirty: true });
  }

  list(): string[] {
    return [...this.entries.entries()]
      .filter(([_, e]) => !e.deleted)
      .map(([p]) => p)
      .sort();
  }

  dirty(): { path: string; content: string | null; deleted: boolean }[] {
    return [...this.entries.entries()]
      .filter(([_, e]) => e.dirty)
      .map(([path, e]) => ({ path, content: e.content, deleted: e.deleted }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  clear(): void {
    this.entries.clear();
  }
}

const memoryTrees = new Map<string, MemoryWorkspaceTree>();

export function getWorkspaceTree(sql: SqlStorage | undefined, runId: string): WorkspaceTree {
  if (sql) return new SqlWorkspaceTree(sql, runId);
  let tree = memoryTrees.get(runId);
  if (!tree) {
    tree = new MemoryWorkspaceTree();
    memoryTrees.set(runId, tree);
  }
  return tree;
}

/* ------------------------------------------------------------------------------------------ */
/* Path Validation and Output Formatting                                                      */
/* ------------------------------------------------------------------------------------------ */

export const safePath = (path: string): string => {
  if (path.startsWith("/")) {
    throw new Error(`invalid path ${path}`);
  }
  const clean = path.replace(/^\.\//, "");
  if (clean.includes("..") || clean.startsWith(".git")) {
    throw new Error(`invalid path ${path}`);
  }
  return clean;
};

function formatDiffStat(changes: { path: string; additions: number; deletions: number }[]): string {
  if (changes.length === 0) return "";
  let additions = 0;
  let deletions = 0;
  const lines = changes.map((c) => {
    additions += c.additions;
    deletions += c.deletions;
    const total = c.additions + c.deletions;
    const plus = "+".repeat(Math.min(c.additions, 40));
    const minus = "-".repeat(Math.min(c.deletions, 40));
    return ` ${c.path} | ${total} ${plus}${minus}`;
  });
  const fileWord = changes.length === 1 ? "1 file" : `${changes.length} files`;
  lines.push(` ${fileWord} changed, ${additions} insertions(+), ${deletions} deletions(-)`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------------------------------ */
/* Sandbox and Git Helpers                                                                    */
/* ------------------------------------------------------------------------------------------ */

const sandboxFor = (env: WorkspaceEnv, projectId: string) =>
  getSandbox(env.SANDBOX as unknown as DurableObjectNamespace<Sandbox>, sandboxId(projectId), {
    sleepAfter: SLEEP_TAIL_SECONDS,
  });

/** The Sandbox drops stdout's trailing newline; keep stderr on its own line so line parsers work. */
const joinOutput = (stdout: string, stderr: string) =>
  stdout && stderr && !stdout.endsWith("\n") ? `${stdout}\n${stderr}` : `${stdout}${stderr}`;

const clip = (text: string) =>
  text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(-MAX_OUTPUT_CHARS)}\n… (earlier output cut)`
    : text;

async function run(sandbox: Sandbox, command: string, dir: string, env?: Record<string, string>) {
  const result = await sandbox.exec(command, {
    cwd: dir,
    timeout: COMMAND_TIMEOUT_MS,
    ...(env ? { env } : {}),
  });
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    output: clip(joinOutput(result.stdout, result.stderr)),
  };
}

/** A workspace that was not opened, and why. The agent sees `message` as its tool result. */
export type WorkspaceRefused =
  | { refused: "monthly_sandbox_seconds" | LimitKey; message: string }
  | {
      refused: "dependency_merge_conflict";
      message: string;
      changeSetId: string;
      files: string[];
    };

const SHA = /^[0-9a-f]{40}$/;

type Prepared =
  | { ok: true; startCommit: string; remoteHost: string }
  | { ok: false; changeSetId: string; files: string[]; detail: string };

/**
 * Builds the run directory in the Sandbox checkout.
 */
async function prepareCheckout(
  env: WorkspaceEnv,
  sandbox: Sandbox,
  ws: Pick<WorkspaceRef, "fork" | "dir" | "baseCommit"> & {
    stack: readonly StackSource[];
    stackTime: number;
  },
): Promise<Prepared> {
  const own = await readAuth(env, ws.fork);
  try {
    await sandbox.exec(`rm -rf ${ws.dir} && mkdir -p ${ws.dir}`);
    const clone = await run(
      sandbox,
      `git -c "http.extraHeader=$GIT_AUTH" clone ${own.remote} .`,
      ws.dir,
      own.header,
    );
    if (!clone.ok) throw new Error(`clone failed (${clone.exitCode})`);
  } finally {
    await own.revoke();
  }
  await run(
    sandbox,
    "git config user.name Rhumbatron && git config user.email bot@rhumbatron.com",
    ws.dir,
  );
  if (SHA.test(ws.baseCommit)) {
    const checkout = await run(sandbox, `git checkout -q -B main ${ws.baseCommit}`, ws.dir);
    if (!checkout.ok) throw new Error(`base checkout failed (${checkout.exitCode})`);
  }
  const date = {
    GIT_AUTHOR_DATE: `${ws.stackTime} +0000`,
    GIT_COMMITTER_DATE: `${ws.stackTime} +0000`,
  };
  for (const source of ws.stack) {
    const theirs = await readAuth(env, source.fork);
    try {
      const fetch = await run(
        sandbox,
        `git -c "http.extraHeader=$GIT_AUTH" fetch -q ${theirs.remote} +main:refs/rhumbatron/${source.changeSetId}`,
        ws.dir,
        theirs.header,
      );
      if (!fetch.ok) throw new Error(`fetch of ${source.changeSetId} failed (${fetch.exitCode})`);
    } finally {
      await theirs.revoke();
    }
    const present = await run(sandbox, `git cat-file -e ${source.commit}^{commit}`, ws.dir);
    if (!present.ok) throw new Error(`commit of ${source.changeSetId} is not in ${source.fork}`);
    const merge = await run(
      sandbox,
      `git merge -q --no-edit -m "Stack ${source.changeSetId}" ${source.commit}`,
      ws.dir,
      date,
    );
    if (!merge.ok) {
      const conflicted = await run(sandbox, "git diff --name-only --diff-filter=U", ws.dir);
      await run(sandbox, "git merge --abort", ws.dir);
      return {
        ok: false,
        changeSetId: source.changeSetId,
        files: conflicted.output.trim().split("\n").filter(Boolean).slice(0, 50),
        detail: merge.output.trim().split("\n").slice(-3).join(" | ").slice(0, 300),
      };
    }
  }
  const head = await run(sandbox, "git rev-parse HEAD", ws.dir);
  if (!head.ok) throw new Error(`rev-parse failed (${head.exitCode})`);
  await run(sandbox, "bun install", ws.dir);
  return { ok: true, startCommit: head.output.trim(), remoteHost: new URL(own.remote).hostname };
}

/** Manifest storage is observability: a failure must not change the run outcome or leak errors. */
async function writeManifest(env: WorkspaceEnv, ws: WorkspaceRef) {
  if (!ws.manifest) return;
  try {
    const manifest = WorkspaceManifest.parse(ws.manifest);
    await env.EVIDENCE.put(workspaceManifestKey(manifest), JSON.stringify(manifest), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { openedAt: manifest.sandbox.openedAt },
    });
  } catch {
    console.warn(JSON.stringify({ event: "workspace.manifest_write_failed", runId: ws.runId }));
  }
}

/** Read-scoped repo token as a git header value, plus its revoke handle. */
async function readAuth(env: WorkspaceEnv, name: string) {
  using repo = await env.ARTIFACTS.get(name);
  const info = await repo.info();
  const token = await repo.createToken("read", 600);
  const secret = token.plaintext.split("?expires=")[0] ?? token.plaintext;
  return {
    remote: info.remote,
    header: { GIT_AUTH: `Authorization: Bearer ${secret}` },
    onAuth: () => ({ username: "x", password: secret }),
    revoke: async () => {
      using again = await env.ARTIFACTS.get(name);
      await again.revokeToken(token.id).catch(() => false);
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* openWorkspace                                                                              */
/* ------------------------------------------------------------------------------------------ */

export async function openWorkspace(
  env: WorkspaceEnv,
  input: {
    projectId: string;
    change?: { changeId: string; taskId: string };
    runId: string;
    baseCommit: string;
    stack?: readonly StackSource[];
    sql?: SqlStorage;
  },
): Promise<WorkspaceRef | WorkspaceRefused> {
  // Off by default until the Worker-side path is proven live (it failed to publish on prod: fork
  // not found before use, stale ref on push). Opt in with AGENT_FILES_IN_WORKER = "true".
  const filesInWorker = env.AGENT_FILES_IN_WORKER === "true";
  const fork = `ws-${input.runId.slice(4)}`;
  const dir = `/workspace/${input.runId.slice(-24)}`;
  const stack = input.stack ?? [];
  const stackTime = Math.floor(Date.now() / 1000);

  if (filesInWorker) {
    // Worker-side workspace: no Sandbox admission, no reservation, no container starts.
    let remoteHost = "artifacts.example";
    let startCommit = input.baseCommit;

    const undo = async () => {
      await env.ARTIFACTS.delete?.(fork)?.catch(() => false);
    };

    try {
      using canonical = await env.ARTIFACTS.get(input.projectId);
      try {
        await canonical.fork(fork, {
          description: `Workspace for ${input.runId}`,
          defaultBranchOnly: true,
        });
      } catch {
        using existing = await env.ARTIFACTS.get(fork);
        await existing.info();
      }

      using repo = await env.ARTIFACTS.get(fork);
      const info = await repo.info();
      if (info.remote) {
        try {
          remoteHost = new URL(info.remote).hostname;
        } catch {}
      }
      const token = await repo.createToken("write", 600);
      const secret = token.plaintext.split("?expires=")[0] ?? token.plaintext;
      const onAuth = () => ({ username: "x", password: secret });
      const gitHttp = env.HTTP ?? http;

      try {
        const fs = createFsFromVolume(new Volume()) as unknown as MemFs;
        await git.init({ fs, dir: DIR, defaultBranch: "main" });
        await git.addRemote({ fs, dir: DIR, remote: "origin", url: info.remote, force: true });
        await git.fetch({
          fs,
          http: gitHttp,
          dir: DIR,
          remote: "origin",
          url: info.remote,
          ref: "main",
          singleBranch: true,
          tags: false,
          onAuth,
        });
        const head = await git.resolveRef({ fs, dir: DIR, ref: "refs/remotes/origin/main" });
        await git.writeRef({ fs, dir: DIR, ref: "refs/heads/main", value: head, force: true });
        await git.checkout({ fs, dir: DIR, ref: "main", force: true });

        if (stack.length > 0) {
          const date = {
            name: "Rhumbatron",
            email: "bot@rhumbatron.com",
            timestamp: stackTime,
            timezoneOffset: 0,
          };
          for (const source of stack) {
            const theirs = await readAuth(env, source.fork);
            try {
              await git.addRemote({
                fs,
                dir: DIR,
                remote: source.changeSetId,
                url: theirs.remote,
                force: true,
              });
              await git.fetch({
                fs,
                http: gitHttp,
                dir: DIR,
                remote: source.changeSetId,
                url: theirs.remote,
                ref: "main",
                singleBranch: true,
                tags: false,
                onAuth: theirs.onAuth,
              });
            } finally {
              await theirs.revoke();
            }
            try {
              await git.merge({
                fs,
                dir: DIR,
                ours: "main",
                theirs: source.commit,
                author: date,
                committer: date,
                message: `Stack ${source.changeSetId}`,
              });
            } catch (err: unknown) {
              await undo();
              const errObj = err as {
                code?: string;
                name?: string;
                data?: { filepaths?: string[] };
              };
              if (errObj?.code === "MergeConflictError" || errObj?.name === "MergeConflictError") {
                const conflictedFiles = errObj.data?.filepaths ?? [];
                const ids = stack.map((s) => s.changeSetId);
                const before = ids.slice(0, ids.indexOf(source.changeSetId));
                return {
                  refused: "dependency_merge_conflict",
                  changeSetId: source.changeSetId,
                  files: conflictedFiles,
                  message: `dependency_merge_conflict: ${source.changeSetId} does not merge with ${before.join(", ") || "the canonical base"} (${conflictedFiles.join(", ") || "conflicts"}). The dependencies of this Task conflict, so it cannot start from their work.`,
                };
              }
              throw err;
            }
          }
          const mergedHead = await git.resolveRef({ fs, dir: DIR, ref: "refs/heads/main" });
          const pushed = await git.push({
            fs,
            http: gitHttp,
            dir: DIR,
            url: info.remote,
            ref: "main",
            onAuth,
          });
          if (!pushed.ok)
            throw new Error(`push rejected: ${JSON.stringify(pushed.refs).slice(0, 200)}`);
          startCommit = mergedHead;
        } else {
          startCommit = head;
        }

        const tree = getWorkspaceTree(input.sql, input.runId);
        tree.clear();
        const fileList = await git.listFiles({ fs, dir: DIR, ref: "main" });
        for (const filepath of fileList) {
          try {
            const { blob } = await git.readBlob({ fs, dir: DIR, oid: startCommit, filepath });
            const isBinary = blob.includes(0);
            const content = isBinary ? null : decoder.decode(blob);
            tree.set(filepath, { content, deleted: false, dirty: false });
          } catch {}
        }
      } finally {
        await repo.revokeToken(token.id).catch(() => false);
      }
    } catch (error) {
      await undo();
      throw error;
    }

    const ws: WorkspaceRef = {
      projectId: input.projectId,
      runId: input.runId,
      fork,
      dir,
      baseCommit: input.baseCommit,
      openedAt: Date.now(),
      stack: [...stack],
      startCommit,
      stackTime,
      filesInWorker: true,
      sandboxStarted: false,
    };

    if (input.change) {
      ws.manifest = {
        manifestVersion: 1,
        projectId: ws.projectId,
        changeId: input.change.changeId,
        taskId: input.change.taskId,
        runId: ws.runId,
        fork: ws.fork,
        remoteHost,
        baseCommit: ws.baseCommit,
        startCommit,
        stackedOn: stackedOn(stack),
        sandbox: {
          id: sandboxId(ws.projectId),
          dir: ws.dir,
          openedAt: new Date(ws.openedAt).toISOString(),
          sleepAfter: SLEEP_TAIL_SECONDS,
        },
        toolsAllowed: [...WORKSPACE_TOOLS],
        commandAllowlistVersion: COMMAND_ALLOWLIST_VERSION,
        files: [],
        status: "open",
      };
      await writeManifest(env, ws);
    }
    return ws;
  }

  // Fallback: Sandbox path when AGENT_FILES_IN_WORKER is "false"
  const now = new Date().toISOString();
  const change = input.change;
  if (
    change &&
    !(await admitSandbox(env.DB, { runId: input.runId, changeId: change.changeId, now }))
  ) {
    await noteSandboxRefused(env.DB, change.taskId, now);
    return {
      refused: "max_active_sandboxes_per_change",
      message: `${sandboxLimitReason()} Declare your Intent without code changes, or call fail_task.`,
    };
  }
  if (!(await reserveSeconds(env, OPEN_RESERVATION_SECONDS))) {
    await releaseSandbox(env.DB, input.runId, now);
    return {
      refused: "monthly_sandbox_seconds",
      message: "The monthly Sandbox budget is used up. Declare your Intent without code changes.",
    };
  }
  const undo = async () => {
    await env.ARTIFACTS.delete?.(fork)?.catch(() => false);
    await settleSeconds(env.DB, -OPEN_RESERVATION_SECONDS);
    await releaseSandbox(env.DB, input.runId, new Date().toISOString());
  };
  let prepared: Prepared;
  try {
    using canonical = await env.ARTIFACTS.get(input.projectId);
    try {
      await canonical.fork(fork, {
        description: `Workspace for ${input.runId}`,
        defaultBranchOnly: true,
      });
    } catch {
      using existing = await env.ARTIFACTS.get(fork);
      await existing.info();
    }
    prepared = await prepareCheckout(env, sandboxFor(env, input.projectId), {
      fork,
      dir,
      baseCommit: input.baseCommit,
      stack,
      stackTime,
    });
  } catch (error) {
    await undo();
    throw error;
  }
  if (!prepared.ok) {
    await undo();
    const ids = stack.map((s) => s.changeSetId);
    const before = ids.slice(0, ids.indexOf(prepared.changeSetId));
    return {
      refused: "dependency_merge_conflict",
      changeSetId: prepared.changeSetId,
      files: prepared.files,
      message: `dependency_merge_conflict: ${prepared.changeSetId} does not merge with ${before.join(", ") || "the canonical base"} (${prepared.files.join(", ") || prepared.detail}). The dependencies of this Task conflict, so it cannot start from their work.`,
    };
  }
  const ws: WorkspaceRef = {
    projectId: input.projectId,
    runId: input.runId,
    fork,
    dir,
    baseCommit: input.baseCommit,
    openedAt: Date.now(),
    stack: [...stack],
    startCommit: prepared.startCommit,
    stackTime,
    filesInWorker: false,
    sandboxStarted: true,
  };
  if (change) {
    ws.manifest = {
      manifestVersion: 1,
      projectId: ws.projectId,
      changeId: change.changeId,
      taskId: change.taskId,
      runId: ws.runId,
      fork: ws.fork,
      remoteHost: prepared.remoteHost,
      baseCommit: ws.baseCommit,
      startCommit: prepared.startCommit,
      stackedOn: stackedOn(stack),
      sandbox: {
        id: sandboxId(ws.projectId),
        dir: ws.dir,
        openedAt: new Date(ws.openedAt).toISOString(),
        sleepAfter: SLEEP_TAIL_SECONDS,
      },
      toolsAllowed: [...WORKSPACE_TOOLS],
      commandAllowlistVersion: COMMAND_ALLOWLIST_VERSION,
      files: [],
      status: "open",
    };
    await writeManifest(env, ws);
  }
  return ws;
}

/**
 * Restores the run directory after Sandbox loss (section 42.5).
 */
async function ensureCheckout(env: WorkspaceEnv, ws: WorkspaceRef): Promise<boolean> {
  const sandbox = sandboxFor(env, ws.projectId);
  const head = await run(sandbox, "git rev-parse HEAD", ws.dir).catch(() => null);
  if (head?.ok) return false;
  const prepared = await prepareCheckout(env, sandbox, {
    fork: ws.fork,
    dir: ws.dir,
    baseCommit: ws.baseCommit,
    stack: ws.stack ?? [],
    stackTime: ws.stackTime ?? Math.floor(ws.openedAt / 1000),
  });
  if (!prepared.ok || (ws.startCommit && prepared.startCommit !== ws.startCommit)) {
    await sandbox.exec(`rm -rf ${ws.dir}`).catch(() => undefined);
  }
  if (!prepared.ok) throw new Error(`workspace restore: ${prepared.changeSetId} no longer merges`);
  if (ws.startCommit && prepared.startCommit !== ws.startCommit) {
    throw new Error(
      `workspace restore reached ${prepared.startCommit.slice(0, 12)}, not the recorded start ${ws.startCommit.slice(0, 12)}`,
    );
  }
  return true;
}

const RESTORED_NOTE =
  "Note: the Sandbox was lost and your workspace was restored to its starting point (canonical base plus inherited ChangeSets). Files you wrote earlier in this run are gone; write them again.\n\n";

/* ------------------------------------------------------------------------------------------ */
/* runCommand                                                                                 */
/* ------------------------------------------------------------------------------------------ */

export async function runCommand(
  env: WorkspaceEnv,
  ws: WorkspaceRef,
  command: string,
  tree?: WorkspaceTree,
): Promise<string> {
  const cmd = command.trim();
  if (FORBIDDEN_CHARS.test(cmd) || !ALLOWED.some((re) => re.test(cmd))) {
    return `Not allowed: ${cmd}\nAllowed: bun install, bun test [paths], bun run typecheck|test|bench, bunx tsc --noEmit, git status|diff|log, ls.`;
  }

  if (ws.filesInWorker) {
    const activeTree = tree ?? getWorkspaceTree(undefined, ws.runId);
    const sandbox = sandboxFor(env, ws.projectId);

    // Lazily start the Sandbox container only when run_command is called:
    if (!ws.sandboxStarted) {
      const now = new Date().toISOString();
      if (ws.manifest) {
        if (
          !(await admitSandbox(env.DB, {
            runId: ws.runId,
            changeId: ws.manifest.changeId,
            now,
          }))
        ) {
          await noteSandboxRefused(env.DB, ws.manifest.taskId, now);
          return `${sandboxLimitReason()} Declare your Intent without code changes, or call fail_task.`;
        }
      }
      if (!(await reserveSeconds(env, OPEN_RESERVATION_SECONDS))) {
        await releaseSandbox(env.DB, ws.runId, now);
        return "The monthly Sandbox budget is used up. Declare your Intent without code changes.";
      }

      const own = await readAuth(env, ws.fork);
      try {
        await sandbox.exec(`rm -rf ${ws.dir} && mkdir -p ${ws.dir}`);
        const clone = await run(
          sandbox,
          `git -c "http.extraHeader=$GIT_AUTH" clone ${own.remote} .`,
          ws.dir,
          own.header,
        );
        if (!clone.ok) throw new Error(`clone failed (${clone.exitCode})`);
      } finally {
        await own.revoke();
      }
      await run(
        sandbox,
        "git config user.name Rhumbatron && git config user.email bot@rhumbatron.com",
        ws.dir,
      );
      await run(sandbox, "bun install", ws.dir);
      ws.sandboxStarted = true;
    } else {
      // Reconnect / restore if lost
      const head = await run(sandbox, "git rev-parse HEAD", ws.dir).catch(() => null);
      if (!head?.ok) {
        const own = await readAuth(env, ws.fork);
        try {
          await sandbox.exec(`rm -rf ${ws.dir} && mkdir -p ${ws.dir}`);
          const clone = await run(
            sandbox,
            `git -c "http.extraHeader=$GIT_AUTH" clone ${own.remote} .`,
            ws.dir,
            own.header,
          );
          if (!clone.ok) throw new Error(`clone failed (${clone.exitCode})`);
        } finally {
          await own.revoke();
        }
        await run(
          sandbox,
          "git config user.name Rhumbatron && git config user.email bot@rhumbatron.com",
          ws.dir,
        );
        await run(sandbox, "bun install", ws.dir);
      }
    }

    // Sync dirty files into Sandbox checkout before the command:
    const dirtyFiles = activeTree.dirty();
    for (const file of dirtyFiles) {
      const clean = safePath(file.path);
      if (file.deleted) {
        await sandbox.exec(`rm -f ${ws.dir}/${clean}`);
      } else if (file.content !== null) {
        const parent = clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
        if (parent) await sandbox.exec(`mkdir -p ${ws.dir}/${parent}`);
        await sandbox.writeFile(`${ws.dir}/${clean}`, file.content);
      }
    }

    // Execute the command:
    const result = await run(sandbox, cmd, ws.dir);

    // After command runs, read back any files the command changed:
    const statusResult = await run(sandbox, "git status --porcelain", ws.dir);
    const lines = statusResult.output
      .split("\n")
      .map((l) => l.trimEnd())
      .filter(Boolean);
    for (const line of lines) {
      if (line.length < 4) continue;
      const status = line.slice(0, 2);
      const filePath = line.slice(3).trim();
      if (!filePath) continue;
      const targetPath = filePath.includes(" -> ")
        ? (filePath.split(" -> ")[1]?.trim() ?? filePath)
        : filePath;
      const clean = safePath(targetPath);
      if (status.includes("D")) {
        activeTree.delete(clean);
      } else {
        const readFileResult = await sandbox.readFile(`${ws.dir}/${clean}`).catch(() => null);
        const content =
          readFileResult && "content" in readFileResult ? String(readFileResult.content) : "";
        activeTree.set(clean, { content, deleted: false, dirty: true });
      }
    }

    return `exit ${result.exitCode}\n${result.output}`;
  }

  // Fallback: Sandbox path
  const restored = await ensureCheckout(env, ws);
  const result = await run(sandboxFor(env, ws.projectId), cmd, ws.dir);
  return `${restored ? RESTORED_NOTE : ""}exit ${result.exitCode}\n${result.output}`;
}

/* ------------------------------------------------------------------------------------------ */
/* File Access Tools                                                                          */
/* ------------------------------------------------------------------------------------------ */

export async function writeWorkspaceFile(
  env: WorkspaceEnv,
  ws: WorkspaceRef,
  path: string,
  content: string,
  tree?: WorkspaceTree,
): Promise<string> {
  const clean = safePath(path);
  if (ws.filesInWorker) {
    const activeTree = tree ?? getWorkspaceTree(undefined, ws.runId);
    activeTree.set(clean, { content, deleted: false, dirty: true });
    return `wrote ${clean} (${content.length} chars)`;
  }
  const restored = await ensureCheckout(env, ws);
  const sandbox = sandboxFor(env, ws.projectId);
  const parent = clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
  if (parent) await sandbox.exec(`mkdir -p ${ws.dir}/${parent}`);
  await sandbox.writeFile(`${ws.dir}/${clean}`, content);
  return `${restored ? RESTORED_NOTE : ""}wrote ${clean} (${content.length} chars)`;
}

export async function readWorkspaceFile(
  env: WorkspaceEnv,
  ws: WorkspaceRef,
  path: string,
  tree?: WorkspaceTree,
): Promise<string> {
  const clean = safePath(path);
  if (ws.filesInWorker) {
    const activeTree = tree ?? getWorkspaceTree(undefined, ws.runId);
    const entry = activeTree.get(clean);
    if (!entry || entry.deleted) {
      throw new Error(`No such file: ${clean}`);
    }
    if (entry.content === null) {
      throw new Error("This file is binary.");
    }
    return clip(entry.content);
  }
  const restored = await ensureCheckout(env, ws);
  const file = await sandboxFor(env, ws.projectId).readFile(`${ws.dir}/${clean}`);
  const content = "content" in file ? String(file.content) : "";
  return `${restored ? RESTORED_NOTE : ""}${clip(content)}`;
}

export async function deleteWorkspaceFile(
  env: WorkspaceEnv,
  ws: WorkspaceRef,
  path: string,
  tree?: WorkspaceTree,
): Promise<string> {
  const clean = safePath(path);
  if (ws.filesInWorker) {
    const activeTree = tree ?? getWorkspaceTree(undefined, ws.runId);
    const entry = activeTree.get(clean);
    if (!entry || entry.deleted) {
      throw new Error(`No such file: ${clean}`);
    }
    activeTree.delete(clean);
    return `deleted ${clean}`;
  }
  const restored = await ensureCheckout(env, ws);
  const sandbox = sandboxFor(env, ws.projectId);
  await sandbox.exec(`rm -f ${ws.dir}/${clean}`);
  return `${restored ? RESTORED_NOTE : ""}deleted ${clean}`;
}

export async function listWorkspaceFiles(
  env: WorkspaceEnv,
  ws: WorkspaceRef,
  prefix?: string,
  tree?: WorkspaceTree,
): Promise<string> {
  if (ws.filesInWorker) {
    const activeTree = tree ?? getWorkspaceTree(undefined, ws.runId);
    const all = activeTree.list();
    const cleanPrefix = prefix ? prefix.replace(/^\.?\//, "") : "";
    const files = cleanPrefix ? all.filter((f) => f.startsWith(cleanPrefix)) : all;
    return files.join("\n") || "No files match.";
  }
  const sandbox = sandboxFor(env, ws.projectId);
  const out = await run(sandbox, "git ls-files", ws.dir);
  const files = out.output.trim().split("\n").filter(Boolean);
  const cleanPrefix = prefix ? prefix.replace(/^\.?\//, "") : "";
  const matched = cleanPrefix ? files.filter((f) => f.startsWith(cleanPrefix)) : files;
  return matched.join("\n") || "No files match.";
}

/**
 * Stores the ChangeSet's own `git diff` for the Files changed view (P16-17).
 */
async function storePatch(
  env: WorkspaceEnv,
  sandbox: Sandbox,
  ws: WorkspaceRef,
  from: string,
  head: string,
): Promise<string | undefined> {
  try {
    const result = await sandbox.exec(patchCommand(from, head), {
      cwd: ws.dir,
      timeout: COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) return undefined;
    const bounded = boundPatch(result.stdout);
    const key = changeSetPatchKey(ws.projectId, `cs_${ws.runId.slice(4)}`);
    await env.EVIDENCE.put(key, bounded.patch, {
      httpMetadata: { contentType: "text/x-diff; charset=utf-8" },
      customMetadata: patchMetadata({ base: from, head, ...bounded }),
    });
    return key;
  } catch {
    console.warn(JSON.stringify({ event: "workspace.patch_write_failed", runId: ws.runId }));
    return undefined;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* publishWorkspace                                                                           */
/* ------------------------------------------------------------------------------------------ */

export async function publishWorkspace(
  env: WorkspaceEnv,
  ws: WorkspaceRef,
  message: string,
  tree?: WorkspaceTree,
): Promise<Published | null> {
  if (ws.filesInWorker) {
    const activeTree = tree ?? getWorkspaceTree(undefined, ws.runId);
    const dirtyFiles = activeTree.dirty();
    if (dirtyFiles.length === 0) return null;

    using repo = await env.ARTIFACTS.get(ws.fork);
    const info = await repo.info();
    const token = await repo.createToken("write", 600);
    const secret = token.plaintext.split("?expires=")[0] ?? token.plaintext;
    const onAuth = () => ({ username: "x", password: secret });
    const gitHttp = env.HTTP ?? http;

    try {
      const fs = createFsFromVolume(new Volume()) as unknown as MemFs;
      await git.init({ fs, dir: DIR, defaultBranch: "main" });
      await git.addRemote({ fs, dir: DIR, remote: "origin", url: info.remote, force: true });
      await git.fetch({
        fs,
        http: gitHttp,
        dir: DIR,
        remote: "origin",
        url: info.remote,
        ref: "main",
        singleBranch: true,
        tags: false,
        onAuth,
      });
      const head = await git.resolveRef({ fs, dir: DIR, ref: "refs/remotes/origin/main" });
      await git.writeRef({ fs, dir: DIR, ref: "refs/heads/main", value: head, force: true });
      await git.checkout({ fs, dir: DIR, ref: "main", force: true });

      const diffChanges: {
        path: string;
        before: string;
        after: string;
        oldBlob?: string;
        newBlob?: string;
        additions: number;
        deletions: number;
      }[] = [];

      for (const file of dirtyFiles) {
        let before = "";
        let oldBlob: string | undefined;
        try {
          const read = await git.readBlob({ fs, dir: DIR, oid: head, filepath: file.path });
          oldBlob = read.oid;
          if (!read.blob.includes(0)) {
            before = decoder.decode(read.blob);
          }
        } catch {
          // New file
        }

        if (file.deleted) {
          await fs.promises.unlink(`${DIR}/${file.path}`).catch(() => {});
          await git.remove({ fs, dir: DIR, filepath: file.path });
          const diff = unifiedFilePatch({
            path: file.path,
            before,
            after: "",
            ...(oldBlob ? { oldBlob } : {}),
          });
          diffChanges.push({
            path: file.path,
            before,
            after: "",
            ...(oldBlob ? { oldBlob } : {}),
            additions: diff.additions,
            deletions: diff.deletions,
          });
        } else {
          const content = file.content ?? "";
          const full = `${DIR}/${file.path}`;
          const parent = file.path.includes("/")
            ? file.path.slice(0, file.path.lastIndexOf("/"))
            : "";
          if (parent) await fs.promises.mkdir(`${DIR}/${parent}`, { recursive: true });
          await fs.promises.writeFile(full, content);
          await git.add({ fs, dir: DIR, filepath: file.path });
          const diff = unifiedFilePatch({
            path: file.path,
            before,
            after: content,
            ...(oldBlob ? { oldBlob } : {}),
          });
          diffChanges.push({
            path: file.path,
            before,
            after: content,
            ...(oldBlob ? { oldBlob } : {}),
            additions: diff.additions,
            deletions: diff.deletions,
          });
        }
      }

      const commitTime = Math.floor(Date.now() / 1000);
      const signature = {
        name: "Rhumbatron",
        email: "bot@rhumbatron.com",
        timestamp: commitTime,
        timezoneOffset: 0,
      };
      const commit = await git.commit({
        fs,
        dir: DIR,
        message: message.replace(/["$`\\]/g, "").slice(0, 120),
        author: signature,
        committer: signature,
      });

      const pushed = await git.push({
        fs,
        http: gitHttp,
        dir: DIR,
        url: info.remote,
        ref: "main",
        onAuth,
      });
      if (!pushed.ok)
        throw new Error(`push rejected: ${JSON.stringify(pushed.refs).slice(0, 200)}`);

      for (const change of diffChanges) {
        if (change.after !== "") {
          try {
            const { oid } = await git.readBlob({
              fs,
              dir: DIR,
              oid: commit,
              filepath: change.path,
            });
            change.newBlob = oid;
          } catch {}
        }
      }

      const patches = diffChanges
        .map(
          (c) =>
            unifiedFilePatch({
              path: c.path,
              before: c.before,
              after: c.after,
              ...(c.oldBlob ? { oldBlob: c.oldBlob } : {}),
              ...(c.newBlob ? { newBlob: c.newBlob } : {}),
            }).patch,
        )
        .filter(Boolean);
      const fullPatch = patches.join("\n");

      let patchRef: string | undefined;
      if (ws.manifest) {
        try {
          const bounded = boundPatch(fullPatch);
          const key = changeSetPatchKey(ws.projectId, `cs_${ws.runId.slice(4)}`);
          const fromCommit = ws.startCommit ?? ws.baseCommit;
          await env.EVIDENCE.put(key, bounded.patch, {
            httpMetadata: { contentType: "text/x-diff; charset=utf-8" },
            customMetadata: patchMetadata({ base: fromCommit, head: commit, ...bounded }),
          });
          patchRef = key;
        } catch {
          console.warn(JSON.stringify({ event: "workspace.patch_write_failed", runId: ws.runId }));
        }
      }

      const diffStat = formatDiffStat(diffChanges);
      const files = dirtyFiles.map((f) => f.path);
      const stack = ws.stack ?? [];
      const stacked = stack.length > 0 && !!ws.startCommit;

      if (ws.manifest) {
        ws.manifest = { ...ws.manifest, files, status: "published" };
        await writeManifest(env, ws);
      }

      return {
        fork: ws.fork,
        commit,
        baseCommit: ws.baseCommit,
        diffStat,
        files,
        stackedOn: stackedOn(stack),
        ...(stacked && ws.startCommit ? { startCommit: ws.startCommit, ownFiles: files } : {}),
        ...(patchRef ? { patchRef } : {}),
      };
    } finally {
      await repo.revokeToken(token.id).catch(() => false);
    }
  }

  // Fallback: Sandbox path
  if (await ensureCheckout(env, ws)) {
    throw new Error("Sandbox lost before publish; uncommitted workspace edits are gone");
  }
  const sandbox = sandboxFor(env, ws.projectId);
  await run(sandbox, "git add -A", ws.dir);
  const status = await run(sandbox, "git status --porcelain", ws.dir);
  if (!status.output.trim()) return null;
  await run(sandbox, `git commit -q -m "${message.replace(/["$`\\]/g, "").slice(0, 120)}"`, ws.dir);
  using repo = await env.ARTIFACTS.get(ws.fork);
  const token = await repo.createToken("write", 600);
  const secret = token.plaintext.split("?expires=")[0] ?? token.plaintext;
  const push = await run(
    sandbox,
    `git -c "http.extraHeader=$GIT_AUTH" push origin HEAD:main`,
    ws.dir,
    {
      GIT_AUTH: `Authorization: Bearer ${secret}`,
    },
  );
  await repo.revokeToken(token.id);
  if (!push.ok) throw new Error(`push failed (${push.exitCode})`);
  const commit = (await run(sandbox, "git rev-parse HEAD", ws.dir)).output.trim();
  const diffStat = (
    await run(sandbox, `git diff --stat ${ws.baseCommit} HEAD`, ws.dir)
  ).output.trim();
  const names = async (from: string) =>
    (await run(sandbox, `git diff --name-only ${from} HEAD`, ws.dir)).output
      .trim()
      .split("\n")
      .filter(Boolean);
  const files = await names(ws.baseCommit);
  const stack = ws.stack ?? [];
  const stacked = stack.length > 0 && !!ws.startCommit;
  const patchRef = ws.manifest
    ? await storePatch(
        env,
        sandbox,
        ws,
        stacked && ws.startCommit ? ws.startCommit : ws.baseCommit,
        commit,
      )
    : undefined;
  if (ws.manifest) {
    ws.manifest = { ...ws.manifest, files, status: "published" };
    await writeManifest(env, ws);
  }
  return {
    fork: ws.fork,
    commit,
    baseCommit: ws.baseCommit,
    diffStat,
    files,
    stackedOn: stackedOn(stack),
    ...(stacked && ws.startCommit
      ? { startCommit: ws.startCommit, ownFiles: await names(ws.startCommit) }
      : {}),
    ...(patchRef ? { patchRef } : {}),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* closeWorkspace                                                                             */
/* ------------------------------------------------------------------------------------------ */

export async function closeWorkspace(env: WorkspaceEnv, ws: WorkspaceRef, tree?: WorkspaceTree) {
  if (ws.manifest) {
    if (ws.manifest.status === "open") {
      try {
        const stored = await env.EVIDENCE.get(workspaceManifestKey(ws.manifest));
        const parsed = WorkspaceManifest.safeParse(stored ? await stored.json() : null);
        if (
          parsed.success &&
          workspaceManifestKey(parsed.data) === workspaceManifestKey(ws.manifest)
        ) {
          ws.manifest = parsed.data;
        }
      } catch {
        console.warn(JSON.stringify({ event: "workspace.manifest_read_failed", runId: ws.runId }));
      }
    }
    ws.manifest = {
      ...ws.manifest,
      status: "closed",
      sandbox: {
        ...ws.manifest.sandbox,
        closedAt: ws.manifest.sandbox.closedAt ?? new Date().toISOString(),
      },
    };
    await writeManifest(env, ws);
  }

  if (ws.filesInWorker) {
    // Only settle seconds and release Sandbox slot if the Sandbox container was actually started!
    if (ws.sandboxStarted) {
      const elapsed = Math.ceil((Date.now() - ws.openedAt) / 1000) + SLEEP_TAIL_SECONDS;
      await settleSeconds(env.DB, elapsed - OPEN_RESERVATION_SECONDS);
      await releaseSandbox(env.DB, ws.runId, new Date().toISOString());
      try {
        await sandboxFor(env, ws.projectId).exec(`rm -rf ${ws.dir}`);
      } catch {}
    }
    const activeTree = tree ?? getWorkspaceTree(undefined, ws.runId);
    activeTree.clear();
    return;
  }

  // Fallback: Sandbox path
  const elapsed = Math.ceil((Date.now() - ws.openedAt) / 1000) + SLEEP_TAIL_SECONDS;
  await settleSeconds(env.DB, elapsed - OPEN_RESERVATION_SECONDS);
  await releaseSandbox(env.DB, ws.runId, new Date().toISOString());
  try {
    await sandboxFor(env, ws.projectId).exec(`rm -rf ${ws.dir}`);
  } catch {}
}
