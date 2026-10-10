import type { ModelTier, RiskTier, RouteDecision, RouteRequest } from "@rhumbatron/protocol";

/** Deterministic routing (AGENTS.md section 23.2). Runs before any Clef decision. */

const TIER_ORDER: readonly ModelTier[] = ["haiku", "sonnet", "opus"];
const RISK_ORDER: readonly RiskTier[] = ["low", "medium", "high", "critical"];

/** Task kinds that only reshape existing content. */
const MECHANICAL_KINDS = new Set(["summarize", "classify", "compact", "transform"]);
const PLANNING_KINDS = new Set(["plan", "architecture", "arbitration"]);

/** Section 24.2 output caps. */
const MAX_OUTPUT_TOKENS: Record<ModelTier, number> = { haiku: 4000, sonnet: 8000, opus: 8000 };

/** Section 23.3 escalation triggers, by tier. */
const ESCALATE_ON: Record<ModelTier, string[]> = {
  haiku: [
    "two_failures",
    "files_not_identified",
    "protocol_change_proposed",
    "ambiguous_dependency",
    "token_budget_without_changeset",
    "file_threshold_exceeded",
    "verifier_rejected_twice",
  ],
  sonnet: [
    "two_failures_fresh_context",
    "incompatible_designs",
    "security_boundary_change",
    "promotion_behavior_change",
    "event_delivery_change",
    "cross_shard_semantics_change",
    "destructive_migration",
    "unresolved_stale_candidate",
    "multi_service_failure",
  ],
  opus: [],
};

const atLeast = (tier: ModelTier, floor: ModelTier): ModelTier =>
  TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(floor) ? tier : floor;

const riskAtMost = (risk: RiskTier, max: RiskTier) =>
  RISK_ORDER.indexOf(risk) <= RISK_ORDER.indexOf(max);

function baseTier(req: RouteRequest): { tier: ModelTier; reason: string } {
  if (req.destructiveMigration) return { tier: "opus", reason: "destructive_migration" };
  if (req.hasDesignConflict && new Set(req.affectedResources).size > 1) {
    return { tier: "opus", reason: "cross_resource_design_conflict" };
  }
  if (MECHANICAL_KINDS.has(req.taskKind)) return { tier: "haiku", reason: "mechanical_task" };
  if (req.complexity === "small" && req.riskTier === "low" && req.attempt === 1) {
    return { tier: "haiku", reason: "small_low_risk_first_attempt" };
  }
  if (req.complexity === "medium" && riskAtMost(req.riskTier, "medium")) {
    return { tier: "sonnet", reason: "medium_complexity" };
  }
  if (req.complexity === "large") {
    return PLANNING_KINDS.has(req.taskKind)
      ? { tier: "opus", reason: "large_planning" }
      : { tier: "sonnet", reason: "large_child_implementation" };
  }
  return { tier: "sonnet", reason: "default" };
}

export function routeByRules(req: RouteRequest): RouteDecision {
  const base = baseTier(req);
  let tier = base.tier;
  const reasons = [base.reason];

  const trivial = req.complexity === "small" && req.riskTier === "low";
  if (req.touchesAuthorization && !trivial && tier !== atLeast(tier, "sonnet")) {
    tier = "sonnet";
    reasons.push("authorization_floor");
  }
  if (req.touchesBilling && tier !== atLeast(tier, "sonnet")) {
    tier = "sonnet";
    reasons.push("billing_floor");
  }

  return decisionFor(tier, reasons, 1);
}

/** The full decision for a chosen tier: output cap and escalation triggers come from the tier. */
export function decisionFor(tier: ModelTier, reasons: string[], confidence: number): RouteDecision {
  return {
    selectedTier: tier,
    confidence,
    reasons,
    maxOutputTokens: MAX_OUTPUT_TOKENS[tier],
    maxAttemptsAtTier: 2,
    escalateOn: ESCALATE_ON[tier],
  };
}

/**
 * Policy after routing (ADR 0021): while Opus is off, an opus decision becomes the sonnet decision
 * (Sonnet output cap and escalation triggers) with `opus_disabled` appended, and names the tier it
 * replaced. Other decisions pass through unchanged.
 */
export function applyOpusPolicy(
  decision: RouteDecision,
  allowOpus: boolean,
): RouteDecision & { requestedTier?: ModelTier } {
  if (decision.selectedTier !== "opus" || allowOpus) return decision;
  return {
    ...decisionFor("sonnet", [...decision.reasons, "opus_disabled"], decision.confidence),
    requestedTier: "opus",
  };
}
