import { WorkspaceManifest, workspaceManifestKey } from "@rhumbatron/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

const box = vi.hoisted(() => ({ head: "a".repeat(40), dirty: false, cleanupFails: false }));
vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: () => ({
    async exec(command: string) {
      if (command.startsWith("rm -rf") && box.cleanupFails) throw new Error("Sandbox lost");
      if (command.startsWith("git merge ")) box.head = "b".repeat(40);
      if (command.startsWith("git commit ")) box.head = "c".repeat(40);
      const stdout =
        command === "git rev-parse HEAD"
          ? box.head
          : command === "git status --porcelain"
            ? box.dirty
              ? " M src/a.ts"
              : ""
            : command.startsWith("git diff --name-only ")
              ? "src/a.ts\n"
              : "";
      return { exitCode: 0, stdout, stderr: "" };
    },
  }),
}));
const { openWorkspace, publishWorkspace, closeWorkspace, safePath } = await import(
  "./workspace.ts"
);

function setup() {
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
    fork: async () => ({}),
    info: async () => ({
      remote: "https://user:private-token@artifacts.example/repo?token=private-token",
    }),
    createToken: async () => ({ id: "tok_1", plaintext: "private-token?expires=1" }),
    revokeToken: async () => true,
    [Symbol.dispose]() {},
  };
  const env = {
    SANDBOX: {},
    DB: { prepare: () => statement },
    ARTIFACTS: { get: async () => repo },
    EVIDENCE: {
      put,
      get: async (key: string) =>
        objects.has(key) ? { json: async () => JSON.parse(objects.get(key) as string) } : null,
    },
  } as unknown as Parameters<typeof openWorkspace>[0];
  const open = async () => {
    const ws = await openWorkspace(env, {
      projectId: "proj_1",
      change: { changeId: "chg_1", taskId: "tsk_1" },
      runId: "run_1",
      baseCommit: "a".repeat(40),
      stack: [
        {
          changeSetId: "cs_dependency",
          taskId: "tsk_dependency",
          fork: "ws-dependency",
          commit: "d".repeat(40),
          files: ["src/dependency.ts"],
        },
      ],
    });
    if ("refused" in ws) throw new Error(ws.message);
    return ws;
  };
  const stored = () => WorkspaceManifest.parse(JSON.parse([...objects.values()][0] as string));
  return { env, put, objects, open, stored };
}

beforeEach(() => {
  box.head = "a".repeat(40);
  box.dirty = false;
  box.cleanupFails = false;
});

describe("Workspace manifest lifecycle", () => {
  it("stores a credential-free stacked start, publishes paths, and closes even after Sandbox loss", async () => {
    const { env, open, stored, objects } = setup();
    const ws = await open();
    const originalRef = JSON.parse(JSON.stringify(ws)); // AgentDO checkpoint before publish.
    expect(stored()).toMatchObject({
      status: "open",
      remoteHost: "artifacts.example",
      baseCommit: "a".repeat(40),
      startCommit: "b".repeat(40),
      stackedOn: ["cs_dependency"],
      files: [],
    });
    expect([...objects.keys()]).toEqual([workspaceManifestKey(stored())]);
    box.dirty = true;
    await publishWorkspace(env, ws, "Task result");
    expect(stored()).toMatchObject({ status: "published", files: ["src/a.ts"] });
    box.cleanupFails = true;
    await closeWorkspace(env, originalRef);
    expect(stored()).toMatchObject({ status: "closed", files: ["src/a.ts"] });
    expect(stored().sandbox.closedAt).toBeDefined();
    const json = [...objects.values()].join("");
    for (const secret of [
      "private-token",
      "Authorization",
      "Bearer",
      "GIT_AUTH",
      "?token=",
      "https://",
    ])
      expect(json).not.toContain(secret);
  });

  it("keeps a failed publish write's paths when closing, and never fails on R2 write errors", async () => {
    const { env, open, stored, put } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await open();
      put.mockRejectedValueOnce(new Error("Authorization: Bearer private-token"));
      box.dirty = true;
      await expect(publishWorkspace(env, ws, "Task result")).resolves.toMatchObject({
        files: ["src/a.ts"],
      });
      await closeWorkspace(env, ws);
      expect(stored()).toMatchObject({ status: "closed", files: ["src/a.ts"] });
      put.mockRejectedValue(new Error("Authorization: Bearer private-token"));
      const another = await open();
      await expect(closeWorkspace(env, another)).resolves.toBeUndefined();
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private-token");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
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
