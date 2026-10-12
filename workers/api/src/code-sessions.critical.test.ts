// Code page edit sessions (ADR 0029) at the API boundary: only `code.edit` roles (owner, admin)
// open and use a session, a session belongs to the person who opened it, and the integration
// refusals keep their HTTP status (the Sandbox cap is 429).
import { describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ subject: "owner" }));
vi.mock("@clerk/backend", () => ({ verifyToken: async () => ({ sub: auth.subject }) }));
const { codeSessions } = await import("./code-sessions.ts");

const SESSION = `edit_${"ab".repeat(16)}`;
const NOW = new Date().toISOString();
const VIEW = {
  sessionId: SESSION,
  projectId: "proj_1",
  baseGeneration: 3,
  baseCommit: "c".repeat(40),
  baseTree: "a".repeat(40),
  createdAt: NOW,
  expiresAt: NOW,
  hardExpiresAt: NOW,
  idleTimeoutMs: 600_000,
  changedFiles: [],
};

/** D1 by SQL shape: `roles` maps a user ID to its role in proj_1; the session belongs to `usr_owner`. */
function setup(roles: Record<string, string>, rpcResult: unknown = { status: "ok", data: VIEW }) {
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => {
      // The access gate (access.ts): every caller is an approved user.
      if (sql.includes("access_status")) {
        return { status: "approved", last_seen_at: new Date().toISOString() };
      }
      if (sql.includes("FROM code_sessions")) return { project_id: "proj_1", user_id: "usr_owner" };
      if (sql.includes("member_role")) {
        const role = roles[String(args[1])];
        return { member_role: role ?? null, org_member: null };
      }
      return null;
    },
    run: async () => ({ meta: { changes: 0 } }),
  });
  const calls: string[] = [];
  const method = (name: string) =>
    vi.fn(async () => {
      calls.push(name);
      return rpcResult;
    });
  const env = {
    DB: { prepare: (sql: string) => statement(sql), batch: async () => [] },
    PROJECT_VIEW: { idFromName: () => "id", get: () => ({ applyDelta: async () => undefined }) },
    INTEGRATION: {
      openCodeSession: method("open"),
      getCodeSession: method("get"),
      execCodeSessionCommand: method("exec"),
      writeCodeSessionFile: method("write"),
      closeCodeSession: method("close"),
    },
    CLERK_SECRET_KEY: "test",
    CLERK_AUTHORIZED_PARTIES: "http://localhost:5173",
    CLERK_ALLOW_MISSING_AZP: "true",
  } as unknown as Env;
  const call = (subject: string, method: string, path: string, body?: unknown) => {
    auth.subject = subject;
    return codeSessions.request(
      path,
      {
        method,
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
  };
  return { call, calls };
}

describe("code session authorization", () => {
  it("lets the owner and an admin open a session, and refuses a member and a viewer", async () => {
    const { call, calls } = setup({
      usr_owner: "owner",
      usr_admin: "admin",
      usr_member: "member",
      usr_viewer: "viewer",
    });
    expect((await call("owner", "POST", "/v1/projects/proj_1/code/sessions")).status).toBe(201);
    expect((await call("admin", "POST", "/v1/projects/proj_1/code/sessions")).status).toBe(201);
    const member = await call("member", "POST", "/v1/projects/proj_1/code/sessions");
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({
      error: { message: "Only the project owner or an admin can edit code directly." },
    });
    expect((await call("viewer", "POST", "/v1/projects/proj_1/code/sessions")).status).toBe(403);
    expect((await call("stranger", "POST", "/v1/projects/proj_1/code/sessions")).status).toBe(404);
    expect(calls).toEqual(["open", "open"]);
  });

  it("hides the session of another person, even from an admin", async () => {
    const { call, calls } = setup({ usr_owner: "owner", usr_admin: "admin" });
    const response = await call("admin", "POST", `/v1/code/sessions/${SESSION}/exec`, {
      command: "ls",
    });
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("closes the terminal to an owner who lost the code.edit permission", async () => {
    const { call, calls } = setup({ usr_owner: "member" });
    const response = await call("owner", "POST", `/v1/code/sessions/${SESSION}/exec`, {
      command: "ls",
    });
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("refuses an over-long command before the integration Worker", async () => {
    const { call, calls } = setup({ usr_owner: "owner" });
    const response = await call("owner", "POST", `/v1/code/sessions/${SESSION}/exec`, {
      command: "x".repeat(2001),
    });
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("returns 429 with reason sandbox_cap when the monthly Sandbox time is used up", async () => {
    const { call } = setup(
      { usr_owner: "owner" },
      { status: "refused", reason: "sandbox_cap", detail: "The monthly Sandbox time is used up." },
    );
    const response = await call("owner", "POST", `/v1/code/sessions/${SESSION}/exec`, {
      command: "bun test",
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error: { code: "rate_limited", details: { reason: "sandbox_cap" } },
    });
  });

  it("returns 410 for an expired session", async () => {
    const { call } = setup(
      { usr_owner: "owner" },
      { status: "refused", reason: "expired", detail: "The session expired." },
    );
    expect((await call("owner", "GET", `/v1/code/sessions/${SESSION}`)).status).toBe(410);
  });
});
