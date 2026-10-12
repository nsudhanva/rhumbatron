import {
  apiData,
  type BudgetScope,
  budgetBlockedBy,
  CHANGE_METER_DAY,
  type ChangeBudget,
  METER_COUNTER,
  Me,
  POOL_SCOPE_CHANGE_CEILING_USD,
  UpdateMyBudgetRequest,
} from "@rhumbatron/protocol";
import { type Context, Hono } from "hono";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { errorBody, respond, validate } from "./http.ts";
import { ensureIdentity } from "./identity.ts";
import { ensureProfile, requesterName } from "./members.ts";

/**
 * Budget scopes (ADR 0030, docs/operations/costs.md):
 *
 * - `GET /v1/me`: the caller's monthly budget and this month's model spend across Projects.
 * - `PATCH /v1/me/budget`: body `{ monthlyBudgetUsd: number | null }` ($1 to $100). A raise
 *   resumes the caller's Changes that their budget stopped.
 * - Helpers for Change creation (`resolveBudgetScope`), the Change read (`changeBudget`), the
 *   Project settings, and the cost read (`meterSpendUsd`).
 *
 * The spend figures read the `usage_counters` meters that model calls reserve and settle
 * (packages/model-router/src/budget-meters.ts); an open reservation counts until it settles.
 * Cost: `GET /v1/me` is 2 D1 reads; the PATCH adds 1 write and, on a raise, one RPC.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

type BudgetRpc = {
  resumeBudgetBlocked(
    input:
      | { limit: "project_budget"; projectId: string; actorUserId: string }
      | { limit: "account_budget"; userId: string; actorUserId: string },
  ): Promise<{ resumedChangeIds: string[] }>;
};

/** This calendar month, `YYYY-MM` (UTC), the `day` of the monthly meters. */
const currentMonth = (now = new Date()) => now.toISOString().slice(0, 7);

/** Spend on one meter in USD. */
async function meterSpendUsd(db: D1Database, day: string, counter: string) {
  const row = await db
    .prepare("SELECT count FROM usage_counters WHERE day = ? AND counter = ?")
    .bind(day, counter)
    .first<{ count: number }>();
  return (row?.count ?? 0) / 1_000_000;
}

/** This month's spend of a Project. */
export const projectMonthSpendUsd = (db: D1Database, projectId: string) =>
  meterSpendUsd(db, currentMonth(), METER_COUNTER.project(projectId));

/**
 * Resumes the Changes that a raised Project or user budget stopped. Logs and continues on an RPC
 * failure: the budget is saved, and the next raise resumes them.
 */
export async function resumeAfterRaise(
  env: Env,
  input: Parameters<BudgetRpc["resumeBudgetBlocked"]>[0],
) {
  try {
    await (env.INTEGRATION as unknown as BudgetRpc).resumeBudgetBlocked(input);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "budget.resume_failed",
        limit: input.limit,
        message: String(error).slice(0, 200),
      }),
    );
  }
}

/** True when `next` leaves more room than `previous` (null is no cap). */
export const budgetRaised = (previous: number | null, next: number | null) =>
  previous !== null && (next === null || next > previous);

/**
 * The scope and `budget_usd` of a new Change. Scope `project` needs a Project monthly budget,
 * scope `account` a monthly budget of the requester: otherwise 400 with reason `no_budget_set`.
 * A pool scope stores `POOL_SCOPE_CHANGE_CEILING_USD` as `budget_usd`; the pool caps it.
 */
export async function resolveBudgetScope(
  c: Context<AppEnv>,
  input: { projectId: string; userId: string; scope: BudgetScope; budgetUsd: number },
): Promise<
  { ok: true; scope: BudgetScope; budgetUsd: number } | { ok: false; response: Response }
> {
  if (input.scope === "change") return { ok: true, scope: "change", budgetUsd: input.budgetUsd };
  const row = await c.env.DB.prepare(
    `SELECT (SELECT monthly_budget_usd FROM projects WHERE id = ?) AS project_cap,
            (SELECT monthly_budget_usd FROM users WHERE id = ?) AS user_cap`,
  )
    .bind(input.projectId, input.userId)
    .first<{ project_cap: number | null; user_cap: number | null }>();
  const cap = input.scope === "project" ? row?.project_cap : row?.user_cap;
  if (cap === null || cap === undefined) {
    const message =
      input.scope === "project"
        ? "This Project has no monthly budget. An owner or admin can set one in Settings."
        : "You have no monthly budget. Set one on your Account page.";
    return {
      ok: false,
      response: c.json(
        errorBody("invalid_request", message, { reason: "no_budget_set", scope: input.scope }),
        400,
      ),
    };
  }
  return { ok: true, scope: input.scope, budgetUsd: POOL_SCOPE_CHANGE_CEILING_USD };
}

