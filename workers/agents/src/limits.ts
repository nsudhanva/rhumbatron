import {
  AGENT_DAILY_CALL_CAP,
  anthropicMonthlyBudgetUsd,
  budgetStopText,
  type Failure,
  type FailureKind,
  type NextStep,
  nextStep,
  nextTier,
  type SpendMeter,
  spendMonth,
} from "@rhumbatron/model-router";
import type { BudgetLimit, ModelTier } from "@rhumbatron/protocol";

/**
 * Change cost and concurrency limits, enforced where work is admitted. Each check is
 * deterministic and atomic in D1: the count and the admission are one conditional statement, so
 * two concurrent admissions cannot both take the last slot. A refused admission starts no new
 * expensive work, keeps all state, and records the exact limit on the Task or Change
 * (`blocked_limit`, `blocked_reason`; migration 0011).
 *
 * Concurrency limits (agents, Sandboxes) are backpressure: the work waits and resumes when a slot
 * frees. Attempt and call limits are budgets: the Task stops and the Change is `budget_blocked`
 * until a person acts.
 */

export const CHANGE_LIMITS = {
  /** Max active reasoning agents per Change. Tasks `assigned` or `running`. */
  maxActiveAgentsPerChange: 8,
  /** Max active coding Sandboxes per Change. Open run workspaces. */
  maxActiveSandboxesPerChange: 4,
  /** Max model attempts per Task at one tier. At the limit the Task stops. */
  maxAttemptsPerTier: 2,
} as const;

export type LimitKey =
  | "max_active_agents_per_change"
  | "max_active_sandboxes_per_change"
  | "max_attempts_per_tier"
  | "daily_model_calls"
  | "monthly_model_spend"
  | "change_budget"
  | "project_budget"
  | "account_budget";

/** The minimum of D1 this module uses; D1Database satisfies it. */
type Db = Pick<D1Database, "prepare">;

