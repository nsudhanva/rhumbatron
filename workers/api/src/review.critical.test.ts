// Request review gate (ADR 0028): a member's request starts as `proposed` with no workflow and no
// model call; owner and admin requests never wait; a viewer cannot submit. Real migrations and
// route SQL on SQLite; the Durable Objects, the workflow, and the integration Worker are stubs.
// Also the Board's pure mapping: columns, closed-column limits, counts, and agents.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { BoardChangeRow } from "./board.ts";

vi.mock("@clerk/backend", () => ({
  verifyToken: async (token: string) => ({ sub: token }),
  createClerkClient: () => {
    throw new Error("no Clerk in tests");
  },
}));
const { projects } = await import("./projects.ts");
const { buildBoard } = await import("./board.ts");

const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");
const T = "2026-10-10T12:00:00.000Z";

function setup(memberRequestReview = 1) {
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
  db.exec(`
    INSERT INTO users (id, auth_subject, display_name, email, created_at, updated_at) VALUES
      ('usr_olga', 'olga', 'Olga', 'olga@example.org', '${T}', '${T}'),
      ('usr_adam', 'adam', 'Adam', 'adam@example.org', '${T}', '${T}'),
      ('usr_mia', 'mia', 'Mia', 'mia@example.org', '${T}', '${T}'),
      ('usr_vic', 'vic', 'Vic', 'vic@example.org', '${T}', '${T}');
    INSERT INTO organizations (id, name, created_at, updated_at) VALUES
      ('org_olga', 'Personal', '${T}', '${T}');
    INSERT INTO memberships (org_id, user_id, role, created_at) VALUES
      ('org_olga', 'usr_olga', 'owner', '${T}');
    INSERT INTO projects (id, org_id, name, slug, status, canonical_generation, created_at,
      updated_at, member_request_review) VALUES
      ('proj_p', 'org_olga', 'P', 'p', 'active', 4, '${T}', '${T}', ${memberRequestReview});
    INSERT INTO project_members (project_id, user_id, role, rank, added_by, created_at) VALUES
      ('proj_p', 'usr_olga', 'owner', 0, 'usr_olga', '${T}'),
      ('proj_p', 'usr_adam', 'admin', 5, 'usr_olga', '${T}'),
      ('proj_p', 'usr_mia', 'member', 10, 'usr_olga', '${T}'),
      ('proj_p', 'usr_vic', 'viewer', 30, 'usr_olga', '${T}');
  `);
  const workflows = vi.fn(async (_input: { id: string }) => undefined);
  const proposals = vi.fn(async (_input: { changeId: string }) => ({ recorded: true }));
  const deltas: unknown[] = [];
  const env = {
    DB,
    PROJECT_ROOT: {
      idFromName: (name: string) => name,
      get: () => ({ getCanonical: async () => ({ generation: 4 }) }),
    },
    PROJECT_VIEW: {
      idFromName: (name: string) => name,
      get: () => ({ applyDelta: async (delta: unknown) => deltas.push(delta) }),
    },
    CHANGE_WORKFLOW: { create: workflows },
    INTEGRATION: { recordProposal: proposals },
    CLERK_SECRET_KEY: "test",
    CLERK_AUTHORIZED_PARTIES: "http://localhost:5173",
    CLERK_ALLOW_MISSING_AZP: "true",
  } as unknown as Env;
  const create = (subject: string, body: Record<string, unknown> = {}) =>
    projects.request(
      "/v1/projects/proj_p/changes",
      {
        method: "POST",
        headers: { authorization: `Bearer ${subject}`, "content-type": "application/json" },
        body: JSON.stringify({ goal: "Add shared wishlists", ...body }),
      },
      env,
    );
  return { db, create, workflows, proposals, deltas };
}

type Created = { data: { id: string; status: string; review: { state: string } } };

describe("request review gate", () => {
  it("proposes a member's request without a workflow, and starts owner and admin requests", async () => {
    const { db, create, workflows, proposals } = setup();
    const member = await create("mia");
    expect(member.status).toBe(201);
    const proposed = ((await member.json()) as Created).data;
    expect(proposed).toMatchObject({ status: "proposed", review: { state: "proposed" } });
    expect(proposals).toHaveBeenCalledTimes(1);
    expect(workflows).not.toHaveBeenCalled();

    for (const subject of ["olga", "adam"]) {
      const response = await create(subject);
      expect(response.status).toBe(201);
      const change = ((await response.json()) as Created).data;
      expect(change).toMatchObject({ status: "created", review: { state: "not_needed" } });
      expect(workflows).toHaveBeenLastCalledWith({
        id: change.id,
        params: { changeId: change.id },
      });
    }
    expect(workflows).toHaveBeenCalledTimes(2);
    expect(proposals).toHaveBeenCalledTimes(1);
    const ranks = db
      .prepare("SELECT created_by, requester_rank, review_state FROM changes ORDER BY created_by")
      .all();
    expect(ranks).toEqual([
      { created_by: "usr_adam", requester_rank: 5, review_state: null },
      { created_by: "usr_mia", requester_rank: 10, review_state: "proposed" },
      { created_by: "usr_olga", requester_rank: 0, review_state: null },
    ]);
  });

  it("lets a member's request through when the Project turns review off", async () => {
    const { create, workflows, proposals } = setup(0);
    const response = await create("mia");
    expect(((await response.json()) as Created).data.status).toBe("created");
    expect(workflows).toHaveBeenCalledTimes(1);
    expect(proposals).not.toHaveBeenCalled();
  });

  it("refuses a viewer and a stranger", async () => {
    const { create, workflows } = setup();
    expect((await create("vic")).status).toBe(403);
    expect((await create("eve")).status).toBe(404);
    expect(workflows).not.toHaveBeenCalled();
  });

  it("returns the same proposed Change for a repeated clientRequestId", async () => {
    const { create, proposals } = setup();
    const first = ((await (await create("mia", { clientRequestId: "r1" })).json()) as Created).data;
    const again = await create("mia", { clientRequestId: "r1" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as Created).data).toMatchObject({
      id: first.id,
      status: "proposed",
    });
    expect(proposals).toHaveBeenCalledTimes(1);
  });
});

