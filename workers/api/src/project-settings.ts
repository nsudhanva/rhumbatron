import { can, deniedMessage, MonthlyBudgetUsd } from "@rhumbatron/protocol";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { budgetRaised, projectMonthSpendUsd, resumeAfterRaise } from "./budgets.ts";
import { fail, validate } from "./http.ts";
import { ensureIdentity, projectRole } from "./identity.ts";

/**
 * Project settings: the Project name, the default budget of new Changes, and member request review.
 *
 * - `GET /v1/projects/:projectId/settings`: any role.
 * - `PATCH /v1/projects/:projectId`: owner or admin (`settings.edit`). Body
 *   `{ name?, defaultBudgetUsd?, memberRequestReview? }`. `defaultBudgetUsd: null` returns the
 *   Project to the built-in default. `memberRequestReview: true` (the default) makes a member's
 *   request start as `proposed` (ADR 0028). `monthlyBudgetUsd` ($1 to $100, or null) is the
 *   Project monthly budget (ADR 0030); a raise resumes the Changes it stopped.
 * - The read adds `monthSpendUsd`: this month's model spend of the Project (read only).
 *
 * Cost: a read is 2 D1 queries (role, row). An update adds 1 write.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

/** Budget of a Change created without one, when the Project has no default. */
const BUILT_IN_CHANGE_BUDGET_USD = 3;
const MIN_DEFAULT_BUDGET_USD = 0.5;
const MAX_DEFAULT_BUDGET_USD = 25;

const ProjectIdParam = z.object({ projectId: z.string().regex(/^proj_[a-z0-9-]+$/) });

const UpdateProjectSettings = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    defaultBudgetUsd: z
      .number()
      .min(MIN_DEFAULT_BUDGET_USD)
      .max(MAX_DEFAULT_BUDGET_USD)
      .nullable()
      .optional(),
    memberRequestReview: z.boolean().optional(),
    monthlyBudgetUsd: MonthlyBudgetUsd.optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.defaultBudgetUsd !== undefined ||
      body.memberRequestReview !== undefined ||
      body.monthlyBudgetUsd !== undefined,
    { message: "Send name, defaultBudgetUsd, memberRequestReview, or monthlyBudgetUsd" },
  );

type SettingsRow = {
  name: string;
  slug: string;
  status: string;
  created_at: string;
  default_budget_usd: number | null;
  member_request_review: number;
  monthly_budget_usd: number | null;
};

async function readSettings(db: D1Database, projectId: string) {
  return db
    .prepare(`SELECT name, slug, status, created_at, default_budget_usd, member_request_review,
         monthly_budget_usd
       FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<SettingsRow>();
}

function toSettings(row: SettingsRow, role: string, monthSpendUsd: number) {
  return {
    name: row.name,
    slug: row.slug,
    createdAt: row.created_at,
    role,
    defaultBudgetUsd: row.default_budget_usd,
    /** The budget a Change gets when its request has none. */
    effectiveDefaultBudgetUsd: row.default_budget_usd ?? BUILT_IN_CHANGE_BUDGET_USD,
    limits: { minBudgetUsd: MIN_DEFAULT_BUDGET_USD, maxBudgetUsd: MAX_DEFAULT_BUDGET_USD },
    /** True: a member's request starts as `proposed` and waits for an owner or admin. */
    memberRequestReview: row.member_request_review !== 0,
    /** Project monthly budget in USD (ADR 0030); null: no own cap. */
    monthlyBudgetUsd: row.monthly_budget_usd,
    /** This calendar month's model spend of the Project. */
    monthSpendUsd,
  };
}

/**
 * Budget for a new Change: the budget in the request body when the body has one, else the
 * Project default, else `parsed` (the schema default). Reads the parsed body from Hono's cache.
 */
export async function changeBudgetUsd(
  c: Context<AppEnv>,
  projectId: string,
  parsed: number,
): Promise<number> {
  const raw = (await c.req.json().catch(() => null)) as { budgetUsd?: unknown } | null;
  if (typeof raw?.budgetUsd === "number") return parsed;
  const row = await c.env.DB.prepare("SELECT default_budget_usd FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{ default_budget_usd: number | null }>();
  return row?.default_budget_usd ?? parsed;
}

export const projectSettings = new Hono<AppEnv>()
  .get(
    "/v1/projects/:projectId/settings",
    requireAuth,
    validate("param", ProjectIdParam),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { projectId } = c.req.valid("param");
      const role = await projectRole(c.env.DB, userId, projectId);
      if (!role) return fail(c, 404, "not_found", "Project not found");
      const row = await readSettings(c.env.DB, projectId);
      if (!row) return fail(c, 404, "not_found", "Project not found");
      return c.json({
        data: toSettings(row, role, await projectMonthSpendUsd(c.env.DB, projectId)),
      });
    },
  )

  .patch(
    "/v1/projects/:projectId",
    requireAuth,
    validate("param", ProjectIdParam),
    validate("json", UpdateProjectSettings),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { projectId } = c.req.valid("param");
      const body = c.req.valid("json");
      const role = await projectRole(c.env.DB, userId, projectId);
      if (!role) return fail(c, 404, "not_found", "Project not found");
      if (!can(role, "settings.edit")) {
        return fail(c, 403, "forbidden", deniedMessage("settings.edit", "change project settings"));
      }
      const row = await readSettings(c.env.DB, projectId);
      if (!row) return fail(c, 404, "not_found", "Project not found");
      if (row.status !== "active") return fail(c, 409, "conflict", "Project is archived");

      const name = body.name ?? row.name;
      const budget =
        body.defaultBudgetUsd === undefined ? row.default_budget_usd : body.defaultBudgetUsd;
      const review =
        body.memberRequestReview === undefined
          ? row.member_request_review
          : body.memberRequestReview
            ? 1
            : 0;
      const monthly =
        body.monthlyBudgetUsd === undefined ? row.monthly_budget_usd : body.monthlyBudgetUsd;
      const now = new Date().toISOString();
      // Same values again: a safe repeat, no write.
      if (
        name !== row.name ||
        budget !== row.default_budget_usd ||
        review !== row.member_request_review ||
        monthly !== row.monthly_budget_usd
      ) {
        await c.env.DB.prepare(
          `UPDATE projects SET name = ?, default_budget_usd = ?, member_request_review = ?,
             monthly_budget_usd = ?, updated_at = ?
           WHERE id = ? AND status = 'active'`,
        )
          .bind(name, budget, review, monthly, now, projectId)
          .run();
        // A raised Project budget resumes the Changes it stopped (ADR 0030).
        if (budgetRaised(row.monthly_budget_usd, monthly)) {
          await resumeAfterRaise(c.env, {
            limit: "project_budget",
            projectId,
            actorUserId: userId,
          });
        }
      }
      return c.json({
        data: toSettings(
          {
            ...row,
            name,
            default_budget_usd: budget,
            member_request_review: review,
            monthly_budget_usd: monthly,
          },
          role,
          await projectMonthSpendUsd(c.env.DB, projectId),
        ),
      });
    },
  );
