/** Runs the `git` CLI with an isolated configuration: no system or user config, no prompts. */

export const gitEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME ?? "/tmp",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  ...extra,
});

export type GitResult = { code: number; stdout: Uint8Array<ArrayBuffer>; stderr: string };

export async function git(
  args: string[],
  opts: { cwd?: string; stdin?: string; timeoutMs?: number } = {},
): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env: gitEnv(),
    stdin: opts.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs ?? 120_000,
  });
  // Write stdin, then close it so the child sees end of input.
  if (opts.stdin !== undefined && proc.stdin) {
    proc.stdin.write(opts.stdin);
    await proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer().then((buffer) => new Uint8Array(buffer)),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Like `git`, but throws on a non-zero exit and returns stdout as text. */
export async function gitText(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
  const result = await git(args, opts);
  if (result.code !== 0) {
    throw new Error(`git ${args[0]} failed (${result.code}): ${result.stderr.trim().slice(-300)}`);
  }
  return new TextDecoder().decode(result.stdout);
}
