import { ClaimFact, ClaimState, foldClaims, ModelTier, type TaskKind } from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

/**
 * Agents of one Project (AGENTS.md sections 13.4, 22, 23.5, 38.6, 57). One logical agent exists
 * per Task (`agt_<task suffix>`, workers/integration dispatch.ts); it wakes when its Task becomes
 * ready and sleeps when the run ends. The D1 `agents` table is not written yet, so the read model
 * comes from `tasks`, `task_runs` and `decision_receipts`. Active and recently active agents are
 * listed one by one; the rest of the pool is aggregated by role (section 38.6).
 *
 * Claims and the last event per agent come from the `project_events` feed (migration 0010). That
 * projection is optional here: when it is not readable the page reports `feed.available: false`
 * instead of empty Claims. Receipts carry routing inputs and outputs only, never model reasoning.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const ProjectIdParam = z.object({ projectId: z.string().regex(/^proj_[a-z0-9-]+$/) });

/** Mirrors AGENT_DAILY_CALL_CAP in packages/model-router budget.ts (account-wide, per UTC day). */
const AGENT_DAILY_CALL_CAP = 400;
/** Newest Tasks with an agent read per request. */
const TASK_LIMIT = 200;
/** Active agents listed one by one. */
const MAX_ACTIVE = 24;
/** Sleeping agents listed one by one, if active within `RECENT_HOURS`. */
const MAX_RECENT = 8;
const RECENT_HOURS = 24;
/** Feed rows scanned for the last event per agent, and Claim facts per Change. */
const EVENT_SCAN = 150;
const CLAIM_SCAN = 100;
const MAX_CLAIM_CHANGES = 6;

const ACTIVE_STATUSES = new Set(["assigned", "running"]);
const OPEN_STATUSES = new Set(["pending", "ready", "assigned", "running", "blocked"]);
/** Feed types that say nothing new about an agent. */
const QUIET_EVENTS = ["claim.renewed"];

/** Role per Task kind (section 22). One agent works one Task, so the Task kind decides the role. */
const ROLE_BY_KIND: Record<TaskKind, string> = {
  design: "Task Implementer",
  implement: "Task Implementer",
  migrate: "Task Implementer",
  document: "Task Implementer",
  review: "Specialist Reviewer",
  test: "Verification Agent",
};
const roleFor = (kind: string) => ROLE_BY_KIND[kind as TaskKind] ?? "Task Implementer";

const TIER_RANK: Record<string, number> = { haiku: 0, sonnet: 1, opus: 2 };

const RunView = z.object({
  attempt: z.number().int(),
  tier: ModelTier,
  status: z.enum(["running", "completed", "failed"]),
  failureKind: z.string().nullable(),
  /** The reason the agent gave with `fail_task`, or the runtime failure. Not model reasoning. */
  failureReason: z.string().nullable(),
  /** Decision Receipt: who routed this attempt and why (section 23.5). */
  decidedBy: z.string().nullable(),
  /**
   * Model provider of the attempt from its Decision Receipt: `anthropic` since ADR 0021, the
   * earlier providers on older receipts, null before ADR 0016.
   */
  provider: z.enum(["anthropic", "openrouter", "google-vertex-ai"]).nullable(),
  reasons: z.array(z.string()),
  /** The previous attempt's tier when this attempt moved up a tier. */
  escalatedFrom: ModelTier.nullable(),
  modelCalls: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  /** Live progress (migration 0010): the last tool step and when it was written. */
  lastStep: z.string().nullable(),
  progressAt: z.string().nullable(),
});

