import {
  AccessDecisionRequest,
  AccessDecisionResult,
  AccessRequestList,
  AccessStatus,
  AdminCostGroup,
  AdminCosts,
  AdminEventList,
  AdminOverview,
  type AdminProject,
  AdminProjectList,
  type AdminUser,
  AdminUserDetail,
  AdminUserList,
  APP_PRODUCTION_CHANNEL,
  ApproveAllResult,
  apiData,
  appUrl,
  ChangeStatus,
  changeTitle,
  METER_COUNTER,
  PlatformSettings,
  UpdatePlatformSettingsRequest,
} from "@rhumbatron/protocol";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { auditStatements, isPlatformAdmin, SIGNUP_APPROVAL_KEY } from "./access.ts";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { anthropicMonthlyBudgetUsd, sandboxMonthlySeconds } from "./cost.ts";
import { fail, respond, validate } from "./http.ts";
import { requesterName } from "./members.ts";
import { changeMeterSql, microToUsd, monthList, monthlyMeter, monthOf } from "./spend.ts";

/**
 * Platform admin routes (ADR 0033, docs/protocols/README.md "Platform admin").
 *
 * - Every route needs a platform admin: the user ID of the verified session is in
 *   `PLATFORM_ADMIN_USER_IDS`. Anyone else gets 403 `forbidden`. No request field can name an
 *   admin.
 * - The panel reads only, except the sign-up approval switch and the access decisions.
 * - Every read and write adds one `admin_audit` row (and deletes rows older than 365 days).
 *
 * D1 cost: each read is one batch of indexed, bounded queries (pages of 50, at most 1,000 cost
 * rows, a date range of at most 366 days). Admin reads are rare: one person uses the panel.
 */

type AdminVariables = AuthVariables & { adminUserId: string };
type AppEnv = { Bindings: Env; Variables: AdminVariables };

const PAGE = 50;
const COST_ROW_LIMIT = 1000;
const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;
const DETAIL_PROJECTS = 100;
const DETAIL_CHANGES = 20;
const DETAIL_MONTHS = 12;
const ACCESS_REQUEST_LIMIT = 200;

/** Fallback of the `BROWSER_DAILY_SECONDS` binding; mirrors check-semantics.ts in integration. */
const BROWSER_DAILY_SECONDS = 500;
/** Mirrors APP_BUILDS_PER_DAY in workers/integration/src/app-release.ts. */
const APP_BUILDS_PER_DAY = 60;

const FINAL_CHANGE_STATUSES = new Set([
  "completed",
  "cancelled",
  "failed",
  "not_selected",
  "declined",
]);
const ACTIVE_CHANGE_SQL = ChangeStatus.options
  .filter((s) => !FINAL_CHANGE_STATUSES.has(s))
  .map((s) => `'${s}'`)
  .join(", ");

const browserDailySeconds = (configured?: string) => {
  const n = Number(configured);
  return configured && Number.isInteger(n) && n > 0 ? n : BROWSER_DAILY_SECONDS;
};

/** Platform admin check, after `requireAuth`. Reads only the session subject. */
const requirePlatformAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const userId = `usr_${c.get("authSubject")}`;
  if (!isPlatformAdmin(c.env, userId)) {
    return fail(c, 403, "forbidden", "Only a platform admin can use this route");
  }
  c.set("adminUserId", userId);
  await next();
});

/** Records one admin action. Awaited: an admin read without its audit row does not answer. */
async function audit(c: Context<AppEnv>, action: string, target: string | null) {
  await c.env.DB.batch(
    auditStatements(c.env.DB, {
      adminUserId: c.get("adminUserId"),
      action,
      target,
      now: new Date(),
    }),
  );
}

/** The query string of the request, as the audit target of a list read. */
const queryTarget = (c: Context) => {
  const q = new URL(c.req.url).search;
  return q ? q.slice(1) : null;
};

/* ------------------------------------------------------------------------------------------ */
/* Query parsing                                                                              */
/* ------------------------------------------------------------------------------------------ */

