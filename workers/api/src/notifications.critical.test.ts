// Inbox derivation. An action item must exist exactly while its
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

describe("shared Project request notifications", () => {
  function shared() {
    const ctx = setup();
    ctx.db.exec(`
      INSERT INTO users (id, auth_subject, created_at, updated_at)
        VALUES ('usr_c', 'c', '${T}', '${T}');
      INSERT INTO project_members (project_id, user_id, role, rank, added_by, created_at) VALUES
        ('proj_a', 'usr_a', 'owner', 0, 'test', '${T}'),
        ('proj_a', 'usr_c', 'member', 10, 'test', '${T}');
    `);
    const request = (id: string, status: string, outcome: string | null, updatedAt = T) =>
      ctx.db
        .prepare(
          `INSERT INTO changes (id, project_id, goal, status, base_generation, risk_tier, budget_usd,
             created_by, outcome, outcome_reason, created_at, updated_at)
           VALUES (?, 'proj_a', 'Add dark mode', ?, 1841, 'low', 3, 'usr_c', ?, 'Another request won', ?, ?)`,
        )
        .run(id, status, outcome, T, updatedAt);
    return { ...ctx, request };
  }

  it("only the requester sees request_not_selected, and a duplicate outcome produces none", async () => {
    const { request, kinds, list } = shared();
    request("chg_ns", "not_selected", "not_selected");
    request("chg_dup", "cancelled", "duplicate");

    expect(await kinds("usr_c")).toEqual(["request_not_selected:chg_ns"]);
    expect((await list("usr_c"))[0]).toMatchObject({
      severity: "attention",
      href: "/changes/chg_ns",
      body: expect.stringContaining("Another request won"),
    });
    expect(await kinds("usr_a")).toEqual([]);
    expect(await kinds("usr_b")).toEqual([]);
  });

  it("request_not_selected leaves after the window, and a read mark clears unread", async () => {
    const { d1, request, list } = shared();
    request("chg_ns", "not_selected", "not_selected");
    request("chg_old", "not_selected", "not_selected", OLD);
    await markNotificationsRead(d1, "usr_c", ["request_not_selected:chg_ns"], NOW);
    expect((await list("usr_c")).map((i) => [i.id, i.read])).toEqual([
      ["request_not_selected:chg_ns", true],
    ]);
  });

  it("request_needs_input goes to the requester, and to the owner only for a conflict", async () => {
    const { db, d1, request, kinds, list } = shared();
    const ask = (id: string, kind: string, round = 1) => {
      request(id, "needs_input", null);
      db.prepare("UPDATE changes SET clarification_json = ? WHERE id = ?").run(
        JSON.stringify({ kind, summary: `About ${kind}`, questions: [], round }),
        id,
      );
    };
    ask("chg_unclear", "unclear");
    ask("chg_conflict", "conflict", 2);

    expect((await kinds("usr_c")).sort()).toEqual([
      "request_needs_input:chg_conflict:2",
      "request_needs_input:chg_unclear:1",
    ]);
    expect(await kinds("usr_a")).toEqual(["request_needs_input:chg_conflict:2"]);
    expect(await kinds("usr_b")).toEqual([]);

    await markNotificationsRead(d1, "usr_a", "all", NOW);
    const after = await list("usr_a");
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      read: true,
      severity: "action",
      title: "A request conflicts with another request",
    });
    expect(countNotifications(after)).toEqual({ unread: 0, action: 1 });
  });

  it("only the earlier requester gets the first-come choice; the later requester hears the result", async () => {
    const { db, request, kinds, list } = shared();
    // usr_c (member) asked first; usr_a (the owner) asked later and conflicts.
    request("chg_first", "running", null);
    db.exec(`
      INSERT INTO changes (id, project_id, goal, status, base_generation, budget_usd, created_by,
        created_at, updated_at)
        VALUES ('chg_later', 'proj_a', 'Use 16 colors', 'awaiting_choice', 1841, 3, 'usr_a', '${T}', '${T}');
      INSERT INTO request_choices (id, project_id, first_change_id, later_change_id, conflict_id,
        asked_user_id, created_at)
        VALUES ('rw_1', 'proj_a', 'chg_first', 'chg_later', 'rc_1', 'usr_c', '${T}');
    `);
    expect(await kinds("usr_c")).toEqual(["request_choice_needed:rw_1"]);
    expect((await list("usr_c"))[0]).toMatchObject({
      severity: "action",
      href: "/changes/chg_first",
      changeId: "chg_later",
    });
    // The owner is the later requester here: no admin or owner answers for the earlier requester.
    expect(await kinds("usr_a")).toEqual([]);

    db.exec(`UPDATE request_choices SET choice = 'apply_theirs', chosen_by = 'usr_c', chosen_at = '${T}';
      UPDATE changes SET status = 'queued' WHERE id = 'chg_later';`);
    expect(await kinds("usr_c")).toEqual([]);
    expect(await kinds("usr_a")).toEqual(["request_choice_made:rw_1"]);
  });
});
