/** Starts the Git service on a free port with a temporary GIT_ROOT. */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { GitServiceClient } from "../client.ts";

const run = promisify(execFile);

const ADMIN_TOKEN = "test-admin-token-0123456789";
export const TOKEN_SECRET = "test-token-secret-0123456789abcdef0123";
const NAMESPACE = "rhumbatron";

export type Harness = {
  baseUrl: string;
  root: string;
  client: GitServiceClient;
  /** A scratch directory for clones. */
  scratch: string;
  stop: () => Promise<void>;
};

export async function startService(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "rhumbatron-git-"));
  const scratch = await mkdtemp(join(tmpdir(), "rhumbatron-git-work-"));
  const server = resolve(import.meta.dirname, "../src/server.ts");
  const child: ChildProcess = spawn("bun", [server], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GIT_ROOT: root,
      PORT: "0",
      GIT_ADMIN_TOKEN: ADMIN_TOKEN,
      GIT_TOKEN_SECRET: TOKEN_SECRET,
      GIT_NAMESPACE: NAMESPACE,
      GIT_PUBLIC_URL: "http://127.0.0.1:0",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise<number>((done, fail) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = /"port":(\d+)/.exec(out);
      if (match) done(Number(match[1]));
    });
    child.on("exit", (code) => fail(new Error(`git service exited with ${code}`)));
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    root,
    scratch,
    client: new GitServiceClient({ baseUrl, adminToken: ADMIN_TOKEN, namespace: NAMESPACE }),
    stop: async () => {
      child.kill();
      await rm(root, { recursive: true, force: true });
      await rm(scratch, { recursive: true, force: true });
    },
  };
}

/** Smart-HTTP URL for a repo on the test server (the advertised remote uses the compose host). */
export const repoUrl = (h: Harness, name: string) => `${h.baseUrl}/git/${name}.git`;

/** Strips the `?expires=` suffix, as the workers do. */
export const secretOf = (plaintext: string) => plaintext.split("?expires=")[0] ?? plaintext;

/** Runs the git CLI with no user config. Returns the exit code instead of throwing. */
export async function gitCli(args: string[], cwd?: string) {
  try {
    const { stdout, stderr } = await run("git", args, {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

/** Git with a Bearer header, like the Sandbox workspace code. */
export const withBearer = (token: string, args: string[]) => [
  "-c",
  `http.extraHeader=Authorization: Bearer ${token}`,
  ...args,
];
