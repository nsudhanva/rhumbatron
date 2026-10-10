import { type WorkspaceManifest, workspaceManifestKey } from "@rhumbatron/protocol";
import { describe, expect, it, vi } from "vitest";

vi.mock("@clerk/backend", () => ({ verifyToken: async () => ({ sub: "member" }) }));
const { workspaceManifest } = await import("./workspace-manifest.ts");

const manifest: WorkspaceManifest = {
  manifestVersion: 1,
  projectId: "proj_1",
  changeId: "chg_1",
  taskId: "tsk_1",
  runId: "run_new",
  fork: "ws-new",
  remoteHost: "artifacts.example",
  baseCommit: "a".repeat(40),
  startCommit: "a".repeat(40),
  stackedOn: [],
  sandbox: {
    id: "proj-1",
    dir: "/workspace/run_new",
    openedAt: "2026-10-09T12:00:00.000Z",
    sleepAfter: 600,
  },
  toolsAllowed: ["read_file"],
  commandAllowlistVersion: 1,
  files: [],
  status: "open",
};

function setup(member = true) {
  const list = vi.fn(async () => ({
    objects: [
      {
        key: "workspace/proj_1/chg_1/tsk_1/run_old.json",
        uploaded: new Date("2026-10-09T13:00:00Z"),
        customMetadata: { openedAt: "2026-10-09T11:00:00.000Z" },
      },
      {
        key: workspaceManifestKey(manifest),
        uploaded: new Date("2026-10-09T12:00:00Z"),
        customMetadata: { openedAt: manifest.sandbox.openedAt },
      },
    ],
    truncated: false,
    cursor: "next",
  }));
  const get = vi.fn(async () => ({ size: 1000, json: async (): Promise<unknown> => manifest }));
  const statement = (sql: string) => ({
    bind: () => statement(sql),
    first: async () =>
      sql.startsWith("SELECT t.change_id")
        ? { project_id: "proj_1", change_id: "chg_1" }
        : member
          ? { member: 1 }
          : null,
  });
  const env = {
    DB: { prepare: statement, batch: async () => [] },
    EVIDENCE: { list, get },
    CLERK_SECRET_KEY: "test",
    CLERK_AUTHORIZED_PARTIES: "http://localhost:5173",
    CLERK_ALLOW_MISSING_AZP: "true",
  } as unknown as Env;
  const request = (auth = true) =>
    workspaceManifest.request(
      "/v1/tasks/tsk_1/workspace",
      { headers: auth ? { authorization: "Bearer session-token" } : {} },
      env,
    );
  return { request, list, get };
}

describe("Workspace manifest read boundary", () => {
  it("requires authentication and project membership before reading R2", async () => {
    const denied = setup(false);
    expect((await denied.request(false)).status).toBe(401);
    expect((await denied.request()).status).toBe(404);
    expect(denied.list).not.toHaveBeenCalled();
    expect(denied.get).not.toHaveBeenCalled();
  });

  it("uses a capped task prefix and selects by open time, not a delayed close upload", async () => {
    const { request, list, get } = setup();
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: manifest });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(list).toHaveBeenCalledWith({
      prefix: "workspace/proj_1/chg_1/tsk_1/",
      limit: 100,
      include: ["customMetadata"],
    });
    expect(get).toHaveBeenCalledWith(workspaceManifestKey(manifest));
  });

  it("never returns credentials or metadata from another Task", async () => {
    for (const stored of [
      { ...manifest, token: "private-token" },
      { ...manifest, taskId: "tsk_other" },
    ]) {
      const { request, get } = setup();
      get.mockResolvedValue({ size: 1000, json: async () => stored });
      const response = await request();
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private-token");
    }
  });

  it("fails a truncated scan at the page cap instead of claiming an older manifest is latest", async () => {
    const { request, list, get } = setup();
    list.mockResolvedValue({ objects: [], truncated: true, cursor: "next" });
    expect((await request()).status).toBe(503);
    expect(list).toHaveBeenCalledTimes(5);
    expect(get).not.toHaveBeenCalled();
  });

  it("bounds object reads and reports no manifest as absent", async () => {
    const { request, get } = setup();
    get.mockResolvedValue({
      size: 3_000_001,
      json: async () => {
        throw new Error("must not read");
      },
    });
    expect((await request()).status).toBe(503);
    const absent = setup();
    absent.list.mockResolvedValue({ objects: [], truncated: false, cursor: "" });
    expect((await absent.request()).status).toBe(404);
  });
});
