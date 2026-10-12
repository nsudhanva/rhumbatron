// Clarify boundary (ADR 0025): only the requester or the Project owner answers a needs_input
// Change. Real migrations and identity SQL on SQLite; the integration Worker is a stub.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

vi.mock("@clerk/backend", () => ({ verifyToken: async (token: string) => ({ sub: token }) }));
const { clarify, mayActOnRequest } = await import("./clarify.ts");

const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");
const T = "2026-10-10T12:00:00.000Z";

function setup() {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  const run = (sql: string, params: unknown[]) => db.prepare(sql).run(...(params as never[]));
  const statement = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
    run: async () => ({ meta: { changes: Number(run(sql, params).changes) } }),
  });
  const DB = {
    prepare: (sql: string) => statement(sql),
    batch: async (list: { sql: string; params: unknown[] }[]) =>
      list.map(({ sql, params }) => ({ meta: { changes: Number(run(sql, params).changes) } })),
  };
  // Alice owns the Project; Bob and Carol collaborate. Bob made the request.
  db.exec(`
    INSERT INTO users (id, auth_subject, created_at, updated_at) VALUES
      ('usr_alice', 'alice', '${T}', '${T}'), ('usr_bob', 'bob', '${T}', '${T}'),
      ('usr_carol', 'carol', '${T}', '${T}'), ('usr_eve', 'eve', '${T}', '${T}');
    INSERT INTO organizations (id, name, created_at, updated_at) VALUES
      ('org_alice', 'Personal', '${T}', '${T}');
    INSERT INTO memberships (org_id, user_id, role, created_at) VALUES
      ('org_alice', 'usr_alice', 'owner', '${T}');
    INSERT INTO projects (id, org_id, name, slug, status, canonical_generation, created_at, updated_at) VALUES
      ('proj_p', 'org_alice', 'P', 'p', 'active', 0, '${T}', '${T}');
    INSERT INTO project_members (project_id, user_id, role, rank, added_by, created_at) VALUES
      ('proj_p', 'usr_alice', 'owner', 0, 'usr_alice', '${T}'),
      ('proj_p', 'usr_bob', 'member', 10, 'usr_alice', '${T}'),
      ('proj_p', 'usr_carol', 'member', 10, 'usr_alice', '${T}');
    INSERT INTO changes (id, project_id, goal, status, base_generation, budget_usd, created_by, created_at, updated_at)
      VALUES ('chg_b', 'proj_p', 'Add kanban feature', 'needs_input', 0, 1, 'usr_bob', '${T}', '${T}');
  `);
  const clarifyChange = vi.fn(async (input: { changeId: string; actorUserId: string }) => ({
    status: "recorded",
    changeId: input.changeId,
    changeStatus: "compiling",
    action: "answers",
    round: 1,
    repeated: false,
  }));
  const env = {
    DB,
    INTEGRATION: { clarifyChange },
    CLERK_SECRET_KEY: "test",
    CLERK_AUTHORIZED_PARTIES: "http://localhost:5173",
    CLERK_ALLOW_MISSING_AZP: "true",
  } as unknown as Env;
  const send = (subject: string, body: unknown, changeId = "chg_b") =>
    clarify.request(
      `/v1/changes/${changeId}/clarify`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${subject}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
  return { send, clarifyChange };
}

const answer = { answers: [{ questionId: "q1", text: "One board per mission day" }] };

describe("clarify authorization", () => {
  it("lets the requester and the owner answer, and nobody else", async () => {
    const { send, clarifyChange } = setup();
    expect((await send("bob", answer)).status).toBe(200);
    expect((await send("alice", { action: "proceed_anyway" })).status).toBe(200);
    const other = await send("carol", { action: "withdraw" });
    expect(other.status).toBe(403);
    expect((await send("eve", answer)).status).toBe(404);
    expect(clarifyChange).toHaveBeenCalledTimes(2);
    expect(clarifyChange.mock.calls.map((call) => call[0].actorUserId)).toEqual([
      "usr_bob",
      "usr_alice",
    ]);
  });

  it("rejects a malformed body before any command runs", async () => {
    const { send, clarifyChange } = setup();
    for (const body of [
      {},
      { answers: [] },
      { action: "approve" },
      { answers: [{ questionId: "q1", text: " " }] },
      { ...answer, action: "withdraw" },
    ])
      expect((await send("bob", body)).status).toBe(400);
    expect(clarifyChange).not.toHaveBeenCalled();
  });

  it("decides membership from roles, not from the request", () => {
    expect(mayActOnRequest("owner", "usr_bob", "usr_alice")).toBe(true);
    expect(mayActOnRequest("admin", "usr_bob", "usr_alice")).toBe(true);
    expect(mayActOnRequest("member", "usr_bob", "usr_bob")).toBe(true);
    expect(mayActOnRequest("member", "usr_bob", "usr_carol")).toBe(false);
    expect(mayActOnRequest("viewer", "usr_bob", "usr_bob")).toBe(false);
    expect(mayActOnRequest(null, "usr_bob", "usr_bob")).toBe(false);
  });
});