const row = (id: string, status: string, by: string, extra: Partial<BoardChangeRow> = {}) =>
  ({
    id,
    goal: `Goal ${id}`,
    title: null,
    status,
    created_by: by,
    created_at: T,
    updated_at: T,
    display_name: by.slice(4),
    email: null,
    requester_role: by === "usr_gone" ? null : "member",
    generation: null,
    review_state: null,
    review_decided_by: null,
    review_decided_at: null,
    review_reason: null,
    reviewer_name: null,
    reviewer_email: null,
    ...extra,
  }) satisfies BoardChangeRow;

describe("board", () => {
  it("puts cards in columns, keeps 20 closed cards per column, and counts all rows", () => {
    const changes = [
      row("chg_p", "proposed", "usr_mia", { review_state: "proposed" }),
      row("chg_n", "needs_input", "usr_mia"),
      row("chg_r", "running", "usr_adam"),
      row("chg_v", "awaiting_approval", "usr_adam"),
      row("chg_d", "declined", "usr_mia", {
        review_state: "declined",
        review_decided_by: "usr_adam",
        review_decided_at: T,
        review_reason: "Out of scope",
        reviewer_name: "Adam",
      }),
      ...Array.from({ length: 25 }, (_, i) =>
        row(`chg_s${i}`, "completed", "usr_gone", { generation: i + 1 }),
      ),
    ];
    const board = buildBoard({
      viewerUserId: "usr_mia",
      viewerRole: "member",
      changes,
      tasks: [
        {
          change_id: "chg_r",
          id: "t1",
          title: "API",
          status: "running",
          agent_id: "agt_1",
          tier: "sonnet",
        },
        {
          change_id: "chg_r",
          id: "t2",
          title: "UI",
          status: "pending",
          agent_id: null,
          tier: null,
        },
        {
          change_id: "chg_r",
          id: "t3",
          title: "DB",
          status: "completed",
          agent_id: "agt_3",
          tier: "haiku",
        },
      ],
      members: [
        { user_id: "usr_adam", role: "admin", display_name: "Adam", email: null },
        { user_id: "usr_mia", role: "member", display_name: "Mia", email: null },
      ],
    });
    expect(board.canReview).toBe(false);
    const column = (id: string) => board.cards.find((c) => c.changeId === id)?.column;
    expect([
      column("chg_p"),
      column("chg_n"),
      column("chg_r"),
      column("chg_v"),
      column("chg_d"),
    ]).toEqual(["proposed", "needs_answer", "building", "checking", "not_built"]);
    expect(board.cards.filter((c) => c.column === "shipped")).toHaveLength(20);
    expect(board.cards.find((c) => c.changeId === "chg_d")?.review).toEqual({
      state: "declined",
      decidedBy: { userId: "usr_adam", name: "Adam" },
      decidedAt: T,
      reason: "Out of scope",
    });
    const running = board.cards.find((c) => c.changeId === "chg_r");
    expect(running?.tasks).toEqual({ done: 1, total: 3 });
    expect(running?.agents).toEqual([
      { agentId: "agt_1", taskTitle: "API", tier: "sonnet", state: "running" },
      { agentId: "agt_3", taskTitle: "DB", tier: "haiku", state: "done" },
    ]);
    expect(board.people).toEqual([
      expect.objectContaining({
        userId: "usr_adam",
        role: "admin",
        counts: { proposed: 0, active: 2, shipped: 0, notBuilt: 0 },
      }),
      expect.objectContaining({
        userId: "usr_mia",
        isYou: true,
        counts: { proposed: 1, active: 1, shipped: 0, notBuilt: 1 },
      }),
      expect.objectContaining({
        userId: "usr_gone",
        role: null,
        counts: { proposed: 0, active: 0, shipped: 25, notBuilt: 0 },
      }),
    ]);
  });

  it("lets an owner or admin review", () => {
    for (const viewerRole of ["owner", "admin"] as const)
      expect(
        buildBoard({ viewerUserId: "u", viewerRole, changes: [], tasks: [], members: [] })
          .canReview,
      ).toBe(true);
  });
});