/** Columns the Change read adds for `changeBudget`; the Change row is alias `c`. */
export const CHANGE_BUDGET_COLUMNS = `c.budget_scope, c.blocked_limit,
  (SELECT COALESCE(SUM(r.cost_usd), 0) FROM task_runs r JOIN tasks t ON t.id = r.task_id
    WHERE t.change_id = c.id)
  + (SELECT COALESCE(SUM(
      COALESCE(json_extract(review_json, '$.reviews.sonnet.costUsd'), 0) +
      COALESCE(json_extract(review_json, '$.reviews.opus.costUsd'), 0)), 0)
    FROM conflicts WHERE change_id = c.id)
  + (SELECT COALESCE(SUM(json_extract(e.metrics_json, '$.costUsd')), 0)
    FROM evidence_index e JOIN candidates k ON k.id = e.candidate_id
    WHERE k.change_id = c.id AND e.kind = 'acceptance')
  + (SELECT COALESCE(SUM(json_extract(selection_json, '$.judgeCostUsd')), 0)
    FROM candidates WHERE change_id = c.id) AS recorded_spend_usd,
  (SELECT count FROM usage_counters WHERE day = '${CHANGE_METER_DAY}'
    AND counter = 'change-usd-micro:' || c.id) AS change_meter_micro`;

export type ChangeBudgetColumns = {
  budget_scope: string | null;
  blocked_limit: string | null;
  budget_usd: number;
  recorded_spend_usd: number | null;
  change_meter_micro: number | null;
};

/**
 * `budget` of the Change read. `spentUsd` is the larger of the recorded spend (runs, reviews,
 * acceptance, judge) and the Change meter, which also counts the planner and intake.
 */
export function changeBudget(row: ChangeBudgetColumns): ChangeBudget {
  const scope: BudgetScope =
    row.budget_scope === "project" || row.budget_scope === "account" ? row.budget_scope : "change";
  return {
    scope,
    capUsd: scope === "change" ? row.budget_usd : null,
    spentUsd: Math.max(row.recorded_spend_usd ?? 0, (row.change_meter_micro ?? 0) / 1_000_000),
    blockedBy: budgetBlockedBy(row.blocked_limit),
  };
}

async function readMe(env: Env, userId: string): Promise<Me> {
  const month = currentMonth();
  const [user, spend] = await env.DB.batch([
    env.DB.prepare("SELECT display_name, email, monthly_budget_usd FROM users WHERE id = ?").bind(
      userId,
    ),
    env.DB.prepare("SELECT count FROM usage_counters WHERE day = ? AND counter = ?").bind(
      month,
      METER_COUNTER.user(userId),
    ),
  ]);
  const row = user?.results?.[0] as
    | { display_name: string | null; email: string | null; monthly_budget_usd: number | null }
    | undefined;
  const count = (spend?.results?.[0] as { count: number } | undefined)?.count ?? 0;
  return {
    userId,
    name: row ? requesterName(row.display_name, row.email) : null,
    email: row?.email ?? null,
    monthlyBudgetUsd: row?.monthly_budget_usd ?? null,
    monthSpendUsd: count / 1_000_000,
    month,
  };
}

export const budgets = new Hono<AppEnv>()
  .get("/v1/me", requireAuth, async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const profile = ensureProfile(c.env, userId, c.get("authSubject"));
    try {
      c.executionCtx.waitUntil(profile);
    } catch {
      await profile; // No ExecutionContext (tests): finish inline.
    }
    return respond(c, apiData(Me), { data: await readMe(c.env, userId) });
  })

  .patch("/v1/me/budget", requireAuth, validate("json", UpdateMyBudgetRequest), async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { monthlyBudgetUsd } = c.req.valid("json");
    const before = await c.env.DB.prepare("SELECT monthly_budget_usd FROM users WHERE id = ?")
      .bind(userId)
      .first<{ monthly_budget_usd: number | null }>();
    const previous = before?.monthly_budget_usd ?? null;
    if (previous !== monthlyBudgetUsd) {
      await c.env.DB.prepare("UPDATE users SET monthly_budget_usd = ?, updated_at = ? WHERE id = ?")
        .bind(monthlyBudgetUsd, new Date().toISOString(), userId)
        .run();
      if (budgetRaised(previous, monthlyBudgetUsd)) {
        await resumeAfterRaise(c.env, { limit: "account_budget", userId, actorUserId: userId });
      }
    }
    return respond(c, apiData(Me), { data: await readMe(c.env, userId) });
  });
