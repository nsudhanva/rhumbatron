// Platform access gate and platform admin check (ADR 0033). Real migrations and SQL on SQLite;
// Clerk's verifyToken is stubbed so the bearer token is the session subject.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AccessRequestList,
  AdminCosts,
  AdminEventList,
  AdminOverview,
  AdminProjectList,
  AdminUserDetail,
  AdminUserList,
  ApiErrorBody,
  apiData,
  Me,
  MyCosts,
  PlatformSettings,
} from "@rhumbatron/protocol";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

vi.mock("@clerk/backend", () => ({
  verifyToken: async (token: string) => ({ sub: token }),
  createClerkClient: () => ({
    users: { getUser: async () => ({ emailAddresses: [], firstName: null, lastName: null }) },
  }),
}));
const { requireAuth } = await import("./auth.ts");
const { platformAdminIds } = await import("./access.ts");
const { admin } = await import("./admin.ts");
const { budgets } = await import("./budgets.ts");
const { deriveNotifications } = await import("./notifications.ts");

const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");
const T = "2026-10-01T12:00:00.000Z";
const MONTH = new Date().toISOString().slice(0, 7);

function sqliteD1() {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  const isRead = (sql: string) => /^\s*(SELECT|WITH)/i.test(sql);
  const run = (sql: string, params: unknown[]) => {
    const result = db.prepare(sql).run(...(params as never[]));
    return { results: [], meta: { changes: Number(result.changes) } };
  };
  const all = (sql: string, params: unknown[]) => ({
    results: db.prepare(sql).all(...(params as never[])),
    meta: { changes: 0 },
  });
  type Statement = {
    sql: string;
    params: unknown[];
    bind: (...next: unknown[]) => Statement;
    first: () => Promise<unknown>;
    all: () => Promise<unknown>;
    run: () => Promise<unknown>;
  };
  const statement = (sql: string, params: unknown[] = []): Statement => ({
    sql,
    params,
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    all: async () => all(sql, params),
    run: async () => run(sql, params),
  });
  const d1 = {
    prepare: (sql: string) => statement(sql),
    batch: async (list: Statement[]) =>
      list.map((s) => (isRead(s.sql) ? all(s.sql, s.params) : run(s.sql, s.params))),
  } as unknown as D1Database;
  db.exec(`
    INSERT INTO users (id, auth_subject, email, display_name, access_status, created_at, updated_at)
    VALUES
      ('usr_alice', 'alice', 'alice@example.com', 'Alice', 'approved', '${T}', '${T}'),
      ('usr_paula', 'paula', 'paula@example.com', 'Paula', 'pending', '${T}', '${T}'),
      ('usr_dave', 'dave', 'dave@example.com', 'Dave', 'declined', '${T}', '${T}'),
      ('usr_admin', 'admin', 'admin@example.com', 'Admin', 'approved', '${T}', '${T}');
    INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('org_alice', 'Personal', '${T}', '${T}');
    INSERT INTO memberships (org_id, user_id, role, created_at) VALUES ('org_alice', 'usr_alice', 'owner', '${T}');
    INSERT INTO projects (id, org_id, name, slug, status, canonical_generation, created_at, updated_at)
      VALUES ('proj_a', 'org_alice', 'Shop', 'shop', 'active', 3, '${T}', '${T}');
    INSERT INTO project_members (project_id, user_id, role, rank, added_by, created_at)
      VALUES ('proj_a', 'usr_alice', 'owner', 0, 'usr_alice', '${T}');
    INSERT INTO changes (id, project_id, goal, status, base_generation, budget_usd, created_by, created_at, updated_at)
      VALUES ('chg_a', 'proj_a', 'Add a wishlist', 'running', 3, 3, 'usr_alice', '${MONTH}-02T00:00:00.000Z', '${T}');
    INSERT INTO tasks (id, change_id, kind, status, created_at, updated_at)
      VALUES ('tsk_a', 'chg_a', 'implement', 'running', '${T}', '${T}');
    INSERT INTO task_runs (id, task_id, agent_id, attempt, tier, status, model_calls, input_tokens, output_tokens, cost_usd, started_at)
      VALUES ('run_a', 'tsk_a', 'agt_a', 1, 'sonnet', 'completed', 4, 1000, 200, 0.25, '${new Date().toISOString()}');
    INSERT INTO usage_counters (day, counter, count) VALUES
      ('total', 'change-usd-micro:chg_a', 400000),
      ('${MONTH}', 'user-usd-micro:usr_alice', 400000),
      ('${MONTH}', 'project-usd-micro:proj_a', 400000),
      ('${MONTH}', 'anthropic-usd-micro', 900000);
    INSERT INTO project_events (event_id, event_type, event_version, project_id, change_id, actor_kind, actor_id, occurred_at, recorded_at, summary)
      VALUES ('evt_1', 'change.created', 1, 'proj_a', 'chg_a', 'user', 'usr_alice', '${T}', '${T}', 'Alice asked');
  `);
  return { db, d1 };
}

