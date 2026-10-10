import { describe, expect, it } from "vitest";
import { WorkspaceManifest, workspaceManifestKey } from "./workspace.ts";

const manifest: WorkspaceManifest = {
  manifestVersion: 1,
  projectId: "proj_1",
  changeId: "chg_1",
  taskId: "tsk_1",
  runId: "run_1",
  fork: "ws-1",
  remoteHost: "artifacts.example",
  baseCommit: "a".repeat(40),
  startCommit: "b".repeat(40),
  stackedOn: ["cs_1"],
  sandbox: {
    id: "proj-1",
    dir: "/workspace/run_1",
    openedAt: "2026-10-09T12:00:00.000Z",
    sleepAfter: 120,
  },
  toolsAllowed: ["read_file", "write_file"],
  commandAllowlistVersion: 1,
  files: ["src/a.ts"],
  status: "published",
};

describe("Workspace manifest contract", () => {
  it("round-trips source and execution metadata with a stable run key", () => {
    expect(WorkspaceManifest.parse(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
    expect(workspaceManifestKey(manifest)).toBe("workspace/proj_1/chg_1/tsk_1/run_1.json");
  });

  it("rejects credential fields, URLs and header values instead of making them public", () => {
    for (const extra of [
      { token: "private-token" },
      { header: "Authorization: Bearer private-token" },
      { remote: "https://private-token@artifacts.example" },
    ]) {
      expect(WorkspaceManifest.safeParse({ ...manifest, ...extra }).success).toBe(false);
    }
    expect(
      WorkspaceManifest.safeParse({
        ...manifest,
        sandbox: { ...manifest.sandbox, env: { GIT_AUTH: "private-token" } },
      }).success,
    ).toBe(false);
    for (const remoteHost of [
      "https://user:private-token@artifacts.example/repo",
      "artifacts.example?token=private-token",
      "Authorization: Bearer private-token",
    ]) {
      expect(WorkspaceManifest.safeParse({ ...manifest, remoteHost }).success).toBe(false);
    }
  });

  it("requires closedAt exactly when closed and rejects unsafe identities", () => {
    expect(WorkspaceManifest.safeParse({ ...manifest, status: "closed" }).success).toBe(false);
    expect(WorkspaceManifest.safeParse({ ...manifest, taskId: "../another-task" }).success).toBe(
      false,
    );
    const closed = {
      ...manifest,
      status: "closed",
      sandbox: { ...manifest.sandbox, closedAt: "2026-10-09T12:01:00.000Z" },
    };
    expect(WorkspaceManifest.parse(closed)).toEqual(closed);
  });
});
