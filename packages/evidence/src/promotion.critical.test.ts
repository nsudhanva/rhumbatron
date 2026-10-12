// Release safety at the promotion boundary: only verified Evidence and a recorded human decision can
// let a Candidate reach ProjectRootDO.
import type { EvidenceRecord, ProjectPolicy, VerificationPlan } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { buildVerificationPlan } from "./plan.ts";
import {
  type ApprovalRecord,
  approvalRequired,
  checkApprovalDecision,
  checkPromotion,
  type PromotionFacts,
} from "./promotion.ts";

const policy: Pick<ProjectPolicy, "version" | "humanGateRiskTiers" | "requiredChecksByRisk"> = {
  version: "policy-1",
  humanGateRiskTiers: ["high", "critical"],
  requiredChecksByRisk: { low: ["build", "targeted"] },
};

const plan = (authorization = false): VerificationPlan =>
  buildVerificationPlan({
    candidateId: "cand_b",
    riskTier: "low",
    policy,
    touches: { authorization, performanceConstraint: false, protectedInvariants: [], ui: false },
  });

const ev = (checkId: string, over: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  evidenceId: `ev_b_${checkId}`,
  candidateId: "cand_b",
  checkId,
  kind: checkId,
  status: "pass",
  coverage: "checked_supported",
  startedAt: "2026-10-09T10:00:00.000Z",
  completedAt: "2026-10-09T10:00:30.000Z",
  summary: "ok",
  contentHash: "sha256:abc",
  sourceRefs: [],
  ...over,
});

const granted: ApprovalRecord = {
  approvalId: "apr_b",
  decision: "granted",
  approverId: "usr_owner",
  candidateTree: "tree-b",
};

const facts = (over: Partial<PromotionFacts> = {}): PromotionFacts => {
  const p = plan();
  return {
    candidate: {
      id: "cand_b",
      status: "verified",
      baseGeneration: 0,
      composedTree: "tree-b",
      plan: p,
    },
    riskTier: "low",
    policy,
    evidence: p.requiredCheckIds.map((id) => ev(id)),
    approval: null,
    canonical: { generation: 0, policyVersion: "policy-1" },
    artifactPresent: true,
    ...over,
  };
};

const kinds = (check: ReturnType<typeof checkPromotion>) =>
  check.ok ? [] : check.blocks.map((b) => b.kind);

describe("approvalRequired", () => {
  it("policy risk tiers and the plan can each add the gate, never remove it", () => {
    expect(approvalRequired({ humanApprovalRequired: false }, "high", policy)).toBe(true);
    expect(approvalRequired({ humanApprovalRequired: true }, "low", policy)).toBe(true);
    expect(approvalRequired({ humanApprovalRequired: false }, "medium", policy)).toBe(false);
  });
});

describe("checkApprovalDecision", () => {
  const base = {
    candidateStatus: "verified",
    required: true,
    existing: null,
    decision: "granted" as const,
    approverId: "usr_owner",
  };

  it("records a first decision on a verified, gated Candidate", () => {
    expect(checkApprovalDecision(base)).toEqual({ kind: "record" });
  });

  it("refuses to decide a Candidate that is not verified or not gated", () => {
    expect(checkApprovalDecision({ ...base, candidateStatus: "verifying" })).toMatchObject({
      reason: "not_verified",
    });
    expect(checkApprovalDecision({ ...base, required: false })).toMatchObject({
      reason: "not_required",
    });
  });

  it("the first decision is final; only an identical repeat is accepted", () => {
    const existing = { ...granted, decision: "rejected" as const };
    expect(checkApprovalDecision({ ...base, existing, decision: "rejected" })).toEqual({
      kind: "repeat",
    });
    expect(checkApprovalDecision({ ...base, existing })).toMatchObject({
      reason: "already_decided",
    });
    expect(
      checkApprovalDecision({ ...base, existing, decision: "rejected", approverId: "usr_other" }),
    ).toMatchObject({ reason: "already_decided" });
  });
});

describe("checkPromotion", () => {
  it("passes a verified Candidate and names the Evidence it relies on", () => {
    const check = checkPromotion(facts());
    expect(check).toEqual({
      ok: true,
      requiredEvidenceIds: ["ev_b_build", "ev_b_unit"],
      approvalRequired: false,
      approvalId: null,
    });
  });

  it("re-gates from Evidence rows: a failed or unsupported required check blocks", () => {
    const failed = facts({ evidence: [ev("build"), ev("unit", { status: "fail" })] });
    expect(kinds(checkPromotion(failed))).toEqual(["evidence_gap"]);
    const gap = facts({ evidence: [ev("build"), ev("unit", { coverage: "not_checked" })] });
    expect(kinds(checkPromotion(gap))).toEqual(["evidence_gap"]);
    expect(kinds(checkPromotion(facts({ evidence: [ev("build")] })))).toEqual(["evidence_gap"]);
  });

  it("requires a recorded grant for the composed tree when the gate applies", () => {
    const gated = (approval: ApprovalRecord | null) =>
      checkPromotion(facts({ riskTier: "high", approval }));
    expect(kinds(gated(null))).toEqual(["approval_pending"]);
    expect(kinds(gated({ ...granted, candidateTree: "tree-other" }))).toEqual(["approval_pending"]);
    expect(gated(granted)).toMatchObject({ ok: true, approvalRequired: true, approvalId: "apr_b" });
    expect(kinds(gated({ ...granted, decision: "rejected" }))).toEqual(["approval_rejected"]);
  });

  it("an authorization plan is gated even at low risk", () => {
    const p = plan(true);
    const evidence = p.requiredCheckIds.map((id) => ev(id));
    expect(
      kinds(checkPromotion(facts({ candidate: { ...facts().candidate, plan: p }, evidence }))),
    ).toEqual(["approval_pending"]);
  });

  it("reports a base behind the canonical generation as stale", () => {
    const check = checkPromotion(
      facts({ canonical: { generation: 1, policyVersion: "policy-1" } }),
    );
    expect(check).toEqual({
      ok: false,
      blocks: [{ kind: "stale", baseGeneration: 0, canonicalGeneration: 1 }],
    });
  });

  it("blocks unverified status, policy drift, and a missing Candidate artifact", () => {
    const candidate = { ...facts().candidate, status: "verifying" };
    expect(kinds(checkPromotion(facts({ candidate })))).toEqual(["not_verified"]);
    const rejectedBehind = facts({
      candidate: { ...facts().candidate, status: "rejected" },
      canonical: { generation: 1, policyVersion: "policy-1" },
    });
    expect(kinds(checkPromotion(rejectedBehind))).toEqual(["stale", "not_verified"]);
    const drift = facts({ canonical: { generation: 0, policyVersion: "policy-2" } });
    expect(kinds(checkPromotion(drift))).toEqual(["policy_mismatch"]);
    expect(kinds(checkPromotion(facts({ artifactPresent: false })))).toEqual(["artifact_missing"]);
  });

  it("never promotes without a plan for this Candidate", () => {
    const candidate = { ...facts().candidate, plan: { ...plan(), candidateId: "cand_a" } };
    expect(kinds(checkPromotion(facts({ candidate })))).toEqual(["missing_plan"]);
  });
});
