// The agent command allowlist. `bun run build` and the
// scripts of the workspace package.json are allowed; shell metacharacters and other commands are
// not. A build in a workspace never leaves its output in the ChangeSet: composition builds it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const box = vi.hoisted(() => ({
  commands: [] as string[],
  files: new Map<string, string>(),
  status: "",
}));
vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: () => ({
    async exec(command: string) {
      box.commands.push(command);
      if (command === "bun run build")
        box.status = " M src/client/app.tsx\n M public/app.js\n?? public/app.css";
      const stdout =
        command === "git rev-parse HEAD"
          ? "a".repeat(40)
          : command === "git status --porcelain -uall"
            ? box.status
            : "";
      return { exitCode: 0, stdout, stderr: "" };
    },
    async readFile(path: string) {
      const content = box.files.get(path);
      if (content === undefined) throw new Error("not found");
      return { content };
    },
  }),
}));
const { commandAllowed, isBuildCommand, packageScripts, runCommand } = await import(
  "./workspace.ts"
);

describe("agent command allowlist", () => {
  it("allows the fixed commands and bun run build", () => {
    for (const cmd of [
      "bun install",
      "bun test test/a.test.ts",
      "bun run typecheck",
      "bun run contract",
      "bun run build",
      "bunx tsc --noEmit",
      "git diff",
      "ls -la src",
    ]) {
      expect(commandAllowed(cmd), cmd).toBe(true);
    }
  });

  it("allows another bun run script only when package.json defines it", () => {
    const scripts = packageScripts(JSON.stringify({ scripts: { "build:css": "x", lint: "y" } }));
    expect(scripts).toEqual(["build:css", "lint"]);
    expect(commandAllowed("bun run lint", scripts)).toBe(true);
    expect(commandAllowed("bun run lint")).toBe(false);
    expect(commandAllowed("bun run deploy", scripts)).toBe(false);
    expect(packageScripts("not json")).toEqual([]);
    expect(packageScripts(null)).toEqual([]);
  });

  it("refuses metacharacters, flags, paths, and other tools", () => {
    for (const cmd of [
      "bun run build && curl example.com",
      "bun run build; rm -rf /",
      "bun run $(id)",
      "bun run --eval x",
      "bun run ./scripts/x.ts",
      "curl https://example.com",
      "npm publish",
      "bunx wrangler deploy",
    ]) {
      expect(commandAllowed(cmd, ["build", "lint"]), cmd).toBe(false);
    }
  });

  it("treats only build scripts as build commands", () => {
    expect(isBuildCommand("bun run build")).toBe(true);
    expect(isBuildCommand("bun run build:client")).toBe(true);
    expect(isBuildCommand("bun run test")).toBe(false);
    expect(isBuildCommand("bun test")).toBe(false);
  });
});

describe("runCommand in a Sandbox workspace", () => {
  const ws = {
    projectId: "proj_00000000-0000-0000-0000-000000000001",
    runId: "run_1",
    fork: "ws-1",
    dir: "/workspace/run_1",
    baseCommit: "a".repeat(40),
    openedAt: 0,
  };
  const env = { SANDBOX: {}, DB: {}, ARTIFACTS: {} } as never;

  beforeEach(() => {
    box.commands = [];
    box.files = new Map();
    // The agent already edited a client source before the build.
    box.status = " M src/client/app.tsx";
  });

  it("runs bun run build and discards only the files the build wrote", async () => {
    const out = await runCommand(env, ws, "bun run build");
    expect(box.commands).toContain("bun run build");
    expect(box.commands).toContain("git checkout -q HEAD -- public/app.js");
    expect(box.commands).toContain("rm -f public/app.css");
    expect(box.commands.some((c) => c.includes("src/client/app.tsx"))).toBe(false);
    expect(out).toContain("Build output not kept (public/app.js, public/app.css)");
  });

  it("reads package.json before it runs another script", async () => {
    expect(await runCommand(env, ws, "bun run lint")).toContain("Not allowed: bun run lint");
    expect(box.commands).not.toContain("bun run lint");
    box.files.set(`${ws.dir}/package.json`, JSON.stringify({ scripts: { lint: "biome check" } }));
    expect(await runCommand(env, ws, "bun run lint")).toContain("exit 0");
    expect(box.commands).toContain("bun run lint");
    // Not a build: nothing is discarded.
    expect(box.commands.some((c) => c.startsWith("git checkout -q HEAD --"))).toBe(false);
  });
});