/** Atomically admits one daily model request; shared by Pi and context compaction. */
export async function takeQuota(
  db: Db,
  day: string,
  counter: string,
  cap: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO usage_counters (day, counter, count) VALUES (?, ?, 1)
       ON CONFLICT (day, counter) DO UPDATE SET count = count + 1 WHERE count < ?
       RETURNING count`,
    )
    .bind(day, counter, cap)
    .first<{ count: number }>();
  return row !== null;
}

const TRANSPORT = new Set<FailureKind>(["rate_limited", "timeout", "transient"]);

const agentLimitReason = (active: number) =>
  `Waiting: ${active} reasoning agents are active in this Change (limit ${CHANGE_LIMITS.maxActiveAgentsPerChange} per Change). The Task starts when one finishes.`;

export const sandboxLimitReason = () =>
  `Limit reached: ${CHANGE_LIMITS.maxActiveSandboxesPerChange} coding Sandboxes are already open in this Change (limit ${CHANGE_LIMITS.maxActiveSandboxesPerChange} per Change). No Sandbox was opened.`;

export type AgentAdmission =
  | { kind: "admitted" }
  | { kind: "deferred"; active: number }
  | { kind: "not_ready" };

/**
 * Admits one ready Task to a reasoning agent: `ready -> assigned` only while fewer than
 * `maxActiveAgentsPerChange` Tasks of the Change are `assigned` or `running`. A refused Task stays
 * `ready`, names the limit, and loses its `wake_sent_at`, so the next dispatch after a slot frees
 * wakes it again (event-router causal.ts).
 */
export async function admitAgent(
  db: Db,
  input: { taskId: string; changeId: string; agentId: string; now: string },
): Promise<AgentAdmission> {
  const assigned = await db
    .prepare(
      `UPDATE tasks SET status = 'assigned', assigned_agent_id = ?, blocked_limit = NULL,
         blocked_reason = NULL, updated_at = ?
       WHERE id = ? AND status = 'ready'
         AND (SELECT COUNT(*) FROM tasks WHERE change_id = ? AND status IN ('assigned', 'running')) < ?`,
    )
    .bind(
      input.agentId,
      input.now,
      input.taskId,
      input.changeId,
      CHANGE_LIMITS.maxActiveAgentsPerChange,
    )
    .run();
  if ((assigned.meta.changes ?? 0) > 0) return { kind: "admitted" };

  const row = await db
    .prepare(
      `SELECT t.status,
         (SELECT COUNT(*) FROM tasks WHERE change_id = ? AND status IN ('assigned', 'running')) AS active
       FROM tasks t WHERE t.id = ?`,
    )
    .bind(input.changeId, input.taskId)
    .first<{ status: string; active: number }>();
  // Another delivery assigned it first, or it moved on.
  if (row?.status !== "ready") return { kind: "not_ready" };
  await db
    .prepare(
      `UPDATE tasks SET blocked_limit = 'max_active_agents_per_change', blocked_reason = ?,
         wake_sent_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'ready'`,
    )
    .bind(agentLimitReason(row.active), input.now, input.taskId)
    .run();
  return { kind: "deferred", active: row.active };
}

/**
 * Takes one coding Sandbox slot of a Change for a run: marks the run's workspace open only while
 * fewer than `maxActiveSandboxesPerChange` running runs of the Change hold one. False when full.
 */
export async function admitSandbox(
  db: Db,
  input: { runId: string; changeId: string; now: string },
): Promise<boolean> {
  // A run that already holds its slot keeps it: a repeat admit is not a second Sandbox.
  const held = await db
    .prepare(
      "SELECT 1 AS held FROM task_runs WHERE id = ? AND workspace_opened_at IS NOT NULL AND workspace_closed_at IS NULL",
    )
    .bind(input.runId)
    .first<{ held: number }>();
  if (held) return true;
  const taken = await db
    .prepare(
      `UPDATE task_runs SET workspace_opened_at = ?, workspace_closed_at = NULL
       WHERE id = ? AND (workspace_opened_at IS NULL OR workspace_closed_at IS NOT NULL)
         AND (SELECT COUNT(*) FROM task_runs r JOIN tasks t ON t.id = r.task_id
              WHERE t.change_id = ? AND r.status = 'running'
                AND r.workspace_opened_at IS NOT NULL AND r.workspace_closed_at IS NULL) < ?`,
    )
    .bind(input.now, input.runId, input.changeId, CHANGE_LIMITS.maxActiveSandboxesPerChange)
    .run();
  return (taken.meta.changes ?? 0) > 0;
}

/** Frees the run's Sandbox slot. Safe to repeat. */
export async function releaseSandbox(db: Db, runId: string, now: string) {
  await db
    .prepare(
      `UPDATE task_runs SET workspace_closed_at = ?
       WHERE id = ? AND workspace_opened_at IS NOT NULL AND workspace_closed_at IS NULL`,
    )
    .bind(now, runId)
    .run();
}

/** Records a refused Sandbox on the Task, so the refusal is visible while the Task is open. */
export async function noteSandboxRefused(db: Db, taskId: string, now: string) {
  await db
    .prepare(
      `UPDATE tasks SET blocked_limit = 'max_active_sandboxes_per_change', blocked_reason = ?,
         updated_at = ? WHERE id = ? AND status IN ('assigned', 'running')`,
    )
    .bind(sandboxLimitReason(), now, taskId)
    .run();
}

/**
 * Applies the per-tier attempt limit to the escalation decision. The next attempt
 * at a tier that already had `maxAttemptsPerTier` attempts is refused: it escalates when an
 * intelligence failure happened at that tier, the latest failure is not a transport failure, and a
 * stronger tier exists; otherwise it stops for re-plan. A network timeout or other transport
 * failure never escalates. Sonnet is the top tier while Opus is off (ADR 0021).
 */
export function limitAttempts(
  step: NextStep,
  previous: readonly { tier: ModelTier; failure_kind: string | null }[],
  options: { allowOpus?: boolean } = {},
): NextStep {
  if (step.action !== "retry" && step.action !== "escalate") return step;
  const at = previous.filter((r) => r.tier === step.tier);
  if (at.length < CHANGE_LIMITS.maxAttemptsPerTier) return step;
  const intelligence = at.some(
    (r) => r.failure_kind && !TRANSPORT.has(r.failure_kind as FailureKind),
  );
  const latest = previous.at(-1)?.failure_kind;
  const afterTransport = Boolean(latest && TRANSPORT.has(latest as FailureKind));
  const next = nextTier(step.tier, options.allowOpus ?? true);
  if (intelligence && !afterTransport && next) {
    return { action: "escalate", tier: next, reason: `max_attempts_at_${step.tier}` };
  }
  return { action: "stop", reason: "max_attempts_per_tier" };
}

/** One `task_runs` row of a Task, oldest first. */
export type TaskRunHistory = {
  tier: ModelTier;
  failure_kind: string | null;
  started_at: string;
};

/**
 * The next attempt of a Task from its whole run history: the escalation
 * rules of the model router over every failure in the current attempt window, then the attempt
 * limit. A person's budget raise after a repeated-failure stop opens a new window (`resetAt`, ADR
 * 0021). Null before the first run. Both the run end (which emits `agent.escalated`) and the next
 * start (which routes) use this, so they always agree.
 */
export function nextAttempt(
  runs: readonly TaskRunHistory[],
  resetAt: string | null,
  options: { allowOpus?: boolean } = {},
): { previous: TaskRunHistory[]; failures: Failure[]; step: NextStep | null } {
  const previous = runs.filter((r) => !resetAt || r.started_at >= resetAt);
  const failures: Failure[] = previous
    .filter((r) => r.failure_kind)
    .map((r) => ({ tier: r.tier, kind: r.failure_kind as FailureKind }));
  const lastTier = previous.at(-1)?.tier;
  const limited = lastTier
    ? limitAttempts(nextStep(lastTier, failures, options), previous, options)
    : null;
  // A run that spent its whole share of the Change budget fails as `run_cost_cap`. When the
  // attempt limit then stops the Task, the cause is the budget: name it, not the attempts.
  const step =
    limited &&
    (limited.action === "stop" || limited.action === "replan") &&
    ATTEMPT_STOP.test(limited.reason) &&
    failures.at(-1)?.kind === "run_cost_cap"
      ? ({ action: "stop", reason: "change_budget_exhausted" } as const)
      : limited;
  return { previous, failures, step };
}

const ATTEMPT_STOP = /^(max_attempts_per_tier|two_failures_at_(haiku|sonnet|opus))/;

const SCOPED_STOPS: Readonly<Record<string, BudgetLimit>> = {
  change_budget_exhausted: "change_budget",
  change_budget: "change_budget",
  project_budget: "project_budget",
  account_budget: "account_budget",
};

/**
 * A terminal step reason that is a budget stop: the Task is `blocked` and the Change
 * `budget_blocked`, both naming the exact limit. Null for an ordinary failure.
 */
export function limitStop(
  reason: string,
  /** The `ANTHROPIC_MONTHLY_BUDGET_USD` binding (ADR 0021); the $10 fallback when absent. */
  monthlyBudgetUsd?: string,
  /** The meters of the Change (budget-meters.ts): the stop text names the cap and the month. */
  budgets?: { meters: readonly SpendMeter[]; month: string },
): { limit: LimitKey; text: string } | null {
  const scoped = SCOPED_STOPS[reason];
  if (scoped) {
    const cap = budgets?.meters.find((m) => m.limit === scoped)?.capUsd ?? null;
    return { limit: scoped, text: budgetStopText(scoped, cap, budgets?.month ?? spendMonth()) };
  }
  if (reason === "budget_exhausted") {
    return {
      limit: "daily_model_calls",
      text: `Paused: today's limit of ${AGENT_DAILY_CALL_CAP} model calls is used up, or the run was cancelled. Work continues after midnight UTC.`,
    };
  }
  if (reason === "monthly_model_spend") {
    const usd = anthropicMonthlyBudgetUsd(monthlyBudgetUsd);
    const shown = Number.isInteger(usd) ? String(usd) : usd.toFixed(2);
    return {
      limit: "monthly_model_spend",
      text: `Paused: this month's model budget of $${shown} is used up, or Anthropic refused the call for billing. Work continues next month, or when an operator raises the budget.`,
    };
  }
  if (reason === "max_attempts_per_tier" || /^two_failures_at_(sonnet|opus)$/.test(reason)) {
    return {
      limit: "max_attempts_per_tier",
      text: `Stopped: this task failed ${CHANGE_LIMITS.maxAttemptsPerTier} times, so Rhumbatron stopped it to save cost. Open the Change to see why it failed, then submit a clearer or smaller request.`,
    };
  }
  return null;
}
