// Policy `autoPromoteRiskTiers`: automatic promotion is a trigger only.
// It must never apply when a human gate applies, when evidence does not pass, or when risk is unknown.
import type { ProjectPolicy } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { autoPromoteDecision } from "./promotion.ts";

const policy: Pick<ProjectPolicy, "humanGateRiskTiers" | "autoPromoteRiskTiers"> = {
  humanGateRiskTiers: ["high", "critical"],
  autoPromoteRiskTiers: ["low"],
};

const input = (over: Partial<Parameters<typeof autoPromoteDecision>[0]> = {}) => ({
  candidateStatus: "verified",
  promotable: true,
  plan: { humanApprovalRequired: false },
  riskTier: "low" as const,
  policy,
  ...over,
});

describe("autoPromoteDecision", () => {
  it("auto-promotes a verified, gated-pass, low-risk Candidate with no human gate", () => {
    expect(autoPromoteDecision(input())).toEqual({ kind: "auto_promote" });
  });

  it("never auto-promotes when the plan requires a human approval", () => {
    expect(autoPromoteDecision(input({ plan: { humanApprovalRequired: true } }))).toEqual({
      kind: "manual",
      reason: "approval_required",
    });
  });

  it("never auto-promotes a tier the policy gates, even if it is also listed as automatic", () => {
    const both = { humanGateRiskTiers: ["low" as const], autoPromoteRiskTiers: ["low" as const] };
    expect(autoPromoteDecision(input({ policy: both }))).toEqual({
      kind: "manual",
      reason: "approval_required",
    });
  });

  it("never auto-promotes without passing evidence or a verified status", () => {
    expect(autoPromoteDecision(input({ promotable: false })).kind).toBe("manual");
    for (const status of ["verifying", "rejected", "stale", "promoted"]) {
      expect(autoPromoteDecision(input({ candidateStatus: status }))).toEqual({
        kind: "manual",
        reason: "not_verified",
      });
    }
  });

  it("keeps tiers outside autoPromoteRiskTiers and an unknown tier manual", () => {
    expect(autoPromoteDecision(input({ riskTier: "medium" }))).toEqual({
      kind: "manual",
      reason: "tier_not_auto",
    });
    expect(autoPromoteDecision(input({ riskTier: null }))).toEqual({
      kind: "manual",
      reason: "unknown_risk",
    });
    const none = { humanGateRiskTiers: [], autoPromoteRiskTiers: [] };
    expect(autoPromoteDecision(input({ policy: none })).kind).toBe("manual");
  });
});
