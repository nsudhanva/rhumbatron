// Shared Project access (docs/architecture/shared-projects.md).
// A collaborator opens only the Project shared with them, never the owner's other Projects, and
// is never an owner. A stranger opens nothing. Runs the real migrations and SQL against SQLite.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { canAccessProject, PROJECT_VISIBLE_SQL, projectRole } from "./identity.ts";
import { requestFields } from "./members.ts";

const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");
const T = "2026-10-10T12:00:00.000Z";

function setup() {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
  });
  const d1 = { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
  // Alice owns two Projects in her personal org; she shares only p_shared with Bob.
  db.exec(`
    INSERT INTO users (id, auth_subject, created_at, updated_at) VALUES
      ('usr_alice', 'alice', '${T}', '${T}'), ('usr_bob', 'bob', '${T}', '${T}'),
      ('usr_eve', 'eve', '${T}', '${T}');
    INSERT INTO organizations (id, name, created_at, updated_at) VALUES
      ('org_alice', 'Personal', '${T}', '${T}'), ('org_bob', 'Personal', '${T}', '${T}');
    INSERT INTO memberships (org_id, user_id, role, created_at) VALUES
      ('org_alice', 'usr_alice', 'owner', '${T}'), ('org_bob', 'usr_bob', 'owner', '${T}');
    INSERT INTO projects (id, org_id, name, slug, status, canonical_generation, created_at, updated_at) VALUES
      ('p_shared', 'org_alice', 'Shared', 'shared', 'active', 0, '${T}', '${T}'),
      ('p_private', 'org_alice', 'Private', 'private', 'active', 0, '${T}', '${T}');
    INSERT INTO project_members (project_id, user_id, role, rank, added_by, created_at) VALUES
      ('p_shared', 'usr_alice', 'owner', 0, 'usr_alice', '${T}'),
      ('p_shared', 'usr_bob', 'collaborator', 10, 'usr_alice', '${T}');
  `);
  const visible = (userId: string) =>
    (
      db
        .prepare(`SELECT p.id FROM projects p WHERE ${PROJECT_VISIBLE_SQL} ORDER BY p.id`)
        .all(userId, userId) as { id: string }[]
    ).map((r) => r.id);
  return { db, d1, visible };
}

describe("shared Project access", () => {
  it("gives the owner owner, the collaborator collaborator, and a stranger nothing", async () => {
    const { d1 } = setup();
    expect(await projectRole(d1, "usr_alice", "p_shared")).toBe("owner");
    expect(await projectRole(d1, "usr_bob", "p_shared")).toBe("collaborator");
    expect(await projectRole(d1, "usr_eve", "p_shared")).toBeNull();
    expect(await canAccessProject(d1, "usr_eve", "p_shared")).toBe(false);
  });

  it("never lets a collaborator open the owner's other Projects", async () => {
    const { d1, visible } = setup();
    expect(await projectRole(d1, "usr_bob", "p_private")).toBeNull();
    expect(visible("usr_bob")).toEqual(["p_shared"]);
    expect(visible("usr_alice")).toEqual(["p_private", "p_shared"]);
    expect(visible("usr_eve")).toEqual([]);
  });

  it("removes access when the collaborator row goes", async () => {
    const { db, d1 } = setup();
    db.exec("DELETE FROM project_members WHERE user_id = 'usr_bob'");
    expect(await projectRole(d1, "usr_bob", "p_shared")).toBeNull();
  });

  it("allows one owner row per Project", () => {
    const { db } = setup();
    expect(() =>
      db.exec(`INSERT INTO project_members (project_id, user_id, role, rank, added_by, created_at)
               VALUES ('p_shared', 'usr_eve', 'owner', 0, 'x', '${T}')`),
    ).toThrow();
  });

  it("reports an unknown outcome as none, and marks the viewer's own request", () => {
    const row = {
      created_by: "usr_bob",
      requester_rank: 10,
      outcome: "something_else",
      outcome_reason: null,
      outcome_winner_change_id: null,
      outcome_decided_by: null,
      supersedes_change_id: null,
      display_name: null,
      email: "bob@example.org",
    };
    expect(requestFields(row, "usr_bob")).toMatchObject({
      requester: { userId: "usr_bob", name: "bob", rank: 10, isYou: true },
      outcome: null,
    });
    expect(requestFields({ ...row, outcome: "not_selected" }, "usr_alice").outcome?.kind).toBe(
      "not_selected",
    );
  });
});