function harness(options: { approval?: boolean; adminIds?: string } = {}) {
  const { db, d1 } = sqliteD1();
  if (options.approval) {
    db.exec(`INSERT INTO platform_settings (key, value, updated_at) VALUES
      ('signup_approval_required', 'true', '${T}')`);
  }
  const env = {
    DB: d1,
    CLERK_SECRET_KEY: "test",
    CLERK_AUTHORIZED_PARTIES: "https://rhumbatron.test",
    CLERK_ALLOW_MISSING_AZP: "true",
    PLATFORM_ADMIN_USER_IDS: options.adminIds ?? '["usr_admin"]',
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>()
    .route("/", admin)
    .route("/", budgets)
    .get("/v1/projects", requireAuth, (c) => c.json({ data: [] }));
  const call = (subject: string, path: string, init: RequestInit = {}) =>
    app.request(
      path,
      {
        ...init,
        headers: {
          authorization: `Bearer ${subject}`,
          "content-type": "application/json",
          ...(init.headers as Record<string, string> | undefined),
        },
      },
      env,
    );
  const statusOf = (userId: string) =>
    (
      db.prepare("SELECT access_status FROM users WHERE id = ?").get(userId) as
        | { access_status: string }
        | undefined
    )?.access_status;
  const audits = () =>
    db.prepare("SELECT action, target FROM admin_audit").all() as {
      action: string;
      target: string | null;
    }[];
  return { db, d1, env, call, statusOf, audits };
}

const errorOf = async (res: Response) => ApiErrorBody.parse(await res.json()).error;

describe("access gate", () => {
  it("refuses a pending user on every route except GET /v1/me", async () => {
    const { call } = harness();
    const refused = await call("paula", "/v1/projects");
    expect(refused.status).toBe(403);
    const error = await errorOf(refused);
    expect(error.code).toBe("approval_required");
    expect(error.details).toEqual({ status: "pending" });
    expect((await call("paula", "/v1/me/costs")).status).toBe(403);
    expect(
      (await call("paula", "/v1/me/budget", { method: "PATCH", body: '{"monthlyBudgetUsd":5}' }))
        .status,
    ).toBe(403);

    const me = await call("paula", "/v1/me");
    expect(me.status).toBe(200);
    const body = apiData(Me).parse(await me.json());
    expect(body.data.accessStatus).toBe("pending");
    expect(body.data.platformAdmin).toBe(false);
  });

  it("refuses a declined user with status declined", async () => {
    const { call } = harness();
    const res = await call("dave", "/v1/projects");
    expect(res.status).toBe(403);
    expect((await errorOf(res)).details).toEqual({ status: "declined" });
    expect((await call("dave", "/v1/me")).status).toBe(200);
  });

  it("lets an approved user through", async () => {
    const { call } = harness();
    expect((await call("alice", "/v1/projects")).status).toBe(200);
  });

  it("creates a new user as pending only while sign-up approval is on", async () => {
    const on = harness({ approval: true });
    expect((await on.call("newbie", "/v1/projects")).status).toBe(403);
    expect(on.statusOf("usr_newbie")).toBe("pending");
    const me = apiData(Me).parse(await (await on.call("newbie", "/v1/me")).json());
    expect(me.data.accessStatus).toBe("pending");

    const off = harness();
    expect((await off.call("newbie", "/v1/projects")).status).toBe(200);
    expect(off.statusOf("usr_newbie")).toBe("approved");
  });

  it("always approves a platform admin, also a new one while approval is on", async () => {
    const h = harness({ approval: true, adminIds: '["usr_admin","usr_root"]' });
    expect((await h.call("root", "/v1/projects")).status).toBe(200);
    expect(h.statusOf("usr_root")).toBe("approved");
    h.db.exec("UPDATE users SET access_status = 'pending' WHERE id = 'usr_admin'");
    expect((await h.call("admin", "/v1/projects")).status).toBe(200);
    const me = apiData(Me).parse(await (await h.call("admin", "/v1/me")).json());
    expect(me.data).toMatchObject({ platformAdmin: true, accessStatus: "approved" });
  });

  it("does not approve pending people when the switch turns off", async () => {
    const h = harness({ approval: true });
    const res = await h.call("admin", "/v1/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({ signupApprovalRequired: false }),
    });
    expect(apiData(PlatformSettings).parse(await res.json()).data.signupApprovalRequired).toBe(
      false,
    );
    expect(h.statusOf("usr_paula")).toBe("pending");
    expect((await h.call("paula", "/v1/projects")).status).toBe(403);
  });
});