const UserIdSchema = z.string().regex(/^usr_[A-Za-z0-9_]+$/);
const ProjectIdSchema = z.string().regex(/^proj_[a-z0-9-]+$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Search = z.string().trim().min(1).max(100).optional();
const Cursor = z.string().max(200).optional();

/** `LIKE` pattern of a search term; `\` escapes the wildcards of the term. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/** Cursor of a newest-first page: `<created_at>~<id>`. */
const encodeCursor = (createdAt: string, id: string) => `${createdAt}~${id}`;
function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  const at = cursor.lastIndexOf("~");
  if (at <= 0) return null;
  return { createdAt: cursor.slice(0, at), id: cursor.slice(at + 1) };
}

const UsersQuery = z.object({
  q: Search,
  status: AccessStatus.optional(),
  cursor: Cursor,
});
const ProjectsQuery = z.object({
  q: Search,
  ownerId: UserIdSchema.optional(),
  status: z.enum(["active", "archived"]).optional(),
  cursor: Cursor,
});
const CostsQuery = z.object({
  from: Day.optional(),
  to: Day.optional(),
  userId: UserIdSchema.optional(),
  projectId: ProjectIdSchema.optional(),
  groupBy: AdminCostGroup.default("day"),
  format: z.enum(["json", "csv"]).default("json"),
});
const EventsQuery = z.object({
  userId: UserIdSchema.optional(),
  projectId: ProjectIdSchema.optional(),
  type: z
    .string()
    .regex(/^[a-z0-9_.]+$/)
    .max(80)
    .optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  cursor: z
    .string()
    .regex(/^\d{1,15}$/)
    .optional(),
});
const UserParam = z.object({ userId: UserIdSchema });

/* ------------------------------------------------------------------------------------------ */
/* Users                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** Select list of one user row aliased `u`. `?1` is this month (`YYYY-MM`). */
const USER_COLUMNS = `u.id, u.display_name, u.email, u.access_status, u.monthly_budget_usd,
  u.created_at, u.last_seen_at,
  (SELECT COUNT(*) FROM projects p WHERE p.id IN (
     SELECT p2.id FROM memberships m JOIN projects p2 ON p2.org_id = m.org_id WHERE m.user_id = u.id
     UNION SELECT pm.project_id FROM project_members pm WHERE pm.user_id = u.id)) AS projects,
  (SELECT COUNT(*) FROM changes c WHERE c.created_by = u.id) AS requests,
  (SELECT count FROM usage_counters WHERE day = ?1 AND counter = 'user-usd-micro:' || u.id)
    AS month_micro,
  (SELECT COALESCE(SUM(${changeMeterSql("c")}), 0) FROM changes c WHERE c.created_by = u.id)
    AS all_micro`;

type UserRow = {
  id: string;
  display_name: string | null;
  email: string | null;
  access_status: string;
  monthly_budget_usd: number | null;
  created_at: string;
  last_seen_at: string | null;
  projects: number;
  requests: number;
  month_micro: number | null;
  all_micro: number | null;
};

