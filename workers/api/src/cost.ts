import { apiData } from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

/**
 * Cost read model of one Project (AGENTS.md sections 16.1, 24, 44, 56). Every figure comes from
 * recorded rows: `task_runs` (calls, tokens, cost per attempt), `decision_receipts` (routes),
 * `changes.budget_usd`, and the account-wide `usage_counters` meters. Nothing is estimated from
 * constants. Reads are bounded: the newest 20 Changes, one selected Change, and 16 days of meters.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

/**
 * Mirrors packages/model-router/src/budget.ts (AGENT_DAILY_CALL_CAP, OPENROUTER_DAILY_CALL_CAP,
 * MAX_CALLS_PER_RUN) and the `usage_counters` keys in provider.ts (ADR 0016).
 */
const AGENT_DAILY_CALL_CAP = 400;
const OPENROUTER_DAILY_CALL_CAP = 45;
const MAX_CALLS_PER_RUN = { haiku: 8, sonnet: 16, opus: 16 } as const;
/** Mirrors CLEF_DAILY_CAP in workers/event-router/src/causal.ts. */
const CLEF_DAILY_CAP = 200;
/** Mirrors MONTHLY_SECONDS in workers/agents/src/workspace.ts and integration candidate-sandbox.ts. */
const SANDBOX_MONTHLY_SECONDS = 36_000;

const CHANGE_LIMIT = 20;
const TASK_LIMIT = 200;
const RUN_LIMIT = 500;
const METER_DAYS = 16;

const TIERS = ["haiku", "sonnet", "opus"] as const;
type Tier = (typeof TIERS)[number];
const TIER_RANK: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2 };
const isTier = (t: string): t is Tier => (TIERS as readonly string[]).includes(t);

const ProjectIdParam = z.object({ projectId: z.string().regex(/^proj_[a-z0-9-]+$/) });
const CostQuery = z.object({
  changeId: z
    .string()
    .regex(/^chg_[a-z0-9-]+$/)
    .optional(),
});

const Usage = z.object({
  runs: z.number().int(),
  modelCalls: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number(),
});
type Usage = z.infer<typeof Usage>;

const ChangeCost = Usage.extend({
  id: z.string(),
  goal: z.string(),
  status: z.string(),
  budgetUsd: z.number(),
  createdAt: z.string(),
});

const TaskCost = Usage.extend({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  kind: z.string(),
  status: z.string(),
  /** Tiers of the attempts in order, for example `["haiku", "sonnet"]`. */
  tiers: z.array(z.enum(TIERS)),
  /** Highest model calls in one attempt. */
  maxCallsInRun: z.number().int(),
});

const TierCost = Usage.extend({
  tier: z.enum(TIERS),
  callCapPerRun: z.number().int(),
  maxCallsInRun: z.number().int(),
});

const CostView = z.object({
  generatedAt: z.string(),
  changes: z.array(ChangeCost),
  /** The Change the detail below belongs to. Null when the Project has no Changes. */
  selected: z
    .object({
      changeId: z.string(),
      byTier: z.array(TierCost),
      byTask: z.array(TaskCost),
      routing: z.object({
        /** Decision Receipts by selected tier and by deciding layer. */
        receipts: z.record(z.enum(TIERS), z.number().int()),
        decidedBy: z.object({ rules: z.number().int(), clef: z.number().int() }),
        /** Attempts that ran on a higher tier than the previous attempt of the same Task. */
        escalations: z.number().int(),
        /** Attempts that repeated the previous attempt's tier. */
        retries: z.number().int(),
        failuresByKind: z.record(z.string(), z.number().int()),
      }),
    })
    .nullable(),
  meters: z.object({
    day: z.string(),
    month: z.string(),
    agentModelCallsToday: z.number().int(),
    agentDailyCallCap: z.number().int(),
    /** Agent calls sent to OpenRouter today; past the cap (or a 429) runs use Gemini (ADR 0016). */
    openrouterCallsToday: z.number().int(),
    openrouterDailyCallCap: z.number().int(),
    openrouterUsedUpToday: z.boolean(),
    /** The gateway refused Gemini for its $9 per 30 days spend cap today. */
    vertexSpendLimitedToday: z.boolean(),
    clefFlashCallsToday: z.number().int(),
    clefDailyCap: z.number().int(),
    sandboxSecondsMonth: z.number().int(),
    sandboxMonthlyCapSeconds: z.number().int(),
    /** Agent model calls per UTC day, oldest first; a day without a counter row is 0. */
    agentModelCallsByDay: z.array(z.object({ day: z.string(), count: z.number().int() })),
  }),
  callCapPerRun: z.record(z.enum(TIERS), z.number().int()),
});
export type CostView = z.infer<typeof CostView>;