const AgentView = z.object({
  agentId: z.string(),
  role: z.string(),
  state: z.enum(["active", "sleeping"]),
  task: z.object({
    id: z.string(),
    key: z.string(),
    title: z.string(),
    kind: z.string(),
    status: z.string(),
    riskTier: z.string().nullable(),
    complexity: z.string().nullable(),
    changeId: z.string(),
    changeGoal: z.string(),
  }),
  /** Tier of the latest attempt; null before the first run. */
  tier: ModelTier.nullable(),
  attempts: z.number().int(),
  escalations: z.number().int(),
  modelCalls: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number(),
  /** The typed Intent of the latest completed attempt. */
  intent: z
    .object({
      summary: z.string(),
      semanticResources: z.array(z.string()),
      assumptions: z.array(z.string()),
    })
    .nullable(),
  /** Last known state per Claim; null when the event feed is not readable. */
  claims: z.array(ClaimState).nullable(),
  lastEvent: z.object({ type: z.string(), summary: z.string(), occurredAt: z.string() }).nullable(),
  lastActiveAt: z.string(),
  runs: z.array(RunView),
});
export type AgentView = z.infer<typeof AgentView>;

const RoleCount = z.object({ role: z.string(), count: z.number().int() });

const AgentsPage = z.object({
  /** Active agents first, then recently active sleeping agents; newest activity first. */
  agents: z.array(AgentView),
  sleeping: z.object({
    /** Every sleeping agent, listed or not. */
    total: z.number().int(),
    /** Sleeping agents not listed one by one, by role. */
    unlisted: z.array(RoleCount),
  }),
  /** Open Tasks whose logical agent has not woken. */
  notWoken: z.number().int(),
  totals: z.object({
    agents: z.number().int(),
    active: z.number().int(),
    runs: z.number().int(),
    escalations: z.number().int(),
    modelCalls: z.number().int(),
    costUsd: z.number(),
  }),
  today: z.object({
    day: z.string(),
    /** Agent model calls today across the account; the cap is account-wide. */
    accountCalls: z.number().int(),
    cap: z.number().int(),
    /** Model calls of this Project's runs that started today (UTC). */
    projectCalls: z.number().int(),
  }),
  recentHours: z.number().int(),
  feed: z.object({ available: z.boolean() }),
});
export type AgentsPage = z.infer<typeof AgentsPage>;

type TaskRow = {
  id: string;
  change_id: string;
  task_key: string | null;
  title: string | null;
  kind: string;
  status: string;
  assigned_agent_id: string;
  risk_tier: string | null;
  complexity: string | null;
  updated_at: string;
  goal: string;
};

/** `SELECT r.*` so the 0010 progress columns are read when they exist and skipped otherwise. */
type RunRow = {
  id: string;
  task_id: string;
  agent_id: string;
  attempt: number;
  tier: string;
  status: "running" | "completed" | "failed";
  failure_kind: string | null;
  outcome_json: string | null;
  model_calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  started_at: string;
  ended_at: string | null;
  last_step?: string | null;
  progress_at?: string | null;
  decided_by: string | null;
  receipt_json: string | null;
};

type EventRow = {
  seq: number;
  event_id: string;
  event_type: string;
  actor_id: string;
  task_id: string | null;
  resource: string | null;
  occurred_at: string;
  summary: string;
  data_json: string;
};

const tierRankSql = (alias: string) =>
  `(CASE ${alias}.tier WHEN 'haiku' THEN 0 WHEN 'sonnet' THEN 1 ELSE 2 END)`;

function parseJson<T>(text: string | null | undefined): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const latest = (...times: (string | null | undefined)[]) =>
  times.filter((t): t is string => !!t).reduce((a, b) => (a > b ? a : b));

