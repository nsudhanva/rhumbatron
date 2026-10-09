import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

/**
 * Task Workspace (AGENTS.md sections 29.2 and 30): an Artifacts fork of the canonical repo,
 * checked out in a Sandbox directory. One Sandbox per Project (max 1 instance, sleeps after
 * 2 minutes idle); a directory per run. The Sandbox never holds infrastructure credentials, and
 * the repo token stays out of the checkout's git config.
 */

/** HOM-192: hard stop at 10 Sandbox hours per calendar month, counted conservatively. */
const MONTHLY_SECONDS = 36_000;
/** Charged when a session opens; the rest is settled when it closes. */
const OPEN_RESERVATION_SECONDS = 300;
/** Idle time billed after the last command, until the Sandbox sleeps. */
const SLEEP_TAIL_SECONDS = 120;
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
async function reserveSeconds(db: D1Database, seconds: number): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO usage_counters (day, counter, count) VALUES (?, 'sandbox-seconds', ?)
       ON CONFLICT (day, counter) DO UPDATE SET count = count + ? WHERE count + ? <= ?
       RETURNING count`,
    )
    .bind(month(), seconds, seconds, seconds, MONTHLY_SECONDS)
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
};

export type Published = {
  fork: string;
  commit: string;
  baseCommit: string;
  diffStat: string;
  files: string[];
};

type WorkspaceEnv = {
  SANDBOX: DurableObjectNamespace<Sandbox>;
  ARTIFACTS: Artifacts;
  DB: D1Database;
};

const sandboxFor = (env: WorkspaceEnv, projectId: string) =>
  getSandbox(env.SANDBOX, `proj-${projectId.slice(5)}`, { sleepAfter: "2m" });

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
    output: clip(`${result.stdout}${result.stderr}`),
  };
}

/** Forks the canonical repo and checks it out in the Project Sandbox. Null when the cap is reached. */
export async function openWorkspace(
  env: WorkspaceEnv,
  input: { projectId: string; runId: string; baseCommit: string },
): Promise<WorkspaceRef | null> {
  if (!(await reserveSeconds(env.DB, OPEN_RESERVATION_SECONDS))) return null;
  const fork = `ws-${input.runId.slice(4)}`;
  const dir = `/workspace/${input.runId.slice(-24)}`;
  using canonical = await env.ARTIFACTS.get(input.projectId);
  let remote: string;
  try {
    remote = (
      await canonical.fork(fork, {
        description: `Workspace for ${input.runId}`,
        defaultBranchOnly: true,
      })
    ).remote;
  } catch {
    // Retried run: the fork already exists.
    using existing = await env.ARTIFACTS.get(fork);
    remote = (await existing.info()).remote;
  }
  try {
    using repo = await env.ARTIFACTS.get(fork);
    const token = await repo.createToken("write", 3600);
    const secret = token.plaintext.split("?expires=")[0] ?? token.plaintext;
    const sandbox = sandboxFor(env, input.projectId);
    const auth = { GIT_AUTH: `Authorization: Bearer ${secret}` };
    await sandbox.exec(`rm -rf ${dir} && mkdir -p ${dir}`);
    const clone = await run(
      sandbox,
      `git -c "http.extraHeader=$GIT_AUTH" clone ${remote} .`,
      dir,
      auth,
    );
    if (!clone.ok) throw new Error(`clone failed (${clone.exitCode})`);
    await run(
      sandbox,
      "git config user.name Rhumbatron && git config user.email bot@rhumbatron.com",
      dir,
    );
    await run(sandbox, "bun install", dir);
    await repo.revokeToken(token.id);
  } catch (error) {
    // A failed open must not leave a fork or a reservation behind (cost report: leftovers).
    await env.ARTIFACTS.delete(fork).catch(() => false);
    await settleSeconds(env.DB, -OPEN_RESERVATION_SECONDS);
    throw error;
  }
  return {
    projectId: input.projectId,
    runId: input.runId,
    fork,
    dir,
    baseCommit: input.baseCommit,
    openedAt: Date.now(),
  };
}

export async function runCommand(
  env: WorkspaceEnv,
  ws: WorkspaceRef,
  command: string,
): Promise<string> {
  const cmd = command.trim();
  if (FORBIDDEN_CHARS.test(cmd) || !ALLOWED.some((re) => re.test(cmd))) {
    return `Not allowed: ${cmd}\nAllowed: bun install, bun test [paths], bun run typecheck|test|bench, bunx tsc --noEmit, git status|diff|log, ls.`;
  }
  const result = await run(sandboxFor(env, ws.projectId), cmd, ws.dir);
  return `exit ${result.exitCode}\n${result.output}`;
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
  const sandbox = sandboxFor(env, ws.projectId);
  const parent = clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
  if (parent) await sandbox.exec(`mkdir -p ${ws.dir}/${parent}`);
  await sandbox.writeFile(`${ws.dir}/${clean}`, content);
  return `wrote ${clean} (${content.length} chars)`;
}

export async function readWorkspaceFile(
  env: WorkspaceEnv,
  ws: WorkspaceRef,
  path: string,
): Promise<string> {
  const file = await sandboxFor(env, ws.projectId).readFile(`${ws.dir}/${safePath(path)}`);
  const content = "content" in file ? String(file.content) : "";
  return clip(content);
}

/** Commits all changes and pushes them to the fork. Null when nothing changed. */
export async function publishWorkspace(
  env: WorkspaceEnv,
  ws: WorkspaceRef,
  message: string,
): Promise<Published | null> {
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
  const files = (await run(sandbox, `git diff --name-only ${ws.baseCommit} HEAD`, ws.dir)).output
    .trim()
    .split("\n")
    .filter(Boolean);
  return { fork: ws.fork, commit, baseCommit: ws.baseCommit, diffStat, files };
}

/** Settles the meter for this session and removes the run directory. The Sandbox sleeps itself. */
export async function closeWorkspace(env: WorkspaceEnv, ws: WorkspaceRef) {
  const elapsed = Math.ceil((Date.now() - ws.openedAt) / 1000) + SLEEP_TAIL_SECONDS;
  await settleSeconds(env.DB, elapsed - OPEN_RESERVATION_SECONDS);
  try {
    await sandboxFor(env, ws.projectId).exec(`rm -rf ${ws.dir}`);
  } catch {
    // A sleeping or lost Sandbox already dropped the directory; the fork keeps the work.
  }
}
