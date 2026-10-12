import { changeSetPatchKey, codeBlobKey, codeManifestKey } from "@rhumbatron/protocol";
import { describe, expect, it, vi } from "vitest";

vi.mock("@clerk/backend", () => ({ verifyToken: async () => ({ sub: "member" }) }));
const { code } = await import("./code.ts");

const TREE = "a".repeat(40);
const COMMIT = "c".repeat(40);
const BLOB = "b".repeat(40);

function setup(options: { member?: boolean; manifest?: boolean; patchRef?: boolean } = {}) {
  const { member = true, manifest = true, patchRef = true } = options;
  const objects = new Map<string, { body: string; customMetadata?: Record<string, string> }>();
  if (manifest) {
    objects.set(codeManifestKey("proj_1", TREE), {
      body: JSON.stringify({
        commit: COMMIT,
        treeSha: TREE,
        complete: true,
        entries: [{ path: "src/cart.ts", blob: BLOB, size: 12, stored: true }],
      }),
    });
  }
  objects.set(codeBlobKey("proj_1", BLOB), { body: "export {};\n" });
  objects.set(changeSetPatchKey("proj_1", "cs_1"), {
    body: "diff --git a/src/cart.ts b/src/cart.ts\n--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -1 +1 @@\n-a\n+b\n",
    customMetadata: { base: TREE, head: COMMIT, bytes: "60", truncated: "false" },
  });
  const object = (value: { body: string; customMetadata?: Record<string, string> }) => ({
    size: value.body.length,
    customMetadata: value.customMetadata ?? {},
    text: async () => value.body,
    json: async () => JSON.parse(value.body),
    arrayBuffer: async () => new TextEncoder().encode(value.body).buffer,
  });
  const get = vi.fn(async (key: string) => {
    const value = objects.get(key);
    return value ? object(value) : null;
  });
  const head = vi.fn(async (key: string) => (objects.has(key) ? { size: 1 } : null));
  const getCanonical = vi.fn(async () => ({
    generation: 2,
    artifactRef: "artifacts://proj_1@main",
    treeSha: TREE,
  }));
  const backfillTreeCode = vi.fn(async () => ({ status: "complete", written: 0 }));
  const statement = (sql: string) => ({
    bind: () => statement(sql),
    first: async () => {
      // The access gate (access.ts): the caller is an approved user.
      if (sql.includes("access_status")) {
        return { status: "approved", last_seen_at: new Date().toISOString() };
      }
      if (sql.includes("JOIN memberships")) return member ? { member: 1, org_member: 1 } : null;
      if (sql.includes("FROM changesets cs JOIN changes")) return { project_id: "proj_1" };
      return null;
    },
    all: async () => ({
      results: sql.includes("FROM changesets cs")
        ? [
            {
              id: "cs_1",
              change_id: "chg_1",
              agent_id: "agt_1",
              intent_json: JSON.stringify({
                summary: "Cart total",
                changeSet: {
                  fork: "ws-1",
                  commit: COMMIT,
                  baseCommit: TREE,
                  diffStat: "",
                  files: ["src/cart.ts"],
                  ...(patchRef ? { patchRef: changeSetPatchKey("proj_1", "cs_1") } : {}),
                },
              }),
              status: "proposed",
              created_at: "2026-10-09T00:00:00.000Z",
              agent_role: "implementer",
              task_id: "tsk_1",
              task_key: "T1",
              task_title: "Cart",
            },
          ]
        : [],
    }),
  });
  const env = {
    DB: { prepare: statement, batch: async () => [] },
    EVIDENCE: { get, head },
    PROJECT_ROOT: { idFromName: () => "id", get: () => ({ getCanonical }) },
    INTEGRATION: { backfillTreeCode },
    CLERK_SECRET_KEY: "test",
    CLERK_AUTHORIZED_PARTIES: "http://localhost:5173",
    CLERK_ALLOW_MISSING_AZP: "true",
  } as unknown as Env;
  const request = (path: string, auth = true) =>
    code.request(path, { headers: auth ? { authorization: "Bearer session-token" } : {} }, env);
  return { request, get, head, getCanonical, backfillTreeCode };
}

describe("Code read boundary", () => {
  it("requires authentication and membership before any R2, Durable Object, or RPC read", async () => {
    const denied = setup({ member: false });
    expect((await denied.request("/v1/projects/proj_1/code", false)).status).toBe(401);
    for (const path of [
      "/v1/projects/proj_1/code?path=src/cart.ts",
      "/v1/projects/proj_1/versions",
      "/v1/changesets/cs_1/diff",
    ]) {
      expect((await denied.request(path)).status).toBe(404);
    }
    expect(denied.get).not.toHaveBeenCalled();
    expect(denied.head).not.toHaveBeenCalled();
    expect(denied.getCanonical).not.toHaveBeenCalled();
    expect(denied.backfillTreeCode).not.toHaveBeenCalled();
  });

  it("serves only paths listed in the tree manifest, from the Project's own blob prefix", async () => {
    const { request, get } = setup();
    const response = await request("/v1/projects/proj_1/code?path=src/cart.ts");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { kind: "file", path: "src/cart.ts", content: "export {};\n", live: true },
    });
    expect(get).toHaveBeenCalledWith(codeBlobKey("proj_1", BLOB));

    get.mockClear();
    for (const path of ["../proj_2/blobs/x", "src/missing.ts"]) {
      const missing = await request(`/v1/projects/proj_1/code?path=${encodeURIComponent(path)}`);
      expect(missing.status).toBe(404);
    }
    expect(get.mock.calls.map(([key]) => key)).toEqual([
      codeManifestKey("proj_1", TREE),
      codeManifestKey("proj_1", TREE),
    ]);
  });

  it("rejects a tree that is not a full commit-style hash", async () => {
    const { request, get } = setup();
    expect((await request("/v1/projects/proj_1/code?tree=../../x")).status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it("backfills the live tree through the integration Worker when its manifest is missing", async () => {
    const { request, backfillTreeCode } = setup({ manifest: false });
    await request("/v1/projects/proj_1/code");
    expect(backfillTreeCode).toHaveBeenCalledWith({ projectId: "proj_1", treeSha: TREE });
  });

  it("reports an older ChangeSet without a stored patch as not recorded, without reading R2", async () => {
    const { request, get } = setup({ patchRef: false });
    const response = await request("/v1/changesets/cs_1/diff");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { changeSet: { id: "cs_1", patchRecorded: false }, diff: { recorded: false } },
    });
    expect(get).not.toHaveBeenCalled();

    const recorded = await setup().request("/v1/changesets/cs_1/diff");
    expect(await recorded.json()).toMatchObject({
      data: {
        diff: {
          recorded: true,
          files: [{ path: "src/cart.ts", additions: 1, deletions: 1, changeSetIds: ["cs_1"] }],
        },
      },
    });
  });
});