function toRuns(rows: RunRow[]): z.infer<typeof RunView>[] {
  return rows.map((r, index) => {
    const tier = ModelTier.parse(r.tier);
    const previous = index > 0 ? rows[index - 1] : undefined;
    const escalated =
      previous && (TIER_RANK[r.tier] ?? 0) > (TIER_RANK[previous.tier] ?? 0)
        ? ModelTier.parse(previous.tier)
        : null;
    const outcome = parseJson<{ reason?: unknown }>(r.outcome_json);
    const receipt = parseJson<{ reasons?: unknown; provider?: unknown }>(r.receipt_json);
    return {
      attempt: r.attempt,
      tier,
      status: r.status,
      failureKind: r.failure_kind,
      failureReason:
        r.status === "failed" && typeof outcome?.reason === "string" ? outcome.reason : null,
      decidedBy: r.decided_by,
      provider:
        receipt?.provider === "anthropic" ||
        receipt?.provider === "openrouter" ||
        receipt?.provider === "google-vertex-ai"
          ? receipt.provider
          : null,
      reasons: Array.isArray(receipt?.reasons)
        ? receipt.reasons.filter((x): x is string => typeof x === "string")
        : [],
      escalatedFrom: escalated,
      modelCalls: r.model_calls,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costUsd: r.cost_usd,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      lastStep: r.last_step ?? null,
      progressAt: r.progress_at ?? null,
    };
  });
}

function intentOf(rows: RunRow[]): AgentView["intent"] {
  const done = [...rows].reverse().find((r) => r.status === "completed");
  const intent = parseJson<{
    summary?: unknown;
    semanticResources?: unknown;
    assumptions?: unknown;
  }>(done?.outcome_json);
  if (!intent || typeof intent.summary !== "string") return null;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    summary: intent.summary,
    semanticResources: strings(intent.semanticResources),
    assumptions: strings(intent.assumptions),
  };
}

function claimFact(row: EventRow): ClaimFact | null {
  const data = parseJson<Record<string, unknown>>(row.data_json) ?? {};
  const action = row.event_type.split(".")[1];
  const parsed = ClaimFact.safeParse({
    seq: row.seq,
    eventId: row.event_id,
    action,
    claimId: data.claimId,
    agentId: typeof data.agentId === "string" ? data.agentId : row.actor_id,
    resource: row.resource ?? (typeof data.resource === "string" ? data.resource : ""),
    leaseExpiresAt: typeof data.leaseExpiresAt === "string" ? data.leaseExpiresAt : null,
    occurredAt: row.occurred_at,
  });
  return parsed.success ? parsed.data : null;
}

/** Claims and the last event per listed agent from the feed. Null when the feed is unreadable. */
async function readFeed(db: D1Database, projectId: string, listed: TaskRow[]) {
  const changeIds = [...new Set(listed.map((t) => t.change_id))].slice(0, MAX_CLAIM_CHANGES);
  const quiet = QUIET_EVENTS.map(() => "?").join(", ");
  try {
    const results = await db.batch([
      db
        .prepare(
          `SELECT seq, event_id, event_type, actor_id, task_id, resource, occurred_at, summary, data_json
           FROM project_events WHERE project_id = ? AND event_type NOT IN (${quiet})
           ORDER BY seq DESC LIMIT ?`,
        )
        .bind(projectId, ...QUIET_EVENTS, EVENT_SCAN),
      // The WHERE term repeats the partial index predicate exactly (migration 0010).
      ...changeIds.map((changeId) =>
        db
          .prepare(
            `SELECT seq, event_id, event_type, actor_id, task_id, resource, occurred_at, summary, data_json
             FROM project_events
             WHERE change_id = ? AND event_type IN ('claim.acquired', 'claim.renewed', 'claim.released', 'claim.expired')
             ORDER BY seq DESC LIMIT ?`,
          )
          .bind(changeId, CLAIM_SCAN),
      ),
    ]);
    const events = (results[0]?.results ?? []) as EventRow[];
    const claimRows = results.slice(1).flatMap((r) => (r.results ?? []) as EventRow[]);
    const facts = claimRows
      .map(claimFact)
      .filter((f): f is ClaimFact => f !== null)
      .sort((a, b) => a.seq - b.seq);
    return { events, claims: foldClaims(facts, Date.now()) };
  } catch (error) {
    console.warn(
      JSON.stringify({ event: "agents.feed_unavailable", message: String(error).slice(0, 200) }),
    );
    return null;
  }
}