type RunRow = {
  task_id: string;
  attempt: number;
  tier: string;
  status: string;
  failure_kind: string | null;
  model_calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

const zero = (): Usage => ({ runs: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });

function add(total: Usage, run: RunRow) {
  total.runs += 1;
  total.modelCalls += run.model_calls;
  total.inputTokens += run.input_tokens;
  total.outputTokens += run.output_tokens;
  total.costUsd += run.cost_usd;
}

function dayList(end: Date, days: number) {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - (days - 1 - i));
    return d.toISOString().slice(0, 10);
  });
}

export const cost = new Hono<AppEnv>().get(
  "/v1/projects/:projectId/cost",
  requireAuth,
  validate("param", ProjectIdParam),
  validate("query", CostQuery),
  async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { projectId } = c.req.valid("param");
    const { changeId } = c.req.valid("query");
    if (!(await canAccessProject(c.env.DB, userId, projectId))) {
      return fail(c, 404, "not_found", "Project not found");
    }

    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const days = dayList(now, METER_DAYS);
    const db = c.env.DB;

    // Newest Changes with their run totals, and the meters. Indexed: changes.project_id,
    // tasks.change_id, task_runs.task_id, usage_counters primary key (day, counter).
    const [changeRows, totalRows, meterRows] = await db.batch([
      db
        .prepare(
          `SELECT id, goal, status, budget_usd, created_at FROM changes
           WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
        )
        .bind(projectId, CHANGE_LIMIT),
      db
        .prepare(
          `SELECT t.change_id, COUNT(r.id) AS runs, COALESCE(SUM(r.model_calls), 0) AS model_calls,
                  COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(r.cost_usd), 0) AS cost_usd
           FROM task_runs r JOIN tasks t ON t.id = r.task_id
           WHERE t.change_id IN (
             SELECT id FROM changes WHERE project_id = ? ORDER BY created_at DESC LIMIT ?
           )
           GROUP BY t.change_id`,
        )
        .bind(projectId, CHANGE_LIMIT),
      db
        .prepare(
          `SELECT day, counter, count FROM usage_counters
           WHERE (day >= ? AND day <= ? AND counter IN ('agent-model-calls', 'clef-flash',
                    'openrouter-calls', 'openrouter-exhausted', 'vertex-spend-limited'))
              OR (day = ? AND counter = 'sandbox-seconds')`,
        )
        .bind(days[0], day, month),
    ]);

    type ChangeRow = {
      id: string;
      goal: string;
      status: string;
      budget_usd: number;
      created_at: string;
    };
    type TotalRow = {
      change_id: string;
      runs: number;
      model_calls: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    };
    const changes = (changeRows?.results ?? []) as ChangeRow[];
    const totals = new Map(
      ((totalRows?.results ?? []) as TotalRow[]).map((t) => [t.change_id, t] as const),
    );
    const meters = (meterRows?.results ?? []) as { day: string; counter: string; count: number }[];
    const meter = (d: string, counter: string) =>
      meters.find((m) => m.day === d && m.counter === counter)?.count ?? 0;

    // A Change outside the newest 20 still resolves when it belongs to this Project.
    let selectedId = changes[0]?.id ?? null;
    if (changeId) {
      const owned =
        changes.some((ch) => ch.id === changeId) ||
        (await db
          .prepare("SELECT 1 FROM changes WHERE id = ? AND project_id = ?")
          .bind(changeId, projectId)
          .first()) !== null;
      if (!owned) return fail(c, 404, "not_found", "Change not found");
      selectedId = changeId;
    }

    let selected: CostView["selected"] = null;
    if (selectedId) {
      const [taskRows, runRows, receiptRows] = await db.batch([
        db
          .prepare(
            `SELECT id, task_key, title, kind, status FROM tasks
             WHERE change_id = ? ORDER BY task_key LIMIT ?`,
          )
          .bind(selectedId, TASK_LIMIT),
        db
          .prepare(
            `SELECT r.task_id, r.attempt, r.tier, r.status, r.failure_kind, r.model_calls,
                    r.input_tokens, r.output_tokens, r.cost_usd
             FROM task_runs r JOIN tasks t ON t.id = r.task_id
             WHERE t.change_id = ? ORDER BY r.task_id, r.attempt LIMIT ?`,
          )
          .bind(selectedId, RUN_LIMIT),
        db
          .prepare(
            `SELECT d.selected_tier, d.decided_by, COUNT(*) AS n
             FROM decision_receipts d JOIN tasks t ON t.id = d.task_id
             WHERE t.change_id = ? GROUP BY d.selected_tier, d.decided_by`,
          )
          .bind(selectedId),
      ]);
      type TaskRow = {
        id: string;
        task_key: string | null;
        title: string | null;
        kind: string;
        status: string;
      };
      const runs = (runRows?.results ?? []) as RunRow[];
      const byTier = new Map<Tier, Usage & { maxCallsInRun: number }>(
        TIERS.map((t) => [t, { ...zero(), maxCallsInRun: 0 }]),
      );
      const failuresByKind: Record<string, number> = {};
      let escalations = 0;
      let retries = 0;
      let previous: RunRow | undefined;
      for (const run of runs) {
        if (!isTier(run.tier)) continue;
        const tier = byTier.get(run.tier);
        if (tier) {
          add(tier, run);
          tier.maxCallsInRun = Math.max(tier.maxCallsInRun, run.model_calls);
        }
        if (run.failure_kind)
          failuresByKind[run.failure_kind] = (failuresByKind[run.failure_kind] ?? 0) + 1;
        if (previous?.task_id === run.task_id && isTier(previous.tier)) {
          if (TIER_RANK[run.tier] > TIER_RANK[previous.tier]) escalations += 1;
          else if (run.tier === previous.tier) retries += 1;
        }
        previous = run;
      }

      const byTask = ((taskRows?.results ?? []) as TaskRow[]).map((t) => {
        const own = runs.filter((r) => r.task_id === t.id);
        const usage = zero();
        for (const r of own) add(usage, r);
        return {
          id: t.id,
          key: t.task_key ?? "",
          title: t.title ?? "",
          kind: t.kind,
          status: t.status,
          tiers: own.map((r) => r.tier).filter(isTier),
          maxCallsInRun: Math.max(0, ...own.map((r) => r.model_calls)),
          ...usage,
        };
      });

      const receipts: Record<Tier, number> = { haiku: 0, sonnet: 0, opus: 0 };
      const decidedBy = { rules: 0, clef: 0 };
      for (const r of (receiptRows?.results ?? []) as {
        selected_tier: string;
        decided_by: string;
        n: number;
      }[]) {
        if (isTier(r.selected_tier)) receipts[r.selected_tier] += r.n;
        if (r.decided_by === "rules" || r.decided_by === "clef") decidedBy[r.decided_by] += r.n;
      }

      selected = {
        changeId: selectedId,
        byTier: TIERS.map((tier) => ({
          tier,
          callCapPerRun: MAX_CALLS_PER_RUN[tier],
          ...(byTier.get(tier) ?? { ...zero(), maxCallsInRun: 0 }),
        })),
        byTask,
        routing: { receipts, decidedBy, escalations, retries, failuresByKind },
      };
    }

    return respond(c, apiData(CostView), {
      data: {
        generatedAt: now.toISOString(),
        changes: changes.map((ch) => {
          const t = totals.get(ch.id);
          return {
            id: ch.id,
            goal: ch.goal,
            status: ch.status,
            budgetUsd: ch.budget_usd,
            createdAt: ch.created_at,
            runs: t?.runs ?? 0,
            modelCalls: t?.model_calls ?? 0,
            inputTokens: t?.input_tokens ?? 0,
            outputTokens: t?.output_tokens ?? 0,
            costUsd: t?.cost_usd ?? 0,
          };
        }),
        selected,
        meters: {
          day,
          month,
          agentModelCallsToday: meter(day, "agent-model-calls"),
          agentDailyCallCap: AGENT_DAILY_CALL_CAP,
          openrouterCallsToday: meter(day, "openrouter-calls"),
          openrouterDailyCallCap: OPENROUTER_DAILY_CALL_CAP,
          openrouterUsedUpToday:
            meter(day, "openrouter-exhausted") > 0 ||
            meter(day, "openrouter-calls") >= OPENROUTER_DAILY_CALL_CAP,
          vertexSpendLimitedToday: meter(day, "vertex-spend-limited") > 0,
          clefFlashCallsToday: meter(day, "clef-flash"),
          clefDailyCap: CLEF_DAILY_CAP,
          sandboxSecondsMonth: meter(month, "sandbox-seconds"),
          sandboxMonthlyCapSeconds: SANDBOX_MONTHLY_SECONDS,
          agentModelCallsByDay: days.map((d) => ({ day: d, count: meter(d, "agent-model-calls") })),
        },
        callCapPerRun: MAX_CALLS_PER_RUN,
      },
    });
  },
);
