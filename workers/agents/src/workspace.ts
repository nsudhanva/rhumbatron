import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import {
  admitSandbox,
  type LimitKey,
  noteSandboxRefused,
  releaseSandbox,
  sandboxLimitReason,
} from "./limits.ts";
import type { StackSource } from "./stack.ts";

/**
 * Task Workspace (AGENTS.md sections 29.2 and 30): an Artifacts fork of the canonical repo,
 * checked out in a Sandbox directory. One Sandbox per Project (max 1 instance, sleeps after
 * 2 minutes idle); a directory per run. The Sandbox never holds infrastructure credentials, and
 * the repo token stays out of the checkout's git config.
 */

/**
 * HOM-192: hard stop at 10 Sandbox hours per calendar month, counted conservatively. ADR 0017
 * splits the 10 hours between dev and prod: each environment's `SANDBOX_MONTHLY_SECONDS` binding
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
/** Idle time billed after the last command, until the Sandbox sleeps. */
const SLEEP_TAIL_SECONDS = 600;
const COMMAND_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 12_000;

/** Commands an agent may run. No shell metacharacters, no network tools, no package publishing. */
const ALLOWED = [
  /^bun install( --frozen-lockfile)?$/,
  /^bun test( [\w./-]+)*$/,
  /^bun run (typecheck|test|bench)$/,
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
};

type WorkspaceEnv = {
  SANDBOX: DurableObjectNamespace;
  ARTIFACTS: Artifacts;
  DB: D1Database;
  SANDBOX_MONTHLY_SECONDS?: string;
};

const sandboxFor = (env: WorkspaceEnv, projectId: string) =>
  // Cross-script binding to the Sandbox Worker's class (ADR 0012).
  getSandbox(
    env.SANDBOX as unknown as DurableObjectNamespace<Sandbox>,
    `proj-${projectId.slice(5)}`,
    {
      // Longer than a slow model call, so an idle wait between calls keeps the checkout and the
      // agent's uncommitted edits. The monthly meter (HOM-192) still caps Sandbox time.
      sleepAfter: "10m",
    },
  );

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
      /** Two dependency ChangeSets do not merge: the Task cannot start from their combined work. */
      refused: "dependency_merge_conflict";
      message: string;
      changeSetId: string;
      files: string[];
    };

const SHA = /^[0-9a-f]{40}$/;

type Prepared =
  | { ok: true; startCommit: string }
  | { ok: false; changeSetId: string; files: string[]; detail: string };

/**
 * Builds the run directory: clones the workspace fork, checks out the canonical base, then merges
 * each stacked dependency commit in order with fixed identity and dates. The same inputs give the
 * same start commit, so a Sandbox restore reproduces the stacked start (section 42.5). Repo tokens
 * are read-scoped, short-lived, passed through the environment, and revoked here.
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
  return { ok: true, startCommit: head.output.trim() };
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

/**
 * Forks the canonical repo and checks it out in the Project Sandbox. Refused, with no fork and no
 * Sandbox work, when the Change already has its maximum of open coding Sandboxes (section 44) or
 * the monthly Sandbox meter is used up.
 */
export async function openWorkspace(
  env: WorkspaceEnv,
  input: {
    projectId: string;
    /** The Task run's Change and Task. Absent only for the Sandbox smoke check, which has no Change. */
    change?: { changeId: string; taskId: string };
    runId: string;
    baseCommit: string;
    /** Dependency ChangeSets to merge onto the base, in order (`stackFor`). */
    stack?: readonly StackSource[];
  },
): Promise<WorkspaceRef | WorkspaceRefused> {
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
  const fork = `ws-${input.runId.slice(4)}`;
  const dir = `/workspace/${input.runId.slice(-24)}`;
  const stack = input.stack ?? [];
  const stackTime = Math.floor(Date.now() / 1000);
  // A failed open must not leave a fork or a reservation behind (cost report: leftovers).
  const undo = async () => {
    await env.ARTIFACTS.delete(fork).catch(() => false);
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
      // Retried run: the fork already exists.
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
  return {
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
}

/**
 * Restores the run directory after Sandbox loss (section 42.5): the same clone, base, and stacked
 * merges, checked against the recorded start commit. Uncommitted edits made before the loss are
 * gone; the caller tells the agent. False when the checkout was intact.
 */
async function ensureCheckout(env: WorkspaceEnv, ws: WorkspaceRef): Promise<boolean> {
  const sandbox = sandboxFor(env, ws.projectId);
  // A lost Sandbox may not even have the directory; exec then throws instead of exiting non-zero.
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
    // Never leave a checkout on a different tree for the next tool call to use.
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

export async function runCommand(
  env: WorkspaceEnv,
  ws: WorkspaceRef,
  command: string,
): Promise<string> {
  const cmd = command.trim();
  if (FORBIDDEN_CHARS.test(cmd) || !ALLOWED.some((re) => re.test(cmd))) {
    return `Not allowed: ${cmd}\nAllowed: bun install, bun test [paths], bun run typecheck|test|bench, bunx tsc --noEmit, git status|diff|log, ls.`;
  }
  const restored = await ensureCheckout(env, ws);
  const result = await run(sandboxFor(env, ws.projectId), cmd, ws.dir);
  return `${restored ? RESTORED_NOTE : ""}exit ${result.exitCode}\n${result.output}`;
}

const safePath = (path: string) => {
  const clean = path.replace(/^\.?\//, "");
  if (clean.includes("..") || clean.startsWith("/") || clean.startsWith(".git"))
    throw new Error(`invalid path ${path}`);
  return clean;
};

export async function writeWorkspaceFile(
  env: WorkspaceEnv,
  ws: WorkspaceRef,
  path: string,
  content: string,
) {
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

/** Commits all changes and pushes them to the fork. Null when nothing changed. */
export async function publishWorkspace(
  env: WorkspaceEnv,
  ws: WorkspaceRef,
  message: string,
): Promise<Published | null> {
  // Publishing a restored checkout would drop the agent's lost edits silently: fail the run instead.
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
  // `files` and `diffStat` stay relative to the canonical base, so composition is a merge onto
  // canonical; `ownFiles` is what this Task changed on top of its stacked dependencies.
  const files = await names(ws.baseCommit);
  const stack = ws.stack ?? [];
  return {
    fork: ws.fork,
    commit,
    baseCommit: ws.baseCommit,
    diffStat,
    files,
    stackedOn: stack.map((s) => s.changeSetId),
    ...(stack.length > 0 && ws.startCommit
      ? { startCommit: ws.startCommit, ownFiles: await names(ws.startCommit) }
      : {}),
  };
}

/** Settles the meter for this session and removes the run directory. The Sandbox sleeps itself. */
export async function closeWorkspace(env: WorkspaceEnv, ws: WorkspaceRef) {
  const elapsed = Math.ceil((Date.now() - ws.openedAt) / 1000) + SLEEP_TAIL_SECONDS;
  await settleSeconds(env.DB, elapsed - OPEN_RESERVATION_SECONDS);
  // Frees the Change's Sandbox slot (section 44) before the directory cleanup, which may fail.
  await releaseSandbox(env.DB, ws.runId, new Date().toISOString());
  try {
    await sandboxFor(env, ws.projectId).exec(`rm -rf ${ws.dir}`);
  } catch {
    // A sleeping or lost Sandbox already dropped the directory; the fork keeps the work.
  }
}
