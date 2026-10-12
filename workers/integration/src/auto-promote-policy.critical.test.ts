// Default policy `policy-1`: which risk tiers and flags ship without a person. Low and medium
// ship automatically after every required check passes; high, critical, and every
// authorization change keep the human gate. The plan flag and the decision must agree.
import { autoPromoteDecision, buildVerificationPlan } from "@rhumbatron/evidence";
import type { RiskTier } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "./candidate-composer.ts";

function decide(riskTier: RiskTier, authorization: boolean) {
  const plan = buildVerificationPlan({
    candidateId: "cand_x",
    riskTier,
    policy: DEFAULT_POLICY,
    touches: { authorization, performanceConstraint: false, protectedInvariants: [], ui: false },
  });
  return autoPromoteDecision({
    candidateStatus: "verified",
    promotable: true,
    plan,
    riskTier,
    policy: DEFAULT_POLICY,
  });
}

describe("default policy auto-promotion", () => {
  it("ships low and medium risk without a person", () => {
    expect(decide("low", false)).toEqual({ kind: "auto_promote" });
    expect(decide("medium", false)).toEqual({ kind: "auto_promote" });
  });

  it("keeps the human gate for high and critical risk", () => {
    expect(decide("high", false)).toEqual({ kind: "manual", reason: "approval_required" });
    expect(decide("critical", false)).toEqual({ kind: "manual", reason: "approval_required" });
  });

  it("keeps the human gate for an authorization change at every tier", () => {
    for (const tier of ["low", "medium", "high", "critical"] as const) {
      expect(decide(tier, true)).toEqual({ kind: "manual", reason: "approval_required" });
    }
  });
});
