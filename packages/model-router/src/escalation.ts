import type { ModelTier } from "@rhumbatron/protocol";

/**
 * Escalation (AGENTS.md sections 23.3 and 42.8). Two intelligence failures at one tier move the
 * Task up one tier; two at opus send it back for re-planning. Transport failures never escalate:
 * they retry once at the same tier.
 */

export type FailureKind =
  | "no_outcome"
  | "invalid_output"
  | "verifier_rejected"
  | "agent_failed"
  | "rate_limited"
  | "timeout"
  | "transient"
  | "budget_exhausted";

export type Failure = { tier: ModelTier; kind: FailureKind };

export type NextStep =
  | { action: "retry"; tier: ModelTier; reason: string }
  | { action: "escalate"; tier: ModelTier; reason: string }
  | { action: "replan"; reason: string }
  | { action: "stop"; reason: string };

const TRANSPORT = new Set<FailureKind>(["rate_limited", "timeout", "transient"]);
const NEXT_TIER: Record<ModelTier, ModelTier | null> = {
  haiku: "sonnet",
  sonnet: "opus",
  opus: null,
};

export function nextStep(currentTier: ModelTier, failures: readonly Failure[]): NextStep {
  const last = failures.at(-1);
  if (!last) return { action: "retry", tier: currentTier, reason: "first_attempt" };
  if (last.kind === "budget_exhausted") return { action: "stop", reason: "budget_exhausted" };

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
  const next = NEXT_TIER[currentTier];
  return next
    ? { action: "escalate", tier: next, reason: `two_failures_at_${currentTier}` }
    : { action: "replan", reason: "two_failures_at_opus" };
}
