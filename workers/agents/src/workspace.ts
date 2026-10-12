import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import {
  boundPatch,
  changeSetPatchKey,
  patchCommand,
  patchMetadata,
  WorkspaceManifest,
  workspaceManifestKey,
} from "@rhumbatron/protocol";
import {
  admitSandbox,
  type LimitKey,
  noteSandboxRefused,
  releaseSandbox,
  sandboxLimitReason,
} from "./limits.ts";
import { type StackSource, stackedOn } from "./stack.ts";

/**
 * Task Workspace: all file tools and commands run on a checkout in the Sandbox container.
 */

/**
 * Hard stop at the monthly Sandbox hours, counted conservatively. ADR 0017 sets prod at 20
 * hours: the `SANDBOX_MONTHLY_SECONDS` binding sets the meter. This is the fallback when the binding is absent.
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
/** Increment when ALLOWED, FIXED_SCRIPTS, RUN_SCRIPT, or FORBIDDEN_CHARS changes. */
const COMMAND_ALLOWLIST_VERSION = 3;
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
  /^bunx tsc --noEmit$/,
  /^git (status|diff|log)( [\w./:=-]+)*$/,
  /^ls( -[al]+)?( [\w./-]+)?$/,
];
/**
 * `bun run <name>`: these names always, any other name only when it is a script in the
 * workspace package.json. A script runs in the same Sandbox, with the same network policy, as
 * `bun test`.
 */
