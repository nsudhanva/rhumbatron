import type { ModelTier } from "@rhumbatron/protocol";

/**
 * Escalation (AGENTS.md sections 23.3 and 42.8). Two intelligence failures at one tier move the
 * Task up one tier; two at the top tier send it back for re-planning. The top tier is opus when
 * `ALLOW_OPUS` is "true", else sonnet (ADR 0021). Transport failures never escalate: they retry
 * once at the same tier.
 */

export type FailureKind =
  | "no_outcome"
  | "run_call_cap"
  /** The run spent its share of the Change budget (`checkRunBudget` cost cap). */
  | "run_cost_cap"
  | "invalid_output"
  | "verifier_rejected"
  | "agent_failed"
  | "rate_limited"
  | "timeout"
  | "transient"
  | "budget_exhausted"
  /**
   * The monthly Anthropic budget refused the call, or the gateway spend limit or a billing error
   * rejected it (ADR 0021): a budget stop, never a retry.
   */
  | "spend_limited"
  /** A Change, Project, or requester budget refused the call (ADR 0030): a budget stop. */
  | "change_budget"
  | "project_budget"
  | "account_budget";

export type Failure = { tier: ModelTier; kind: FailureKind };

export type NextStep =
  | { action: "retry"; tier: ModelTier; reason: string }
  | { action: "escalate"; tier: ModelTier; reason: string }
  | { action: "replan"; reason: string }
  | { action: "stop"; reason: string };

const BUDGET_STOPS = new Set<FailureKind>(["change_budget", "project_budget", "account_budget"]);
const TRANSPORT = new Set<FailureKind>(["rate_limited", "timeout", "transient"]);
const NEXT_TIER: Record<ModelTier, ModelTier | null> = {
  haiku: "sonnet",
  sonnet: "opus",
  opus: null,
};

/** The next tier up, or null at the top. Sonnet is the top while Opus is off. */
export function nextTier(tier: ModelTier, allowOpus = true): ModelTier | null {
  const next = NEXT_TIER[tier];
  return next === "opus" && !allowOpus ? null : next;
}

export function nextStep(
  currentTier: ModelTier,
  failures: readonly Failure[],
  options: { allowOpus?: boolean } = {},
): NextStep {
  const last = failures.at(-1);
  if (!last) return { action: "retry", tier: currentTier, reason: "first_attempt" };
  if (last.kind === "budget_exhausted") return { action: "stop", reason: "budget_exhausted" };
  if (last.kind === "spend_limited") return { action: "stop", reason: "monthly_model_spend" };
  if (BUDGET_STOPS.has(last.kind)) return { action: "stop", reason: last.kind };

  if (TRANSPORT.has(last.kind)) {
    // One same-tier retry per transport failure streak; a second in a row stops (section 42.8).
    const streak = failures
      .slice()
      .reverse()
      .findIndex((f) => !TRANSPORT.has(f.kind));
    const transportRun = streak === -1 ? failures.length : streak;
    return transportRun <= 1
      ? { action: "retry", tier: currentTier, reason: `transport_${last.kind}` }
      : { action: "stop", reason: "repeated_transport_failure" };
  }

  const atTier = failures.filter((f) => f.tier === currentTier && !TRANSPORT.has(f.kind)).length;
  if (atTier < 2) return { action: "retry", tier: currentTier, reason: `failure_${last.kind}` };
  const next = nextTier(currentTier, options.allowOpus ?? true);
  return next
    ? { action: "escalate", tier: next, reason: `two_failures_at_${currentTier}` }
    : { action: "replan", reason: `two_failures_at_${currentTier}` };
}