describe("platform admin check", () => {
  const ADMIN_GETS = [
    "/v1/admin/overview",
    "/v1/admin/users",
    "/v1/admin/users/usr_alice",
    "/v1/admin/projects",
    "/v1/admin/costs",
    "/v1/admin/events",
    "/v1/admin/settings",
    "/v1/admin/access-requests",
  ];

  it("refuses an approved user who is not an admin, whatever the request says", async () => {
    const { call, audits } = harness();
    for (const path of ADMIN_GETS) {
      const res = await call("alice", `${path}?admin=true&userId=usr_admin`, {
        headers: { "x-platform-admin": "true" },
      });
      expect(res.status, path).toBe(403);
      expect((await errorOf(res)).code).toBe("forbidden");
    }
    const write = await call("alice", "/v1/admin/users/usr_paula/access", {
      method: "POST",
      body: JSON.stringify({ decision: "approve", adminUserId: "usr_admin" }),
    });
    expect(write.status).toBe(403);
    expect(audits()).toEqual([]);
  });

  it("refuses a pending person with approval_required before the admin check", async () => {
    const { call } = harness();
    const res = await call("paula", "/v1/admin/overview");
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("approval_required");
  });

  it("fails closed on a malformed admin list", () => {
    expect(platformAdminIds("not json").size).toBe(0);
    expect(platformAdminIds('{"id":"usr_admin"}').size).toBe(0);
    expect([...platformAdminIds('["usr_admin", "admin", 7, "usr_x y"]')]).toEqual(["usr_admin"]);
    expect(platformAdminIds(undefined).size).toBe(0);
  });

  it("serves every admin read to the admin and audits each one", async () => {
    const { call, audits } = harness();
    const schemas = [
      AdminOverview,
      AdminUserList,
      AdminUserDetail,
      AdminProjectList,
      AdminCosts,
      AdminEventList,
      PlatformSettings,
      AccessRequestList,
    ];
    for (const [i, path] of ADMIN_GETS.entries()) {
      const res = await call("admin", path);
      expect(res.status, path).toBe(200);
      apiData(schemas[i] as typeof AdminOverview).parse(await res.json());
    }
    expect(audits()).toHaveLength(ADMIN_GETS.length);

    const overview = apiData(AdminOverview).parse(
      await (await call("admin", "/v1/admin/overview")).json(),
    ).data;
    // The environment meter holds 0.9 USD this month; the user and Project meters 0.4 USD.
    expect(overview).toMatchObject({
      spendUsd: 0.9,
      attributedUsd: 0.4,
      unattributedUsd: 0.5,
      users: { total: 4, pending: 1 },
    });
    const totals = {
      monthUsd: 0.4,
      allTimeUsd: 0.4,
      unattributedMonthUsd: 0.5,
      unattributedAllTimeUsd: 0.5,
    };
    const users = apiData(AdminUserList).parse(
      await (await call("admin", "/v1/admin/users?q=alice")).json(),
    ).data;
    expect(users.users).toHaveLength(1);
    expect(users.users[0]).toMatchObject({ projects: 1, requests: 1, spendAllTimeUsd: 0.4 });
    expect(users.totals).toEqual(totals);
    const projects = apiData(AdminProjectList).parse(
      await (await call("admin", "/v1/admin/projects")).json(),
    ).data;
    expect(projects.totals).toEqual(totals);

    // Whole months: the task_runs rows plus "Other model calls" add up to the environment meter.
    const today = new Date().toISOString().slice(0, 10);
    const costs = apiData(AdminCosts).parse(
      await (
        await call("admin", `/v1/admin/costs?groupBy=model&from=${MONTH}-01&to=${today}`)
      ).json(),
    ).data;
    expect(costs.rows).toEqual([
      {
        key: "sonnet",
        label: "sonnet",
        spendUsd: 0.25,
        calls: 4,
        inputTokens: 1000,
        outputTokens: 200,
      },
      {
        key: "other",
        label: "Other model calls (no per-call record)",
        spendUsd: 0.65,
        calls: null,
        inputTokens: null,
        outputTokens: null,
      },
    ]);
    expect(costs.totalUsd).toBeCloseTo(0.9, 6);

    // Grouped by user, the rows read the meters (whole months) and add up to the environment meter.
    const byUser = apiData(AdminCosts).parse(
      await (await call("admin", "/v1/admin/costs?groupBy=user")).json(),
    ).data;
    expect(byUser.rows.map((r) => [r.key, r.spendUsd])).toEqual([
      ["usr_alice", 0.4],
      ["unattributed", 0.5],
    ]);
    expect(byUser.totalUsd).toBeCloseTo(0.9, 6);
    expect(byUser.from.endsWith("-01")).toBe(true);
    const csv = await call("admin", "/v1/admin/costs?groupBy=user&format=csv");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect((await csv.text()).split("\n").slice(1, 3)).toEqual([
      "usr_alice,Alice,0.400000,,,",
      "unattributed,Not attributed,0.500000,,,",
    ]);
  });

  it("decides access and approves all pending people", async () => {
    const h = harness();
    const declined = await h.call("admin", "/v1/admin/users/usr_paula/access", {
      method: "POST",
      body: JSON.stringify({ decision: "decline" }),
    });
    expect(declined.status).toBe(200);
    expect(h.statusOf("usr_paula")).toBe("declined");
    const refuseAdmin = await h.call("admin", "/v1/admin/users/usr_admin/access", {
      method: "POST",
      body: JSON.stringify({ decision: "decline" }),
    });
    expect(refuseAdmin.status).toBe(409);

    h.db.exec(`INSERT INTO users (id, auth_subject, access_status, created_at, updated_at) VALUES
      ('usr_p1', 'p1', 'pending', '${T}', '${T}'), ('usr_p2', 'p2', 'pending', '${T}', '${T}')`);
    const all = await h.call("admin", "/v1/admin/access-requests/approve-all", { method: "POST" });
    expect(await all.json()).toEqual({ data: { approved: 2 } });
    expect(h.statusOf("usr_p1")).toBe("approved");
    expect(h.statusOf("usr_paula")).toBe("declined");
    expect(h.audits().map((a) => a.action)).toEqual([
      "access.decide",
      "access.decide",
      "access.approve_all",
    ]);
  });
});