export const agents = new Hono<AppEnv>().get(
  "/v1/projects/:projectId/agents",
  requireAuth,
  validate("param", ProjectIdParam),
  async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { projectId } = c.req.valid("param");
    if (!(await canAccessProject(c.env.DB, userId, projectId))) {
      return fail(c, 404, "not_found", "Project not found");
    }
    const db = c.env.DB;
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);

    const [taskResult, countResult, totalResult, usageResult] = await db.batch([
      db
        .prepare(
          `SELECT t.id, t.change_id, t.task_key, t.title, t.kind, t.status, t.assigned_agent_id,
                  t.risk_tier, t.complexity, t.updated_at, c.goal
           FROM changes c JOIN tasks t ON t.change_id = c.id
           WHERE c.project_id = ? AND t.assigned_agent_id IS NOT NULL
           ORDER BY t.updated_at DESC LIMIT ?`,
        )
        .bind(projectId, TASK_LIMIT),
      db
        .prepare(
          `SELECT t.kind, t.status, (t.assigned_agent_id IS NOT NULL) AS woken, COUNT(*) AS n
           FROM changes c JOIN tasks t ON t.change_id = c.id
           WHERE c.project_id = ? GROUP BY t.kind, t.status, woken`,
        )
        .bind(projectId),
      db
        .prepare(
          `SELECT COUNT(r.id) AS runs,
                  COALESCE(SUM(r.model_calls), 0) AS calls,
                  COALESCE(SUM(r.cost_usd), 0) AS cost,
                  COALESCE(SUM(CASE WHEN r.started_at >= ? THEN r.model_calls ELSE 0 END), 0) AS calls_today,
                  COALESCE(SUM(CASE WHEN p.tier IS NOT NULL AND ${tierRankSql("r")} > ${tierRankSql("p")}
                                    THEN 1 ELSE 0 END), 0) AS escalations
           FROM changes c JOIN tasks t ON t.change_id = c.id JOIN task_runs r ON r.task_id = t.id
           LEFT JOIN task_runs p ON p.task_id = r.task_id AND p.attempt = r.attempt - 1
           WHERE c.project_id = ?`,
        )
        .bind(`${day}T00:00:00.000Z`, projectId),
      db
        .prepare("SELECT count FROM usage_counters WHERE day = ? AND counter = 'agent-model-calls'")
        .bind(day),
    ]);

    const tasks = (taskResult?.results ?? []) as TaskRow[];
    const counts = (countResult?.results ?? []) as {
      kind: string;
      status: string;
      woken: number;
      n: number;
    }[];
    const totals = (totalResult?.results?.[0] ?? {}) as {
      runs?: number;
      calls?: number;
      cost?: number;
      calls_today?: number;
      escalations?: number;
    };
    const accountCalls = (usageResult?.results?.[0] as { count?: number } | undefined)?.count ?? 0;

    // Listed agents: every active one (capped), then sleeping ones active in the recent window.
    const recentSince = new Date(now - RECENT_HOURS * 3_600_000).toISOString();
    const active = tasks.filter((t) => ACTIVE_STATUSES.has(t.status)).slice(0, MAX_ACTIVE);
    const recent = tasks
      .filter((t) => !ACTIVE_STATUSES.has(t.status) && t.updated_at >= recentSince)
      .slice(0, MAX_RECENT);
    const listed = [...active, ...recent];

    const ids = listed.map((t) => t.id);
    const [runResult, feed] = await Promise.all([
      ids.length === 0
        ? Promise.resolve({ results: [] as RunRow[] })
        : db
            .prepare(
              `SELECT r.*, d.decided_by, d.receipt_json
               FROM task_runs r LEFT JOIN decision_receipts d ON d.id = 'rcpt_' || substr(r.id, 5)
               WHERE r.task_id IN (${ids.map(() => "?").join(", ")})
               ORDER BY r.task_id, r.attempt`,
            )
            .bind(...ids)
            .all<RunRow>(),
      listed.length === 0 ? Promise.resolve(null) : readFeed(db, projectId, listed),
    ]);
    const runRows = (runResult.results ?? []) as RunRow[];

    const views: AgentView[] = listed.map((t) => {
      const rows = runRows.filter((r) => r.task_id === t.id);
      const runs = toRuns(rows);
      const last = runs.at(-1);
      const lastEvent = feed?.events.find(
        (e) => e.task_id === t.id || e.actor_id === t.assigned_agent_id,
      );
      return {
        agentId: t.assigned_agent_id,
        role: roleFor(t.kind),
        state: ACTIVE_STATUSES.has(t.status) ? "active" : "sleeping",
        task: {
          id: t.id,
          key: t.task_key ?? "",
          title: t.title ?? "",
          kind: t.kind,
          status: t.status,
          riskTier: t.risk_tier,
          complexity: t.complexity,
          changeId: t.change_id,
          changeGoal: t.goal,
        },
        tier: last?.tier ?? null,
        attempts: runs.length,
        escalations: runs.filter((r) => r.escalatedFrom !== null).length,
        modelCalls: runs.reduce((s, r) => s + r.modelCalls, 0),
        inputTokens: runs.reduce((s, r) => s + r.inputTokens, 0),
        outputTokens: runs.reduce((s, r) => s + r.outputTokens, 0),
        costUsd: runs.reduce((s, r) => s + r.costUsd, 0),
        intent: intentOf(rows),
        claims: feed
          ? feed.claims
              .filter((claim) => claim.agentId === t.assigned_agent_id)
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          : null,
        lastEvent: lastEvent
          ? {
              type: lastEvent.event_type,
              summary: lastEvent.summary,
              occurredAt: lastEvent.occurred_at,
            }
          : null,
        lastActiveAt: latest(
          t.updated_at,
          last?.startedAt,
          last?.endedAt,
          last?.progressAt,
          lastEvent?.occurred_at,
        ),
        runs,
      };
    });
    views.sort(
      (a, b) =>
        Number(b.state === "active") - Number(a.state === "active") ||
        b.lastActiveAt.localeCompare(a.lastActiveAt),
    );

    // Pool counts cover every Task of the Project, not only the rows read above.
    const woken = counts.filter((r) => r.woken);
    const activeTotal = woken
      .filter((r) => ACTIVE_STATUSES.has(r.status))
      .reduce((s, r) => s + r.n, 0);
    const sleepingByRole = new Map<string, number>();
    for (const r of woken.filter((r) => !ACTIVE_STATUSES.has(r.status))) {
      const role = roleFor(r.kind);
      sleepingByRole.set(role, (sleepingByRole.get(role) ?? 0) + r.n);
    }
    const sleepingTotal = [...sleepingByRole.values()].reduce((s, n) => s + n, 0);
    for (const view of views.filter((v) => v.state === "sleeping")) {
      sleepingByRole.set(view.role, Math.max(0, (sleepingByRole.get(view.role) ?? 0) - 1));
    }

    return respond(c, z.object({ data: AgentsPage }), {
      data: {
        agents: views,
        sleeping: {
          total: sleepingTotal,
          unlisted: [...sleepingByRole]
            .filter(([, count]) => count > 0)
            .map(([role, count]) => ({ role, count }))
            .sort((a, b) => b.count - a.count),
        },
        notWoken: counts
          .filter((r) => !r.woken && OPEN_STATUSES.has(r.status))
          .reduce((s, r) => s + r.n, 0),
        totals: {
          agents: activeTotal + sleepingTotal,
          active: activeTotal,
          runs: totals.runs ?? 0,
          escalations: totals.escalations ?? 0,
          modelCalls: totals.calls ?? 0,
          costUsd: totals.cost ?? 0,
        },
        today: {
          day,
          accountCalls,
          cap: AGENT_DAILY_CALL_CAP,
          projectCalls: totals.calls_today ?? 0,
        },
        recentHours: RECENT_HOURS,
        feed: { available: feed !== null || listed.length === 0 },
      },
    });
  },
);