function userView(row: UserRow, admin: boolean): AdminUser {
  return {
    userId: row.id,
    name: requesterName(row.display_name, row.email),
    email: row.email,
    accessStatus: admin ? "approved" : AccessStatus.catch("declined").parse(row.access_status),
    projects: row.projects,
    requests: row.requests,
    spendMonthUsd: microToUsd(row.month_micro),
    spendAllTimeUsd: microToUsd(row.all_micro),
    monthlyBudgetUsd: row.monthly_budget_usd,
    createdAt: row.created_at,
    lastActiveAt: row.last_seen_at,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Costs                                                                                      */
/* ------------------------------------------------------------------------------------------ */

const COST_GROUP: Record<AdminCostGroup, { key: string; label: string }> = {
  user: {
    key: "c.created_by",
    label: "COALESCE(u.display_name, u.email, c.created_by)",
  },
  project: { key: "c.project_id", label: "COALESCE(p.name, c.project_id)" },
  model: { key: "r.tier", label: "r.tier" },
  day: { key: "substr(r.started_at, 1, 10)", label: "substr(r.started_at, 1, 10)" },
};

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, days: number) => {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
};

/** Months (`YYYY-MM`) from the month of `from` to the month of `to`, both included. */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  for (let i = 0; i < 24; i++) {
    const month = `${y}-${String(m).padStart(2, "0")}`;
    out.push(month);
    if (month >= end) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

const csvCell = (value: string | number) => {
  const text = String(value);
  // A leading formula character runs as a formula in a spreadsheet: prefix it with a quote.
  const safe = /^[=+\-@\t\r]/.test(text) && typeof value === "string" ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

/* ------------------------------------------------------------------------------------------ */
/* Routes                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export const admin = new Hono<AppEnv>()
  .use("/v1/admin/*", requireAuth, requirePlatformAdmin)

  .get("/v1/admin/overview", async (c) => {
    const db = c.env.DB;
    const now = new Date();
    const month = monthOf(now);
    const day = isoDay(now);
    const [meters, users, projects, changes, agents] = await db.batch([
      db
        .prepare(
          `SELECT day, counter, count FROM usage_counters
           WHERE (day = ?1 AND counter IN ('anthropic-usd-micro', 'sandbox-seconds'))
              OR (day = ?2 AND counter IN ('browser-seconds', 'app-builds'))`,
        )
        .bind(month, day),
      db.prepare(
        `SELECT (SELECT COUNT(*) FROM users) AS total,
                (SELECT COUNT(*) FROM users WHERE access_status = 'pending') AS pending`,
      ),
      db.prepare(
        `SELECT (SELECT COUNT(*) FROM projects WHERE status = 'active') AS active,
                (SELECT COUNT(*) FROM projects WHERE status = 'archived') AS archived`,
      ),
      db.prepare(`SELECT COUNT(*) AS active FROM changes WHERE status IN (${ACTIVE_CHANGE_SQL})`),
      db.prepare("SELECT COUNT(*) AS active FROM tasks WHERE status IN ('assigned', 'running')"),
    ]);
    const meterRows = (meters?.results ?? []) as { day: string; counter: string; count: number }[];
    const meter = (d: string, counter: string) =>
      meterRows.find((m) => m.day === d && m.counter === counter)?.count ?? 0;
    const first = <T>(r: D1Result | undefined) => (r?.results?.[0] ?? {}) as T;
    const u = first<{ total?: number; pending?: number }>(users);
    const p = first<{ active?: number; archived?: number }>(projects);
    await audit(c, "overview.read", null);
    return respond(c, apiData(AdminOverview), {
      data: {
        month,
        spendUsd: microToUsd(meter(month, "anthropic-usd-micro")),
        capUsd: anthropicMonthlyBudgetUsd(c.env.ANTHROPIC_MONTHLY_BUDGET_USD),
        sandbox: {
          usedSeconds: meter(month, "sandbox-seconds"),
          capSeconds: sandboxMonthlySeconds(c.env.SANDBOX_MONTHLY_SECONDS),
        },
        browser: {
          usedSecondsToday: meter(day, "browser-seconds"),
          capSecondsPerDay: browserDailySeconds(c.env.BROWSER_DAILY_SECONDS),
        },
        appVersions: { used: meter(day, "app-builds"), cap: APP_BUILDS_PER_DAY },
        users: { total: u.total ?? 0, pending: u.pending ?? 0 },
        projects: { active: p.active ?? 0, archived: p.archived ?? 0 },
        changes: { active: first<{ active?: number }>(changes).active ?? 0 },
        agents: { active: first<{ active?: number }>(agents).active ?? 0 },
      },
    });
  })

  .get("/v1/admin/users", validate("query", UsersQuery), async (c) => {
    const { q, status, cursor } = c.req.valid("query");
    const where: string[] = [];
    const params: unknown[] = [monthOf(new Date())];
    if (status) {
      params.push(status);
      where.push(`u.access_status = ?${params.length}`);
    }
    if (q) {
      params.push(likePattern(q), q);
      where.push(
        `(u.email LIKE ?${params.length - 1} ESCAPE '\\' OR u.display_name LIKE ?${params.length - 1} ESCAPE '\\' OR u.id = ?${params.length})`,
      );
    }
    const after = decodeCursor(cursor);
    if (after) {
      params.push(after.createdAt, after.id);
      where.push(
        `(u.created_at < ?${params.length - 1} OR (u.created_at = ?${params.length - 1} AND u.id < ?${params.length}))`,
      );
    }
    const rows = await c.env.DB.prepare(
      `SELECT ${USER_COLUMNS} FROM users u
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY u.created_at DESC, u.id DESC LIMIT ${PAGE + 1}`,
    )
      .bind(...params)
      .all<UserRow>();
    const list = rows.results ?? [];
    const page = list.slice(0, PAGE);
    const last = page[page.length - 1];
    await audit(c, "users.list", queryTarget(c));
    return respond(c, apiData(AdminUserList), {
      data: {
        users: page.map((r) => userView(r, isPlatformAdmin(c.env, r.id))),
        nextCursor: list.length > PAGE && last ? encodeCursor(last.created_at, last.id) : null,
      },
    });
  })

  .get("/v1/admin/users/:userId", validate("param", UserParam), async (c) => {
    const { userId } = c.req.valid("param");
    const db = c.env.DB;
    const now = new Date();
    const month = monthOf(now);
    const [userRows, projectRows, changeRows] = await db.batch([
      db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?2`).bind(month, userId),
      db
        .prepare(
          `SELECT p.id, p.name,
             CASE WHEN EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = p.org_id AND m.user_id = ?1)
               THEN 'owner'
               ELSE (SELECT pm.role FROM project_members pm
                     WHERE pm.project_id = p.id AND pm.user_id = ?1) END AS role,
             (SELECT COALESCE(SUM(${changeMeterSql("c")}), 0) FROM changes c
               WHERE c.project_id = p.id AND c.created_by = ?1) AS micro
           FROM projects p
           WHERE p.id IN (
             SELECT p2.id FROM memberships m JOIN projects p2 ON p2.org_id = m.org_id
               WHERE m.user_id = ?1
             UNION SELECT project_id FROM project_members WHERE user_id = ?1)
           ORDER BY p.created_at DESC LIMIT ${DETAIL_PROJECTS}`,
        )
        .bind(userId),
      db
        .prepare(
          `SELECT c.id, c.project_id, p.name AS project_name, c.title, c.goal, c.status,
                  c.created_at, ${changeMeterSql("c")} AS micro
           FROM changes c LEFT JOIN projects p ON p.id = c.project_id
           WHERE c.created_by = ? ORDER BY c.created_at DESC LIMIT ${DETAIL_CHANGES}`,
        )
        .bind(userId),
    ]);
    const user = (userRows?.results?.[0] as UserRow | undefined) ?? null;
    if (!user) {
      await audit(c, "users.read", userId);
      return fail(c, 404, "not_found", "User not found");
    }
    const monthly = await monthlyMeter(
      db,
      METER_COUNTER.user(userId),
      monthList(now, DETAIL_MONTHS),
    );
    await audit(c, "users.read", userId);
    const { projects: _count, ...base } = userView(user, isPlatformAdmin(c.env, userId));
    return respond(c, apiData(AdminUserDetail), {
      data: {
        ...base,
        projects: (
          (projectRows?.results ?? []) as {
            id: string;
            name: string;
            role: string | null;
            micro: number | null;
          }[]
        ).map((p) => ({
          projectId: p.id,
          name: p.name,
          role: p.role ?? "none",
          spendUsd: microToUsd(p.micro),
        })),
        recentChanges: (
          (changeRows?.results ?? []) as {
            id: string;
            project_id: string;
            project_name: string | null;
            title: string | null;
            goal: string;
            status: string;
            created_at: string;
            micro: number | null;
          }[]
        ).map((r) => ({
          changeId: r.id,
          projectId: r.project_id,
          projectName: r.project_name ?? r.project_id,
          title: changeTitle(r.title, r.goal),
          status: r.status,
          spendUsd: microToUsd(r.micro),
          createdAt: r.created_at,
        })),
        monthly,
      },
    });
  })

  .get("/v1/admin/projects", validate("query", ProjectsQuery), async (c) => {
    const { q, ownerId, status, cursor } = c.req.valid("query");
    const db = c.env.DB;
    const where: string[] = [];
    const params: unknown[] = [monthOf(new Date())];
    if (status) {
      params.push(status);
      where.push(`p.status = ?${params.length}`);
    }
    if (ownerId) {
      params.push(ownerId);
      const n = params.length;
      where.push(`p.id IN (
        SELECT project_id FROM project_members WHERE user_id = ?${n} AND role = 'owner'
        UNION SELECT p2.id FROM memberships m JOIN projects p2 ON p2.org_id = m.org_id
          WHERE m.user_id = ?${n} AND m.role = 'owner')`);
    }
    if (q) {
      params.push(likePattern(q), q);
      where.push(
        `(p.name LIKE ?${params.length - 1} ESCAPE '\\' OR p.slug LIKE ?${params.length - 1} ESCAPE '\\' OR p.id = ?${params.length})`,
      );
    }
    const after = decodeCursor(cursor);
    if (after) {
      params.push(after.createdAt, after.id);
      where.push(
        `(p.created_at < ?${params.length - 1} OR (p.created_at = ?${params.length - 1} AND p.id < ?${params.length}))`,
      );
    }
    const rows = await db
      .prepare(
        `SELECT p.id, p.name, p.slug, p.status, p.canonical_generation, p.created_at, p.updated_at,
           COALESCE(
             (SELECT pm.user_id FROM project_members pm WHERE pm.project_id = p.id AND pm.role = 'owner'),
             (SELECT m.user_id FROM memberships m WHERE m.org_id = p.org_id AND m.role = 'owner'
               ORDER BY m.created_at LIMIT 1)) AS owner_id,
           (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id) AS members,
           (SELECT count FROM usage_counters WHERE day = ?1 AND counter = 'project-usd-micro:' || p.id)
             AS month_micro,
           (SELECT COALESCE(SUM(${changeMeterSql("c")}), 0) FROM changes c WHERE c.project_id = p.id)
             AS all_micro,
           (SELECT COUNT(*) FROM changes c WHERE c.project_id = p.id) AS changes,
           (SELECT a.slug FROM app_deployments a WHERE a.project_id = p.id
              AND a.channel = '${APP_PRODUCTION_CHANNEL}' AND a.status = 'ready') AS app_slug
         FROM projects p
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY p.created_at DESC, p.id DESC LIMIT ${PAGE + 1}`,
      )
      .bind(...params)
      .all<{
        id: string;
        name: string;
        slug: string;
        status: string;
        canonical_generation: number;
        created_at: string;
        updated_at: string;
        owner_id: string | null;
        members: number;
        month_micro: number | null;
        all_micro: number | null;
        changes: number;
        app_slug: string | null;
      }>();
    const list = rows.results ?? [];
    const page = list.slice(0, PAGE);
    const ownerIds = [...new Set(page.map((r) => r.owner_id).filter((id): id is string => !!id))];
    const owners = new Map<string, string | null>();
    if (ownerIds.length > 0) {
      const ownerRows = await db
        .prepare(
          `SELECT id, display_name, email FROM users
           WHERE id IN (${ownerIds.map(() => "?").join(", ")})`,
        )
        .bind(...ownerIds)
        .all<{ id: string; display_name: string | null; email: string | null }>();
      for (const o of ownerRows.results ?? []) {
        owners.set(o.id, requesterName(o.display_name, o.email));
      }
    }
    const domain = c.env.APPS_DOMAIN;
    const last = page[page.length - 1];
    await audit(c, "projects.list", queryTarget(c));
    return respond(c, apiData(AdminProjectList), {
      data: {
        projects: page.map(
          (r): AdminProject => ({
            projectId: r.id,
            name: r.name,
            slug: r.slug,
            status: r.status,
            owner: r.owner_id ? { userId: r.owner_id, name: owners.get(r.owner_id) ?? null } : null,
            members: r.members,
            generation: r.canonical_generation,
            spendMonthUsd: microToUsd(r.month_micro),
            spendAllTimeUsd: microToUsd(r.all_micro),
            changes: r.changes,
            liveAppUrl: domain && r.app_slug ? appUrl(domain, r.app_slug) : null,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          }),
        ),
        nextCursor: list.length > PAGE && last ? encodeCursor(last.created_at, last.id) : null,
      },
    });
  })

  .get("/v1/admin/costs", validate("query", CostsQuery), async (c) => {
    const query = c.req.valid("query");
    const today = isoDay(new Date());
    const to = query.to ?? today;
    const from = query.from ?? addDays(to, -(DEFAULT_RANGE_DAYS - 1));
    if (from > to) return fail(c, 400, "invalid_request", "`from` must not be after `to`");
    if (addDays(from, MAX_RANGE_DAYS - 1) < to) {
      return fail(c, 400, "invalid_request", `The range is at most ${MAX_RANGE_DAYS} days`);
    }
    const db = c.env.DB;
    const group = COST_GROUP[query.groupBy];
    const params: unknown[] = [`${from}T00:00:00.000Z`, `${addDays(to, 1)}T00:00:00.000Z`];
    const filters: string[] = [];
    if (query.userId) {
      params.push(query.userId);
      filters.push(`c.created_by = ?${params.length}`);
    }
    if (query.projectId) {
      params.push(query.projectId);
      filters.push(`c.project_id = ?${params.length}`);
    }
    // Starts from idx_task_runs_started: rows read scale with the attempts in the range.
    const rowsQuery = db
      .prepare(
        `SELECT ${group.key} AS key, ${group.label} AS label,
                COALESCE(SUM(r.cost_usd), 0) AS spend, COALESCE(SUM(r.model_calls), 0) AS calls,
                COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
                COALESCE(SUM(r.output_tokens), 0) AS output_tokens
         FROM task_runs r
         CROSS JOIN tasks t ON t.id = r.task_id
         CROSS JOIN changes c ON c.id = t.change_id
         LEFT JOIN projects p ON p.id = c.project_id
         LEFT JOIN users u ON u.id = c.created_by
         WHERE r.started_at >= ?1 AND r.started_at < ?2
           ${filters.map((f) => `AND ${f}`).join(" ")}
         GROUP BY ${group.key}
         ORDER BY ${query.groupBy === "day" ? "key ASC" : "spend DESC"}
         LIMIT ${COST_ROW_LIMIT}`,
      )
      .bind(...params);

    // The meter that covers every model call of the same scope, for the `source` note.
    const meter =
      query.userId && !query.projectId
        ? { counter: METER_COUNTER.user(query.userId), name: `user meter ${query.userId}` }
        : query.projectId && !query.userId
          ? {
              counter: METER_COUNTER.project(query.projectId),
              name: `Project meter ${query.projectId}`,
            }
          : !query.userId && !query.projectId
            ? { counter: "anthropic-usd-micro", name: "environment meter anthropic-usd-micro" }
            : null;
    const months = monthsBetween(from, to);
    const [rows, meterMonths] = await Promise.all([
      rowsQuery.all<{
        key: string | null;
        label: string | null;
        spend: number;
        calls: number;
        input_tokens: number;
        output_tokens: number;
      }>(),
      meter ? monthlyMeter(db, meter.counter, months) : Promise.resolve(null),
    ]);
    const result = (rows.results ?? []).map((r) => ({
      key: r.key ?? "unknown",
      label: r.label ?? r.key ?? "unknown",
      spendUsd: Math.max(0, r.spend),
      calls: r.calls,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
    }));
    const totalUsd = result.reduce((sum, r) => sum + r.spendUsd, 0);
    const meterUsd = meterMonths?.reduce((sum, m) => sum + m.spendUsd, 0) ?? null;
    const source = [
      `task_runs: one row per agent Task attempt (model calls, tokens, cost), by attempt start, ${from} to ${to} UTC.`,
      "Grouped by model, the key is the model tier of the attempt.",
      "The Root Planner, the intake check, conflict reviews, the acceptance check, and the Integration Judge write no per-call row, so these rows do not include them.",
      meter && meterUsd !== null
        ? `The ${meter.name} for ${months[0]} to ${months[months.length - 1]} (whole months, every model call, open reservations included) is $${meterUsd.toFixed(2)}.`
        : "No single meter covers a user and Project filter together.",
    ].join(" ");
    await audit(c, "costs.read", queryTarget(c));
    if (query.format === "csv") {
      const lines = [
        "key,label,spendUsd,calls,inputTokens,outputTokens",
        ...result.map((r) =>
          [r.key, r.label, r.spendUsd.toFixed(6), r.calls, r.inputTokens, r.outputTokens]
            .map(csvCell)
            .join(","),
        ),
      ];
      return c.body(`${lines.join("\n")}\n`, 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="rhumbatron-costs-${query.groupBy}-${from}-${to}.csv"`,
        "cache-control": "no-store",
      });
    }
    return respond(c, apiData(AdminCosts), { data: { rows: result, totalUsd, source } });
  })

  .get("/v1/admin/events", validate("query", EventsQuery), async (c) => {
    const query = c.req.valid("query");
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `?${params.length}`));
    };
    // Each filter has an index on (column, seq): project_id, actor_id, event_type.
    if (query.projectId) add("e.project_id = ?", query.projectId);
    if (query.userId) add("e.actor_id = ?", query.userId);
    if (query.type) add("e.event_type = ?", query.type);
    if (query.from) add("e.occurred_at >= ?", query.from);
    if (query.to) add("e.occurred_at <= ?", query.to);
    if (query.cursor) add("e.seq < ?", Number(query.cursor));
    const rows = await c.env.DB.prepare(
      `SELECT e.seq, e.project_id, p.name AS project_name, e.change_id, e.event_type, e.actor_kind,
              e.actor_id, u.display_name, u.email, e.occurred_at, e.summary
       FROM project_events e
       LEFT JOIN projects p ON p.id = e.project_id
       LEFT JOIN users u ON e.actor_kind = 'user' AND u.id = e.actor_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY e.seq DESC LIMIT ${PAGE + 1}`,
    )
      .bind(...params)
      .all<{
        seq: number;
        project_id: string;
        project_name: string | null;
        change_id: string | null;
        event_type: string;
        actor_kind: string;
        actor_id: string;
        display_name: string | null;
        email: string | null;
        occurred_at: string;
        summary: string;
      }>();
    const list = rows.results ?? [];
    const page = list.slice(0, PAGE);
    const last = page[page.length - 1];
    await audit(c, "events.list", queryTarget(c));
    return respond(c, apiData(AdminEventList), {
      data: {
        events: page.map((e) => ({
          seq: e.seq,
          projectId: e.project_id,
          projectName: e.project_name,
          changeId: e.change_id,
          eventType: e.event_type,
          actorKind: e.actor_kind,
          actorId: e.actor_id,
          actorName: e.actor_kind === "user" ? requesterName(e.display_name, e.email) : null,
          occurredAt: e.occurred_at,
          summary: e.summary,
        })),
        nextCursor: list.length > PAGE && last ? String(last.seq) : null,
      },
    });
  })

  .get("/v1/admin/settings", async (c) => {
    const settings = await readSettings(c.env.DB);
    await audit(c, "settings.read", null);
    return respond(c, apiData(PlatformSettings), { data: settings });
  })

  .patch("/v1/admin/settings", validate("json", UpdatePlatformSettingsRequest), async (c) => {
    const { signupApprovalRequired } = c.req.valid("json");
    const db = c.env.DB;
    const now = new Date();
    const adminUserId = c.get("adminUserId");
    // Turning the switch off approves nobody: each pending person waits for a decision.
    await db.batch([
      db
        .prepare(
          `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        )
        .bind(SIGNUP_APPROVAL_KEY, String(signupApprovalRequired), now.toISOString(), adminUserId),
      ...auditStatements(db, {
        adminUserId,
        action: "settings.update",
        target: `signupApprovalRequired=${signupApprovalRequired}`,
        now,
      }),
    ]);
    return respond(c, apiData(PlatformSettings), { data: await readSettings(db) });
  })

  .get("/v1/admin/access-requests", async (c) => {
    // idx_users_access_created: the pending rows only.
    const rows = await c.env.DB.prepare(
      `SELECT id, display_name, email, created_at FROM users
       WHERE access_status = 'pending' ORDER BY created_at DESC LIMIT ${ACCESS_REQUEST_LIMIT}`,
    ).all<{ id: string; display_name: string | null; email: string | null; created_at: string }>();
    await audit(c, "access_requests.list", null);
    return respond(c, apiData(AccessRequestList), {
      data: {
        users: (rows.results ?? []).map((r) => ({
          userId: r.id,
          name: requesterName(r.display_name, r.email),
          email: r.email,
          requestedAt: r.created_at,
        })),
      },
    });
  })

  .post(
    "/v1/admin/users/:userId/access",
    validate("param", UserParam),
    validate("json", AccessDecisionRequest),
    async (c) => {
      const { userId } = c.req.valid("param");
      const { decision } = c.req.valid("json");
      const db = c.env.DB;
      const now = new Date();
      const adminUserId = c.get("adminUserId");
      const target = await db
        .prepare("SELECT access_status FROM users WHERE id = ?")
        .bind(userId)
        .first<{ access_status: string }>();
      if (!target) {
        await audit(c, "access.decide", `${userId}:${decision}:not_found`);
        return fail(c, 404, "not_found", "User not found");
      }
      if (isPlatformAdmin(c.env, userId) && decision === "decline") {
        await audit(c, "access.decide", `${userId}:${decision}:refused`);
        return fail(c, 409, "conflict", "A platform admin is always approved");
      }
      const next: AccessStatus = decision === "approve" ? "approved" : "declined";
      const audits = auditStatements(db, {
        adminUserId,
        action: "access.decide",
        target: `${userId}:${decision}`,
        now,
      });
      // The same decision again writes only the audit row.
      await db.batch(
        target.access_status === next
          ? audits
          : [
              db
                .prepare(
                  `UPDATE users SET access_status = ?, access_decided_by = ?, access_decided_at = ?,
                     updated_at = ? WHERE id = ?`,
                )
                .bind(next, adminUserId, now.toISOString(), now.toISOString(), userId),
              ...audits,
            ],
      );
      return respond(c, apiData(AccessDecisionResult), {
        data: { userId, accessStatus: next },
      });
    },
  )

  .post("/v1/admin/access-requests/approve-all", async (c) => {
    const db = c.env.DB;
    const now = new Date();
    const adminUserId = c.get("adminUserId");
    const [update] = await db.batch([
      db
        .prepare(
          `UPDATE users SET access_status = 'approved', access_decided_by = ?,
             access_decided_at = ?, updated_at = ? WHERE access_status = 'pending'`,
        )
        .bind(adminUserId, now.toISOString(), now.toISOString()),
      ...auditStatements(db, { adminUserId, action: "access.approve_all", target: null, now }),
    ]);
    return respond(c, apiData(ApproveAllResult), {
      data: { approved: update?.meta?.changes ?? 0 },
    });
  });

async function readSettings(db: D1Database): Promise<PlatformSettings> {
  const row = await db
    .prepare("SELECT value, updated_at, updated_by FROM platform_settings WHERE key = ?")
    .bind(SIGNUP_APPROVAL_KEY)
    .first<{ value: string; updated_at: string; updated_by: string | null }>();
  return {
    signupApprovalRequired: row?.value === "true",
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}
