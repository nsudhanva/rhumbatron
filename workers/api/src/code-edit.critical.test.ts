import { MAX_EDIT_BYTES } from "@rhumbatron/protocol";
import { describe, expect, it, vi } from "vitest";

vi.mock("@clerk/backend", () => ({ verifyToken: async () => ({ sub: "member" }) }));
const { codeEdit } = await import("./code-edit.ts");

const TREE = "a".repeat(40);
const OLD_TREE = "b".repeat(40);

function setup(options: { member?: boolean } = {}) {
  const { member = true } = options;
  const statement = (sql: string) => ({
    bind: () => statement(sql),
    first: async () =>
      // The access gate (access.ts): the caller is an approved user.
      sql.includes("access_status")
        ? { status: "approved", last_seen_at: new Date().toISOString() }
        : sql.includes("JOIN memberships") && member
          ? { member: 1, org_member: 1 }
          : null,
    run: async () => ({ meta: { changes: 0 } }),
  });
  const getCanonical = vi.fn(async () => ({
    generation: 4,
    artifactRef: "artifacts://proj_1@main",
    treeSha: TREE,
  }));
  const submitHumanEdit = vi.fn(async () => ({
    status: "created",
    changeId: "chg_1",
    changeSetId: "cs_1",
    candidateIds: ["cand_1"],
  }));
  const applyDelta = vi.fn(async () => undefined);
  const env = {
    DB: { prepare: statement, batch: async () => [] },
    PROJECT_ROOT: { idFromName: () => "id", get: () => ({ getCanonical }) },
    PROJECT_VIEW: { idFromName: () => "id", get: () => ({ applyDelta }) },
    INTEGRATION: { submitHumanEdit },
    CLERK_SECRET_KEY: "test",
    CLERK_AUTHORIZED_PARTIES: "http://localhost:5173",
    CLERK_ALLOW_MISSING_AZP: "true",
  } as unknown as Env;
  const save = (body: Record<string, unknown>) =>
    codeEdit.request(
      "/v1/projects/proj_1/code/edits",
      {
        method: "POST",
        headers: { authorization: "Bearer session-token", "content-type": "application/json" },
        body: JSON.stringify({
          path: "src/catalog.ts",
          content: "export const title = 'Acme';\n",
          baseTree: TREE,
          message: "Rename the shop",
          ...body,
        }),
      },
      env,
    );
  return { save, getCanonical, submitHumanEdit };
}

describe("Code edit boundary", () => {
  it("creates a human ChangeSet through the integration Worker as the signed-in member", async () => {
    const { save, submitHumanEdit } = setup();
    const response = await save({ authorName: "Sudhanva" });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ data: { changeId: "chg_1" } });
    expect(submitHumanEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_1",
        userId: "usr_member",
        authorName: "Sudhanva",
        path: "src/catalog.ts",
        baseTree: TREE,
      }),
    );
  });

  it("returns 409 'the file changed; reload' when canonical moved after the file was opened", async () => {
    const { save, submitHumanEdit } = setup();
    const response = await save({ baseTree: OLD_TREE });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "conflict",
        message: "The file changed; reload.",
        details: { reason: "stale_base" },
      },
    });
    expect(submitHumanEdit).not.toHaveBeenCalled();
  });

  it("refuses files over 256 KB and binary content before any Artifacts work", async () => {
    const { save, submitHumanEdit } = setup();
    const large = await save({ content: "a".repeat(MAX_EDIT_BYTES + 1) });
    expect(large.status).toBe(413);
    const binary = await save({ content: "PNG\u0000data" });
    expect(binary.status).toBe(400);
    expect(await binary.json()).toMatchObject({ error: { details: { reason: "binary" } } });
    expect(submitHumanEdit).not.toHaveBeenCalled();
  });

  it("refuses non-members and paths outside the repository", async () => {
    const outsider = setup({ member: false });
    expect((await outsider.save({})).status).toBe(404);
    expect(outsider.getCanonical).not.toHaveBeenCalled();

    const { save, submitHumanEdit } = setup();
    expect((await save({ path: "../proj_2/src/app.ts" })).status).toBe(400);
    expect(submitHumanEdit).not.toHaveBeenCalled();
  });
});
