import type {
  EvidenceRecord,
  ProjectPolicy,
  RiskTier,
  VerificationPlan,
} from "@rhumbatron/protocol";
import { type CheckGap, gateRequiredChecks, latestEvidence, requiredChecks } from "./gate.ts";

/**
 * Human approval gate and promotion preconditions.
 * Deterministic policy only: no model decides who may approve or whether a Candidate may advance
 * the Canonical State. The integration Worker reads the authoritative rows; ProjectRootDO then runs
 * the compare-and-swap on its own state (ADR 0013).
 */

export type ApprovalDecision = "granted" | "rejected";

/** One recorded human decision. It binds to the exact composed tree the approver saw. */
export type ApprovalRecord = {
  approvalId: string;
  decision: ApprovalDecision;
  approverId: string;
  candidateTree: string;
};

export type ApprovalState = "not_required" | "pending" | "granted" | "rejected";

/**
 * A human gate applies when the Verification Plan asked for one (for example an authorization
 * change) or the policy gates the Change's risk tier. Either source can only add the gate.
 */
export function approvalRequired(
  plan: Pick<VerificationPlan, "humanApprovalRequired">,
  riskTier: RiskTier,
  policy: Pick<ProjectPolicy, "humanGateRiskTiers">,
): boolean {
  return plan.humanApprovalRequired || policy.humanGateRiskTiers.includes(riskTier);
}

export type AutoPromoteDecision =
  | { kind: "auto_promote" }
  | {
      kind: "manual";
      reason:
        | "not_verified"
        | "evidence_gap"
        | "approval_required"
        | "unknown_risk"
        | "tier_not_auto";
    };

/**
 * Policy `autoPromoteRiskTiers`. A verified Candidate whose required checks
 * pass promotes without a person only when the Change risk tier is listed and no human gate applies.
 * An unknown risk tier is never automatic. The decision only selects the trigger: promotion still
 * re-checks every promotion precondition from authoritative rows (`checkPromotion`).
 */
export function autoPromoteDecision(input: {
  candidateStatus: string;
  /** Gate result from authoritative Evidence rows; never a cached or model score. */
  promotable: boolean;
  plan: Pick<VerificationPlan, "humanApprovalRequired">;
  riskTier: RiskTier | null;
  policy: Pick<ProjectPolicy, "humanGateRiskTiers" | "autoPromoteRiskTiers">;
}): AutoPromoteDecision {
  if (input.candidateStatus !== "verified") return { kind: "manual", reason: "not_verified" };
  if (!input.promotable) return { kind: "manual", reason: "evidence_gap" };
  const gated =
    input.plan.humanApprovalRequired ||
    (input.riskTier !== null && approvalRequired(input.plan, input.riskTier, input.policy));
  if (gated) return { kind: "manual", reason: "approval_required" };
  if (input.riskTier === null) return { kind: "manual", reason: "unknown_risk" };
  if (!input.policy.autoPromoteRiskTiers.includes(input.riskTier)) {
    return { kind: "manual", reason: "tier_not_auto" };
  }
  return { kind: "auto_promote" };
}

/** A human rejection always blocks. A grant counts only for the tree that was approved. */
export function approvalState(
  required: boolean,
  approval: ApprovalRecord | null,
  candidateTree: string | null,
): ApprovalState {
  if (approval?.decision === "rejected") return "rejected";
  if (!required) return "not_required";
  if (
    approval?.decision === "granted" &&
    candidateTree &&
    approval.candidateTree === candidateTree
  ) {
    return "granted";
  }
  return "pending";
}

export type ApprovalCheck =
  | { kind: "record" }
  /** The same approver repeats the same decision: return the stored one. */
  | { kind: "repeat" }
  | { kind: "refuse"; reason: "not_verified" | "not_required" | "already_decided" };

/**
 * Whether a decision may be recorded. Only a verified Candidate whose gate applies can be decided,
 * and the first decision is final: a rejected Candidate needs a new Candidate, not a second vote.
 */
export function checkApprovalDecision(input: {
  candidateStatus: string;
  required: boolean;
  existing: ApprovalRecord | null;
  decision: ApprovalDecision;
  approverId: string;
}): ApprovalCheck {
  const { existing } = input;
  if (existing) {
    return existing.decision === input.decision && existing.approverId === input.approverId
      ? { kind: "repeat" }
      : { kind: "refuse", reason: "already_decided" };
  }
  if (input.candidateStatus !== "verified") return { kind: "refuse", reason: "not_verified" };
  if (!input.required) return { kind: "refuse", reason: "not_required" };
  return { kind: "record" };
}

