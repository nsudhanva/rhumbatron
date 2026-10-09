// Inbox derivation (AGENTS.md sections 36, 40.1, 59). An action item must exist exactly while its
// condition holds: `approval_required` disappears once an approval is recorded; `promotion_ready`
// appears only when approved or when no approval is required. A read mark must never hide an
// action item. A user must never see, count, or mark another tenant's items. Runs the real
// migrations and SQL against SQLite (node:sqlite).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { countNotifications, deriveNotifications, markNotificationsRead } from "./notifications.ts";

const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");
const NOW = new Date("2026-10-09T12:00:00.000Z");
const T = "2026-10-09T11:00:00.000Z";
const OLD = "2026-09-30T11:00:00.000Z"; // outside the 7-day window

function setup() {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  const exec = (sql: string, params: unknown[]) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql)) {
      return { results: statement.all(...(params as never[])), meta: { changes: 0 } };
    }
    return {
      results: [],
      meta: { changes: Number(statement.run(...(params as never[])).changes) },
    };
  };
  const statement = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => exec(sql, params),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    all: async () => exec(sql, params),
  });
  const d1 = {
    prepare: (sql: string) => statement(sql),
    batch: async (list: { sql: string; params: unknown[] }[]) =>
      list.map((s) => exec(s.sql.trim(), s.params)),
  } as unknown as D1Database;

  // Two tenants, one Project each.
  db.exec(`
    INSERT INTO users (id, auth_subject, created_at, updated_at) VALUES
      ('usr_a', 'a', '${T}', '${T}'), ('usr_b', 'b', '${T}', '${T}');
    INSERT INTO organizations (id, name, created_at, updated_at) VALUES
      ('org_a', 'A', '${T}', '${T}'), ('org_b', 'B', '${T}', '${T}');
    INSERT INTO memberships (org_id, user_id, role, created_at) VALUES
      ('org_a', 'usr_a', 'owner', '${T}'), ('org_b', 'usr_b', 'owner', '${T}');
    INSERT INTO projects (id, org_id, name, slug, status, canonical_generation, created_at, updated_at) VALUES
      ('proj_a', 'org_a', 'Acme Shop', 'acme', 'active', 0, '${T}', '${T}'),
      ('proj_b', 'org_b', 'Other', 'other', 'active', 0, '${T}', '${T}');
  `);

  const change = (id: string, projectId: string, status = "awaiting_approval", updatedAt = T) =>
    db
      .prepare(
        `INSERT INTO changes (id, project_id, goal, status, base_generation, risk_tier, budget_usd,
           created_by, created_at, updated_at)
         VALUES (?, ?, 'Add shared wishlists', ?, 1841, 'high', 3, 'usr', ?, ?)`,
      )
      .run(id, projectId, status, T, updatedAt);
  const candidate = (
    id: string,
    changeId: string,
    opts: {
      status?: string;
      gated?: boolean;
      promotable?: boolean;
      promotedGeneration?: number;
    } = {},
  ) =>
    db
      .prepare(
        `INSERT INTO candidates (id, change_id, base_generation, status, plan_json, score_json,
           promoted_generation, created_at, updated_at)
         VALUES (?, ?, 1841, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        changeId,
        opts.status ?? "verified",
        JSON.stringify({ candidateId: id, checks: [], humanApprovalRequired: opts.gated ?? false }),
        JSON.stringify({ promotable: opts.promotable ?? true, gaps: [] }),
        opts.promotedGeneration ?? null,
        T,
        T,
      );
  const approve = (candidateId: string, changeId: string, decision: "granted" | "rejected") =>
    db
      .prepare(
        `INSERT INTO approvals (id, candidate_id, change_id, project_id, decision, approver_user_id,
           candidate_tree, policy_version, created_at)
         VALUES (?, ?, ?, 'proj_a', ?, 'usr_a', 'tree', 'policy-1', ?)`,
      )
      .run(`apr_${candidateId}`, candidateId, changeId, decision, NOW.toISOString());

  const list = (userId: string) => deriveNotifications(d1, userId, NOW);
  const kinds = async (userId: string) => (await list(userId)).map((i) => i.id);
  return { db, d1, change, candidate, approve, list, kinds };
}

describe("notification derivation", () => {
  it("approval_required disappears once an approval is granted, and promotion_ready appears", async () => {
    const { change, candidate, approve, kinds } = setup();
    change("chg_1", "proj_a");
    candidate("cand_1", "chg_1", { gated: true });

    expect(await kinds("usr_a")).toEqual(["approval_required:cand_1"]);
    approve("cand_1", "chg_1", "granted");
    expect(await kinds("usr_a")).toEqual(["promotion_ready:cand_1"]);
  });

  it("a rejected approval yields neither action item", async () => {
    const { change, candidate, approve, kinds } = setup();
    change("chg_1", "proj_a");
    candidate("cand_1", "chg_1", { gated: true });
    approve("cand_1", "chg_1", "rejected");
    expect(await kinds("usr_a")).toEqual([]);
  });

  it("promotion_ready only when approved or not required, promotable, and not stale", async () => {
    const { change, candidate, kinds } = setup();
    change("chg_1", "proj_a");
    candidate("cand_open", "chg_1"); // no human gate
    candidate("cand_gated", "chg_1", { gated: true }); // gate, no decision yet
    candidate("cand_gap", "chg_1", { promotable: false });
    expect((await kinds("usr_a")).sort()).toEqual([
      "approval_required:cand_gated",
      "promotion_ready:cand_open",
    ]);

    // Another Change of the Project promoted past their base: both become stale-to-be.
    change("chg_2", "proj_a", "completed");
    candidate("cand_won", "chg_2", { status: "promoted", promotedGeneration: 1842 });
    expect(await kinds("usr_a")).toEqual(["promoted:cand_won", "change_completed:chg_2"]);
  });

  it("a closed Change has no action items", async () => {
    const { change, candidate, kinds } = setup();
    change("chg_1", "proj_a", "cancelled");
    candidate("cand_1", "chg_1", { gated: true });
    expect(await kinds("usr_a")).toEqual([]);
  });

  it("finished work leaves the inbox after the 7-day window", async () => {
    const { change, kinds } = setup();
    change("chg_new", "proj_a", "completed", T);
    change("chg_old", "proj_a", "completed", OLD);
    expect(await kinds("usr_a")).toEqual(["change_completed:chg_new"]);
  });

  it("finished releases: failed is attention, deployed is info, superseded and old are silent", async () => {
    const { db, list } = setup();
    const release = (id: string, generation: number, status: string, finishedAt = T) =>
      db
        .prepare(
          `INSERT INTO releases (id, project_id, change_id, candidate_id, generation, commit_sha,
             status, started_at, finished_at, failure_reason)
           VALUES (?, 'proj_a', 'chg_1', 'cand_1', ?, 'abc1234', ?, ?, ?, ?)`,
        )
        .run(id, generation, status, T, finishedAt, status === "deployed" ? null : "404");
    release("rel_1", 1, "deployed");
    release("rel_2", 2, "smoke_failed");
    release("rel_3", 3, "superseded");
    release("rel_0", 0, "failed", OLD);
    release("rel_4", 4, "building");
    const items = await list("usr_a");
    expect(items.map((i) => [i.id, i.severity])).toEqual([
      ["release_failed:rel_2", "attention"],
      ["release_deployed:rel_1", "info"],
    ]);
    expect(await list("usr_b")).toEqual([]);
  });
});

describe("notification read state", () => {
  it("a read mark clears unread but never hides an action item", async () => {
    const { d1, change, candidate, list } = setup();
    change("chg_1", "proj_a");
    candidate("cand_1", "chg_1", { gated: true });
    change("chg_done", "proj_a", "completed");

    expect(countNotifications(await list("usr_a"))).toEqual({ unread: 2, action: 1 });
    expect(await markNotificationsRead(d1, "usr_a", "all", NOW)).toBe(2);

    const after = await list("usr_a");
    expect(after.map((i) => [i.id, i.read])).toEqual([
      ["approval_required:cand_1", true],
      ["change_completed:chg_done", true],
    ]);
    expect(countNotifications(after)).toEqual({ unread: 0, action: 1 });
  });

  it("a dead letter that fails again after a retry is unread again", async () => {
    const { db, d1, list } = setup();
    db.exec(`
      INSERT INTO dead_letters (id, command_id, command_type, queue, project_id, payload_json, error,
        attempt, dead_count, first_seen_at, last_seen_at)
      VALUES ('dl_1', 'cmd_1', 'agent.wake', 'agent-wakeups', 'proj_a', '{}', 'boom', 0, 1, '${T}', '${T}');
    `);
    await markNotificationsRead(d1, "usr_a", ["dead_letter:dl_1:1"], NOW);
    expect((await list("usr_a"))[0]).toMatchObject({ id: "dead_letter:dl_1:1", read: true });
    db.exec("UPDATE dead_letters SET dead_count = 2 WHERE id = 'dl_1'");
    expect((await list("usr_a"))[0]).toMatchObject({ id: "dead_letter:dl_1:2", read: false });
  });
});

describe("notification access", () => {
  it("never lists, counts, or marks another tenant's items", async () => {
    const { db, d1, change, candidate, list } = setup();
    change("chg_1", "proj_a");
    candidate("cand_1", "chg_1", { gated: true });
    change("chg_blocked", "proj_a", "budget_blocked");
    db.exec(`
      INSERT INTO dead_letters (id, command_id, command_type, queue, project_id, payload_json, error,
        attempt, dead_count, first_seen_at, last_seen_at)
      VALUES ('dl_1', 'cmd_1', 'agent.wake', 'agent-wakeups', 'proj_a', '{}', 'boom', 0, 1, '${T}', '${T}');
      INSERT INTO conflicts (id, change_id, resource, state, recommended_action, report_json,
        intents_json, review_json, fork_decision_json, created_at, updated_at)
      VALUES ('cf_1', 'chg_1', 'project:acme:wishlist:membership', 'confirmed', 'fork_candidates',
        '{}', '[{"summary":"normalized table"},{"summary":"append-only log"}]', '{}', '{}', '${T}', '${T}');
    `);

    const mine = await list("usr_a");
    expect(mine.map((i) => i.kind).sort()).toEqual([
      "approval_required",
      "budget_blocked",
      "conflict_open",
      "dead_letter",
    ]);

    // Tenant B sees and counts nothing of tenant A.
    expect(await list("usr_b")).toEqual([]);
    expect(countNotifications(await list("usr_b"))).toEqual({ unread: 0, action: 0 });
    // An unknown user (no membership) sees nothing.
    expect(await list("usr_nobody")).toEqual([]);

    // B marking A's IDs writes only B's own rows: A's items stay unread.
    await markNotificationsRead(
      d1,
      "usr_b",
      mine.map((i) => i.id),
      NOW,
    );
    expect(countNotifications(await list("usr_a"))).toEqual({ unread: 4, action: 2 });
    // B's "all" marks nothing: B can see no items.
    expect(await markNotificationsRead(d1, "usr_b", "all", NOW)).toBe(0);

    // Archiving the Project removes its items.
    db.exec("UPDATE projects SET status = 'archived' WHERE id = 'proj_a'");
    expect(await list("usr_a")).toEqual([]);
  });
});