describe("access notifications and user costs", () => {
  it("shows pending people to a platform admin only, and a decision to its person", async () => {
    const h = harness();
    const now = new Date();
    const forAdmin = await deriveNotifications(h.d1, "usr_admin", now, true);
    expect(forAdmin.map((n) => n.id)).toContain("access_request:usr_paula");
    const forAlice = await deriveNotifications(h.d1, "usr_alice", now, false);
    expect(forAlice.some((n) => n.kind === "access_request")).toBe(false);

    await h.call("admin", "/v1/admin/users/usr_paula/access", {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    });
    const forPaula = await deriveNotifications(h.d1, "usr_paula", new Date(), false);
    expect(forPaula.map((n) => n.id)).toEqual(["access_decided:usr_paula"]);
  });

  it("returns only the caller's own costs", async () => {
    const { call } = harness();
    const res = await call("alice", "/v1/me/costs?months=3");
    expect(res.status).toBe(200);
    const costs = apiData(MyCosts).parse(await res.json()).data;
    expect(costs.months).toHaveLength(3);
    expect(costs.months[2]).toEqual({ month: MONTH, spendUsd: 0.4 });
    expect(costs.byProject).toEqual([{ projectId: "proj_a", name: "Shop", spendUsd: 0.4 }]);
    expect(costs.byChange[0]).toMatchObject({ changeId: "chg_a", spendUsd: 0.4 });
    const other = apiData(MyCosts).parse(await (await call("admin", "/v1/me/costs")).json()).data;
    expect(other.byChange).toEqual([]);
  });
});