const FIXED_SCRIPTS = new Set(["typecheck", "test", "bench", "contract", "build"]);
const RUN_SCRIPT = /^bun run ([\w:][\w:.-]*)$/;
/** Scripts whose output files the workspace discards: composition builds them. */
const BUILD_SCRIPT = /^build(:[\w:.-]+)?$/;
const FORBIDDEN_CHARS = /[;&|`$<>\\\n]/;
const ALLOWED_TEXT =
  "bun install, bun test [paths], bun run typecheck|test|bench|contract|build, bun run <a script in package.json>, bunx tsc --noEmit, git status|diff|log, ls";

/** The script `bun run <name>` names, or null for another command. */
const runScriptName = (cmd: string) => RUN_SCRIPT.exec(cmd)?.[1] ?? null;

/** Script names of a package.json text. Empty when it is absent or not valid JSON. */
export function packageScripts(packageJson: string | null | undefined): string[] {
  if (!packageJson) return [];
  try {
    const scripts = (JSON.parse(packageJson) as { scripts?: unknown } | null)?.scripts;
    return scripts && typeof scripts === "object" && !Array.isArray(scripts)
      ? Object.keys(scripts)
      : [];
  } catch {
    return [];
  }
}

/** True when the command is on the allowlist. `scripts` are the package.json script names. */
export function commandAllowed(cmd: string, scripts: readonly string[] = []): boolean {
  if (FORBIDDEN_CHARS.test(cmd)) return false;
  const script = runScriptName(cmd);
  if (script !== null) return FIXED_SCRIPTS.has(script) || scripts.includes(script);
  return ALLOWED.some((re) => re.test(cmd));
}

/** True for `bun run build` and `bun run build:<x>`: their output files are not kept. */
export const isBuildCommand = (cmd: string) => BUILD_SCRIPT.test(runScriptName(cmd) ?? "");

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
  /** R2 key of this ChangeSet's stored `git diff`. Absent when it was not stored. */
  patchRef?: string;
};

export type WorkspaceEnv = {
  SANDBOX: DurableObjectNamespace;
  ARTIFACTS: Artifacts;
  DB: D1Database;
  EVIDENCE: R2Bucket;
  SANDBOX_MONTHLY_SECONDS?: string;
};

/* ------------------------------------------------------------------------------------------ */
/* Path Validation                                                                            */
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
  },
): Promise<WorkspaceRef | WorkspaceRefused> {
  const fork = `ws-${input.runId.slice(4)}`;
  const dir = `/workspace/${input.runId.slice(-24)}`;
  const stack = input.stack ?? [];
  const stackTime = Math.floor(Date.now() / 1000);

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
 * Restores the run directory after Sandbox loss.
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
): Promise<string> {
  const cmd = command.trim();
  const notAllowed = `Not allowed: ${cmd}\nAllowed: ${ALLOWED_TEXT}.`;
  const script = runScriptName(cmd);
  // `bun run <name>` with another name passes only when package.json defines it (checked below).
  if (script === null && !commandAllowed(cmd)) return notAllowed;

  const restored = await ensureCheckout(env, ws);
  const sandbox = sandboxFor(env, ws.projectId);
  if (script !== null && !FIXED_SCRIPTS.has(script)) {
    const pkg = await sandbox.readFile(`${ws.dir}/package.json`).catch(() => null);
    const text = pkg && "content" in pkg ? String(pkg.content) : null;
    if (!commandAllowed(cmd, packageScripts(text))) return notAllowed;
  }
  const before = isBuildCommand(cmd) ? await statusPaths(sandbox, ws.dir) : null;
  const result = await run(sandbox, cmd, ws.dir);
  const discarded = before ? await discardOutputs(sandbox, ws.dir, before) : [];
  return `${restored ? RESTORED_NOTE : ""}exit ${result.exitCode}\n${result.output}${discardedNote(discarded)}`;
}

/** A path safe in a shell command line without quoting. */
const PLAIN_PATH = /^[\w@+-][\w./@+-]*$/;

/** `git status --porcelain -uall` as path -> status code. Quoted (unusual) paths are left out. */
async function statusPaths(sandbox: Sandbox, dir: string): Promise<Map<string, string>> {
  const status = await run(sandbox, "git status --porcelain -uall", dir);
  const out = new Map<string, string>();
  for (const line of status.output.split("\n")) {
    if (line.length < 4) continue;
    const path = line.slice(3).trim();
    if (!path.includes(" -> ") && !path.startsWith('"')) out.set(path, line.slice(0, 2));
  }
  return out;
}

/**
 * Discards the files a build command wrote that were unchanged before it: tracked files go back
 * to HEAD, new files are removed. Composition runs the build again and commits its output, so a
 * ChangeSet never carries build output (two sibling ChangeSets would conflict on it).
 */
async function discardOutputs(
  sandbox: Sandbox,
  dir: string,
  before: Map<string, string>,
): Promise<string[]> {
  const after = await statusPaths(sandbox, dir);
  const written = [...after].filter(([path]) => !before.has(path) && PLAIN_PATH.test(path));
  const added = written.filter(([, code]) => code === "??").map(([path]) => path);
  const changed = written.filter(([, code]) => code !== "??").map(([path]) => path);
  if (changed.length) await run(sandbox, `git checkout -q HEAD -- ${changed.join(" ")}`, dir);
  if (added.length) await run(sandbox, `rm -f ${added.join(" ")}`, dir);
  return [...changed, ...added];
}

const discardedNote = (paths: readonly string[]) =>
  paths.length
    ? `\nBuild output not kept (${paths.slice(0, 10).join(", ")}${paths.length > 10 ? ", ..." : ""}): composition runs bun run build and commits it.`
    : "";

/* ------------------------------------------------------------------------------------------ */
/* File Access Tools                                                                          */
/* ------------------------------------------------------------------------------------------ */

export async function writeWorkspaceFile(
  env: WorkspaceEnv,
  ws: WorkspaceRef,
  path: string,
  content: string,
): Promise<string> {
  const clean = safePath(path);
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
): Promise<string> {
  const clean = safePath(path);
  const restored = await ensureCheckout(env, ws);
  const file = await sandboxFor(env, ws.projectId).readFile(`${ws.dir}/${clean}`);
  const content = "content" in file ? String(file.content) : "";
  return `${restored ? RESTORED_NOTE : ""}${clip(content)}`;
}

export async function deleteWorkspaceFile(
  env: WorkspaceEnv,
  ws: WorkspaceRef,
  path: string,
): Promise<string> {
  const clean = safePath(path);
  const restored = await ensureCheckout(env, ws);
  const sandbox = sandboxFor(env, ws.projectId);
  await sandbox.exec(`rm -f ${ws.dir}/${clean}`);
  return `${restored ? RESTORED_NOTE : ""}deleted ${clean}`;
}

export async function listWorkspaceFiles(
  env: WorkspaceEnv,
  ws: WorkspaceRef,
  prefix?: string,
): Promise<string> {
  const sandbox = sandboxFor(env, ws.projectId);
  const out = await run(sandbox, "git ls-files", ws.dir);
  const files = out.output.trim().split("\n").filter(Boolean);
  const cleanPrefix = prefix ? prefix.replace(/^\.?\//, "") : "";
  const matched = cleanPrefix ? files.filter((f) => f.startsWith(cleanPrefix)) : files;
  return matched.join("\n") || "No files match.";
}

/**
 * Stores the ChangeSet's own `git diff` for the Files changed view.
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
): Promise<Published | null> {
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

export async function closeWorkspace(env: WorkspaceEnv, ws: WorkspaceRef) {
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

  const elapsed = Math.ceil((Date.now() - ws.openedAt) / 1000) + SLEEP_TAIL_SECONDS;
  await settleSeconds(env.DB, elapsed - OPEN_RESERVATION_SECONDS);
  await releaseSandbox(env.DB, ws.runId, new Date().toISOString());
  try {
    await sandboxFor(env, ws.projectId).exec(`rm -rf ${ws.dir}`);
  } catch {}
}
