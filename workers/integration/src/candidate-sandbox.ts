import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import type { CheckRun, ComposeSource } from "./candidate-composer.ts";
import { candidateFork } from "./repo-names.ts";

export { candidateFork };

/**
 * Candidate source in the Project Sandbox (AGENTS.md sections 29.3, 30, 33). The Sandbox is the
 * same one Task workspaces use (one per Project, ADR 0011), with a directory per Candidate. Repo
 * tokens are short-lived, passed as environment variables, and never written to git config.
 */

/** HOM-192: hard stop at 10 Sandbox hours per calendar month. Same meter as Task workspaces. */
const MONTHLY_SECONDS = 36_000;
/** Reserved before the Sandbox opens: composition plus every check timeout, rounded up. */
const RESERVATION_SECONDS = 900;
/** Idle time billed after the last command, until the Sandbox sleeps. */
const SLEEP_TAIL_SECONDS = 120;
const GIT_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 64_000;
const SHA = /^[0-9a-f]{40}$/;

type CandidateEnv = { SANDBOX: DurableObjectNamespace; ARTIFACTS: Artifacts; DB: D1Database };

const month = () => new Date().toISOString().slice(0, 7);

/** Reserves Sandbox seconds on the shared monthly meter. False when the cap would be exceeded. */
export async function reserveSandbox(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO usage_counters (day, counter, count) VALUES (?, 'sandbox-seconds', ?)
       ON CONFLICT (day, counter) DO UPDATE SET count = count + ? WHERE count + ? <= ?
       RETURNING count`,
    )
    .bind(month(), RESERVATION_SECONDS, RESERVATION_SECONDS, RESERVATION_SECONDS, MONTHLY_SECONDS)
    .first<{ count: number }>();
  return row !== null;
}

/** Settles the reservation to wall time plus the idle tail. Never settles below zero use. */
export async function settleSandbox(db: D1Database, reservedAt: number) {
  const used = Math.ceil((Date.now() - reservedAt) / 1000) + SLEEP_TAIL_SECONDS;
  const delta = used - RESERVATION_SECONDS;
  if (delta === 0) return;
  await db
    .prepare(
      "UPDATE usage_counters SET count = MAX(0, count + ?) WHERE day = ? AND counter = 'sandbox-seconds'",
    )
    .bind(delta, month())
    .run();
}

const sandboxFor = (env: CandidateEnv, projectId: string) =>
  getSandbox(
    env.SANDBOX as unknown as DurableObjectNamespace<Sandbox>,
    `proj-${projectId.slice(5)}`,
    { sleepAfter: "2m" },
  );

const candidateDir = (candidateId: string) => `/workspace/cand-${candidateId.slice(5)}`;

/** The Sandbox drops stdout's trailing newline; keep stderr on its own line so line parsers work. */
const joinOutput = (stdout: string, stderr: string) =>
  stdout && stderr && !stdout.endsWith("\n") ? `${stdout}\n${stderr}` : `${stdout}${stderr}`;

function clip(text: string) {
  return text.length > MAX_OUTPUT_CHARS
    ? `… (earlier output cut)\n${text.slice(-MAX_OUTPUT_CHARS)}`
    : text;
}

/** Runs one command with a hard deadline. A deadline miss reports `timedOut`, never a result. */
async function exec(
  sandbox: Sandbox,
  command: string,
  opts: { cwd?: string; timeoutMs: number; env?: Record<string, string> },
): Promise<CheckRun> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), opts.timeoutMs + 5_000);
  });
  try {
    const result = await Promise.race([
      sandbox.exec(command, {
        timeout: opts.timeoutMs,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
      }),
      deadline,
    ]);
    if (result === "timeout") return { exitCode: null, output: "", timedOut: true };
    return {
      exitCode: result.exitCode,
      output: clip(joinOutput(result.stdout, result.stderr)),
      timedOut: false,
    };
  } catch (error) {
    const message = String(error);
    return {
      exitCode: null,
      output: "",
      timedOut: /timed?\s*out|timeout/i.test(message),
      error: message.slice(0, 300),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function must(sandbox: Sandbox, command: string, cwd: string, env?: Record<string, string>) {
  const run = await exec(sandbox, command, {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    ...(env ? { env } : {}),
  });
  if (run.exitCode !== 0) {
    // The command line holds no secret: tokens stay in the environment.
    throw new Error(
      `${command.split(" ").slice(0, 4).join(" ")} failed: ${run.error ?? run.output.slice(-300)}`,
    );
  }
  return run.output.trim();
}

/** Short-lived repo token as a git header value, plus its revoke handle. */
async function repoAuth(env: CandidateEnv, name: string, scope: "read" | "write") {
  using repo = await env.ARTIFACTS.get(name);
  const info = await repo.info();
  const token = await repo.createToken(scope, 600);
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

/** Forks the canonical repo for the Candidate. Safe to repeat: an existing fork is reused. */
export async function forkCandidate(env: CandidateEnv, projectId: string, candidateId: string) {
  const name = candidateFork(candidateId);
  using canonical = await env.ARTIFACTS.get(projectId);
  try {
    await canonical.fork(name, {
      description: `Candidate ${candidateId}`,
      defaultBranchOnly: true,
    });
  } catch (error) {
    // Retried step: the fork already exists. Anything else is a real failure.
    using existing = await env.ARTIFACTS.get(name).catch(() => {
      throw error;
    });
    await existing.info();
  }
  return name;
}

export type Composition =
  | { ok: true; commit: string; tree: string; merged: string[] }
  | { ok: false; changeSetId: string; files: string[]; detail: string };

/**
 * Clones the Candidate fork at the base commit, merges each ChangeSet commit in Work Graph order
 * (`--no-ff`), pushes the result, and installs dependencies. Commit dates are fixed per Candidate,
 * so a retried step produces the same commits and the push is a no-op.
 */
export async function composeCandidate(
  env: CandidateEnv,
  input: {
    projectId: string;
    candidateId: string;
    baseCommit: string;
    sources: readonly ComposeSource[];
    /** Unix seconds used as author and committer date of every merge commit. */
    commitTime: number;
  },
): Promise<Composition> {
  if (!SHA.test(input.baseCommit)) throw new Error("invalid base commit");
  const sandbox = sandboxFor(env, input.projectId);
  const dir = candidateDir(input.candidateId);
  const own = await repoAuth(env, candidateFork(input.candidateId), "write");
  const revokes = [own.revoke];
  try {
    await must(sandbox, `rm -rf ${dir} && mkdir -p ${dir}`, "/");
    await must(
      sandbox,
      `git -c "http.extraHeader=$GIT_AUTH" clone -q ${own.remote} .`,
      dir,
      own.header,
    );
    await must(
      sandbox,
      "git config user.name Rhumbatron && git config user.email bot@rhumbatron.com",
      dir,
    );
    await must(sandbox, `git checkout -q -B main ${input.baseCommit}`, dir);
    const date = {
      GIT_AUTHOR_DATE: `${input.commitTime} +0000`,
      GIT_COMMITTER_DATE: `${input.commitTime} +0000`,
    };
    const merged: string[] = [];
    for (const source of input.sources) {
      const theirs = await repoAuth(env, source.fork, "read");
      revokes.push(theirs.revoke);
      await must(
        sandbox,
        `git -c "http.extraHeader=$GIT_AUTH" fetch -q ${theirs.remote} +main:refs/rhumbatron/${source.id}`,
        dir,
        theirs.header,
      );
      const present = await exec(sandbox, `git cat-file -e ${source.commit}^{commit}`, {
        cwd: dir,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      if (present.exitCode !== 0) {
        return {
          ok: false,
          changeSetId: source.id,
          files: [],
          detail: `commit ${source.commit.slice(0, 12)} is not in fork ${source.fork}`,
        };
      }
      const merge = await exec(
        sandbox,
        `git merge -q --no-ff --no-edit -m "Compose ${source.id}" ${source.commit}`,
        { cwd: dir, timeoutMs: GIT_TIMEOUT_MS, env: date },
      );
      if (merge.exitCode !== 0) {
        const conflicted = await exec(sandbox, "git diff --name-only --diff-filter=U", {
          cwd: dir,
          timeoutMs: GIT_TIMEOUT_MS,
        });
        await exec(sandbox, "git merge --abort", { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
        return {
          ok: false,
          changeSetId: source.id,
          files: conflicted.output.trim().split("\n").filter(Boolean).slice(0, 50),
          detail:
            merge.error ?? merge.output.trim().split("\n").slice(-3).join(" | ").slice(0, 300),
        };
      }
      merged.push(source.id);
    }
    await must(
      sandbox,
      `git -c "http.extraHeader=$GIT_AUTH" push -q origin HEAD:main`,
      dir,
      own.header,
    );
    const commit = await must(sandbox, "git rev-parse HEAD", dir);
    const tree = await must(sandbox, "git rev-parse HEAD^{tree}", dir);
    const install = await exec(sandbox, "bun install", { cwd: dir, timeoutMs: INSTALL_TIMEOUT_MS });
    if (install.exitCode !== 0) {
      throw new Error(`bun install failed: ${install.error ?? install.output.slice(-300)}`);
    }
    return { ok: true, commit, tree, merged };
  } finally {
    for (const revoke of revokes) await revoke();
  }
}

/**
 * Makes sure the Candidate checkout exists at the composed commit. After Sandbox loss the
 * directory is gone; the fork still has the commit, so the checkout is restored from it (42.5).
 */
async function ensureCheckout(
  env: CandidateEnv,
  sandbox: Sandbox,
  input: { candidateId: string; commit: string },
) {
  const dir = candidateDir(input.candidateId);
  const head = await exec(sandbox, "git rev-parse HEAD", { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
  if (head.exitCode === 0 && head.output.trim() === input.commit) return dir;
  const own = await repoAuth(env, candidateFork(input.candidateId), "read");
  try {
    await must(sandbox, `rm -rf ${dir} && mkdir -p ${dir}`, "/");
    await must(
      sandbox,
      `git -c "http.extraHeader=$GIT_AUTH" clone -q ${own.remote} .`,
      dir,
      own.header,
    );
    await must(sandbox, `git checkout -q ${input.commit}`, dir);
    const install = await exec(sandbox, "bun install", { cwd: dir, timeoutMs: INSTALL_TIMEOUT_MS });
    if (install.exitCode !== 0) throw new Error("bun install failed after restore");
  } finally {
    await own.revoke();
  }
  return dir;
}

/** Runs one allow-listed check command in the Candidate checkout with the check timeout. */
export async function runCandidateCheck(
  env: CandidateEnv,
  input: {
    projectId: string;
    candidateId: string;
    commit: string;
    command: string;
    timeoutMs: number;
  },
): Promise<CheckRun & { startedAt: string; completedAt: string }> {
  const sandbox = sandboxFor(env, input.projectId);
  const dir = await ensureCheckout(env, sandbox, input);
  // Timed around the command only, so a Sandbox restore does not count against the check timeout.
  const startedAt = new Date().toISOString();
  const run = await exec(sandbox, input.command, { cwd: dir, timeoutMs: input.timeoutMs });
  return { ...run, startedAt, completedAt: new Date().toISOString() };
}

/**
 * Prints the route table of the composed commit and of its base (section 34.1 contract check).
 * The base is a detached worktree beside the checkout, read with the checkout's dependencies, so
 * one install serves both. The worktree is removed afterwards.
 */
export async function runContractCheck(
  env: CandidateEnv,
  input: {
    projectId: string;
    candidateId: string;
    commit: string;
    baseCommit: string;
    timeoutMs: number;
  },
): Promise<{ candidate: CheckRun; base: CheckRun; startedAt: string; completedAt: string }> {
  if (!SHA.test(input.baseCommit)) throw new Error("invalid base commit");
  const sandbox = sandboxFor(env, input.projectId);
  const dir = await ensureCheckout(env, sandbox, input);
  const base = `${dir}-base`;
  const startedAt = new Date().toISOString();
  try {
    await must(sandbox, `rm -rf ${base} && git worktree prune`, dir);
    await must(sandbox, `git worktree add -f --detach ${base} ${input.baseCommit}`, dir);
    await must(sandbox, `ln -sfn ${dir}/node_modules ${base}/node_modules`, dir);
    const candidate = await exec(sandbox, "bun run contract", {
      cwd: dir,
      timeoutMs: input.timeoutMs,
    });
    const baseRun = await exec(sandbox, "bun run contract", {
      cwd: dir,
      timeoutMs: input.timeoutMs,
      env: { CONTRACT_ROOT: base },
    });
    return { candidate, base: baseRun, startedAt, completedAt: new Date().toISOString() };
  } finally {
    await exec(sandbox, `git worktree remove --force ${base}; rm -rf ${base}`, {
      cwd: dir,
      timeoutMs: GIT_TIMEOUT_MS,
    });
  }
}

/** Removes the Candidate directory. The fork keeps the composed source until the fork sweep (HOM-195). */
export async function removeCandidateDir(
  env: CandidateEnv,
  projectId: string,
  candidateId: string,
) {
  try {
    await sandboxFor(env, projectId).exec(`rm -rf ${candidateDir(candidateId)}`);
  } catch {
    // A sleeping or lost Sandbox already dropped the directory.
  }
}

/** Port of the Candidate preview server: stable per Candidate, clear of the Sandbox control port. */
function previewPort(candidateId: string) {
  let hash = 2166136261;
  for (const ch of candidateId) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  return 20_000 + ((hash >>> 0) % 10_000);
}

export type CandidatePreview = {
  port: number;
  /** Sends one request to the preview server inside the Sandbox. No public URL exists. */
  fetch(path: string, init: RequestInit): Promise<Response>;
  stop(): Promise<void>;
};

/**
 * Starts the composed app (`bun run dev`, fixed in code) on its preview port for the browser check
 * (AGENTS.md section 35). The preview is reached only through the Sandbox Durable Object
 * (`containerFetch`), never through an exposed preview URL, so it needs no wildcard route and no
 * public hostname. Throws when the server does not answer within `readyMs`.
 */
export async function startCandidatePreview(
  env: CandidateEnv,
  input: { projectId: string; candidateId: string; commit: string; readyMs: number },
): Promise<CandidatePreview> {
  const sandbox = sandboxFor(env, input.projectId);
  const dir = await ensureCheckout(env, sandbox, input);
  const port = previewPort(input.candidateId);
  const processId = `preview-${input.candidateId.slice(5)}`;
  // A retried step may find the previous server; restart it so the in-memory store starts empty.
  await sandbox.killProcess(processId).catch(() => undefined);
  const server = await sandbox.startProcess("bun run dev", {
    cwd: dir,
    env: { PORT: String(port) },
    processId,
  });
  const stop = async () => {
    await sandbox.killProcess(processId).catch(() => undefined);
  };
  try {
    await server.waitForPort(port, { path: "/", timeout: input.readyMs });
  } catch (error) {
    const logs = await sandbox
      .getProcessLogs(processId)
      .then((l) => joinOutput(l.stdout, l.stderr).slice(-300))
      .catch(() => "");
    await stop();
    throw new Error(`preview did not answer on :${port}: ${String(error).slice(0, 200)} ${logs}`);
  }
  return {
    port,
    fetch: (path, init) => sandbox.containerFetch(`http://localhost:${port}${path}`, init, port),
    stop,
  };
}
