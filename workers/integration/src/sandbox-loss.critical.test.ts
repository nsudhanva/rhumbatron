// Sandbox loss (P13-07). The Sandbox is disposable; the Candidate
// fork in Artifacts is durable. When the container restarts between steps, a check must run on a
// checkout restored from the fork at the composed commit, never on an empty or different tree.
import { beforeEach, describe, expect, it, vi } from "vitest";

type ExecResult = { exitCode: number; stdout: string; stderr: string };

/** Sandbox stand-in: one checkout directory whose HEAD is lost when the container restarts. */
const box = vi.hoisted(() => ({
  head: null as string | null,
  forkCommits: new Set<string>(),
  commands: [] as string[],
}));

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: () => ({
    async exec(command: string): Promise<ExecResult> {
      box.commands.push(command);
      const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
      if (command === "git rev-parse HEAD") {
        return box.head ? ok(box.head) : { exitCode: 128, stdout: "", stderr: "not a git repo" };
      }
      if (command.startsWith("rm -rf")) {
        box.head = null;
        return ok();
      }
      if (command.includes(" clone ")) return ok();
      const checkout = /^git checkout -q ([0-9a-f]{40})$/.exec(command);
      if (checkout?.[1]) {
        if (!box.forkCommits.has(checkout[1])) {
          return { exitCode: 1, stdout: "", stderr: "reference is not a tree" };
        }
        box.head = checkout[1];
        return ok();
      }
      if (command === "bun install") return ok();
      if (command === "bun test") return ok(" 12 pass\n 0 fail\n");
      return { exitCode: 127, stdout: "", stderr: `unexpected command ${command}` };
    },
  }),
}));

const { runCandidateCheck } = await import("./candidate-sandbox.ts");

const COMPOSED = "a".repeat(40);
const OTHER = "b".repeat(40);
const tokens = { created: 0, revoked: 0 };
// `using` in candidate-sandbox.ts disposes each repo handle; the lib target does not type the symbol.
const dispose = (Symbol as unknown as { dispose: symbol }).dispose;

const env = {
  SANDBOX: {},
  DB: {},
  ARTIFACTS: {
    async get(name: string) {
      return {
        async info() {
          return { remote: `https://artifacts.example/${name}.git` };
        },
        async createToken() {
          tokens.created += 1;
          return { id: `tok_${tokens.created}`, plaintext: "secret?expires=1" };
        },
        async revokeToken() {
          tokens.revoked += 1;
          return true;
        },
        [dispose]() {},
      };
    },
  },
} as unknown as Parameters<typeof runCandidateCheck>[0];

const check = () =>
  runCandidateCheck(env, {
    projectId: "proj_1",
    candidateId: "cand_abc123",
    commit: COMPOSED,
    command: "bun test",
    timeoutMs: 60_000,
  });

beforeEach(() => {
  box.head = null;
  box.forkCommits = new Set([COMPOSED]);
  box.commands = [];
  tokens.created = 0;
  tokens.revoked = 0;
});

describe("runCandidateCheck after Sandbox loss", () => {
  it("restores the checkout from the Candidate fork at the composed commit, then checks", async () => {
    const run = await check();
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain("12 pass");
    const clone = box.commands.findIndex((c) => c.includes(" clone "));
    const checkout = box.commands.indexOf(`git checkout -q ${COMPOSED}`);
    const test = box.commands.lastIndexOf("bun test");
    expect(clone).toBeGreaterThan(-1);
    expect(clone).toBeLessThan(checkout);
    expect(checkout).toBeLessThan(test);
    // The read token for the fork is revoked once the restore finished.
    expect(tokens).toEqual({ created: 1, revoked: 1 });
  });

  it("runs directly on an intact checkout, without touching the fork", async () => {
    box.head = COMPOSED;
    const run = await check();
    expect(run.exitCode).toBe(0);
    expect(box.commands).toEqual(["git rev-parse HEAD", "bun test"]);
    expect(tokens.created).toBe(0);
  });

  it("replaces a checkout that sits on a different commit", async () => {
    box.head = OTHER;
    await check();
    expect(box.commands).toContain(`git checkout -q ${COMPOSED}`);
    expect(box.head).toBe(COMPOSED);
  });

  it("fails instead of checking the wrong tree when the fork lost the commit", async () => {
    box.forkCommits = new Set();
    await expect(check()).rejects.toThrow(/git checkout/);
    expect(box.commands).not.toContain("bun test");
    expect(tokens).toEqual({ created: 1, revoked: 1 });
  });
});