export type PromotionBlock =
  | { kind: "not_verified"; status: string }
  | { kind: "stale"; baseGeneration: number; canonicalGeneration: number }
  | { kind: "missing_plan" }
  | { kind: "evidence_gap"; gaps: CheckGap[] }
  | { kind: "approval_pending" }
  | { kind: "approval_rejected" }
  | { kind: "policy_mismatch"; planPolicyVersion: string; activePolicyVersion: string }
  | { kind: "artifact_missing" }
  | { kind: "selection_pending"; pendingCandidateIds: string[] };

/** Authoritative facts gathered before the compare-and-swap. Never the cached gate score. */
export type PromotionFacts = {
  candidate: {
    id: string;
    status: string;
    baseGeneration: number;
    composedTree: string | null;
    plan: VerificationPlan | null;
  };
  riskTier: RiskTier;
  policy: Pick<ProjectPolicy, "humanGateRiskTiers">;
  /** Every Evidence row of the Candidate, from D1. */
  evidence: readonly EvidenceRecord[];
  approval: ApprovalRecord | null;
  /** ProjectRootDO snapshot. The DO re-checks generation, tree, and policy itself. */
  canonical: { generation: number; policyVersion: string };
  /** The composed commit still exists in the Candidate fork with the recorded tree. */
  artifactPresent: boolean;
  /**
   * Sibling Candidates (same Change, same base) still composing or verifying (ADR 0026). Until they
   * settle, no Candidate of the group is the winner. Absent means none.
   */
  pendingSiblingIds?: readonly string[];
};

export type PromotionCheck =
  | {
      ok: true;
      requiredEvidenceIds: string[];
      approvalRequired: boolean;
      approvalId: string | null;
    }
  | { ok: false; blocks: PromotionBlock[] };

/**
 * Promotion preconditions 1 to 5 and 8 (status, Evidence, pass state, approval, policy
 * version, Candidate artifact), re-computed from authoritative rows. Returns every block,
 * so the UI can show all gaps at once. Preconditions 6 and 7 (generation and tree) are decided by
 * ProjectRootDO; a base behind the snapshot is reported here early as `stale`.
 */
export function checkPromotion(facts: PromotionFacts): PromotionCheck {
  const { candidate, canonical } = facts;
  const blocks: PromotionBlock[] = [];

  if (candidate.status === "stale" || candidate.baseGeneration !== canonical.generation) {
    blocks.push({
      kind: "stale",
      baseGeneration: candidate.baseGeneration,
      canonicalGeneration: canonical.generation,
    });
  }
  if (candidate.status !== "verified" && candidate.status !== "stale") {
    blocks.push({ kind: "not_verified", status: candidate.status });
  }

  const plan = candidate.plan;
  if (!plan || plan.candidateId !== candidate.id) {
    blocks.push({ kind: "missing_plan" });
    return { ok: false, blocks };
  }

  // Gate again from the rows: a missing, timed-out, or skipped required check is never a pass.
  const gate = gateRequiredChecks(plan, facts.evidence);
  if (!gate.promotable) blocks.push({ kind: "evidence_gap", gaps: gate.gaps });

  const required = approvalRequired(plan, facts.riskTier, facts.policy);
  const approval = approvalState(required, facts.approval, candidate.composedTree);
  if (approval === "rejected") blocks.push({ kind: "approval_rejected" });
  if (approval === "pending") blocks.push({ kind: "approval_pending" });

  if (plan.policyVersion !== canonical.policyVersion) {
    blocks.push({
      kind: "policy_mismatch",
      planPolicyVersion: plan.policyVersion,
      activePolicyVersion: canonical.policyVersion,
    });
  }
  if (!facts.artifactPresent || !candidate.composedTree) blocks.push({ kind: "artifact_missing" });
  if (facts.pendingSiblingIds && facts.pendingSiblingIds.length > 0) {
    blocks.push({ kind: "selection_pending", pendingCandidateIds: [...facts.pendingSiblingIds] });
  }

  if (blocks.length > 0) return { ok: false, blocks };
  const requiredEvidenceIds = requiredChecks(plan).map((checkId) => {
    const records = facts.evidence.filter(
      (e) => e.candidateId === candidate.id && e.checkId === checkId,
    );
    // The gate passed, so every required check has a latest passing record.
    return latestEvidence(records)?.evidenceId ?? "";
  });
  return {
    ok: true,
    requiredEvidenceIds,
    approvalRequired: required,
    approvalId: approval === "granted" ? (facts.approval?.approvalId ?? null) : null,
  };
}
