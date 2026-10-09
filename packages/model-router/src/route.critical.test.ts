// Model escalation and Clef routing protect cost and safety: a wrong rule sends risky work to a weak
// model, or burns budget on retries that cannot succeed.
import type { RouteRequest } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import type { DecisionModel } from "./decision.ts";
import { nextStep } from "./escalation.ts";
import { routeStep } from "./route.ts";

const req: RouteRequest = {
  taskKind: "implement",
  complexity: "small",
  riskTier: "medium",
  affectedFiles: 2,
  affectedResources: ["project:acme:wishlist"],
  attempt: 1,
  priorFailureKinds: [],
  hasDesignConflict: false,
  touchesAuthorization: false,
  touchesBilling: false,
  touchesMigration: false,
  destructiveMigration: false,
  contextTokensEstimate: 2000,
  expectedToolCalls: 3,
  budgetRemainingUsd: 1,
};

const clefSays = (choice: string, p = 0.9): DecisionModel & { calls: number } => {
  const model = {
    calls: 0,
    async decide() {
      model.calls += 1;
      return [{ questionId: "tier", choice, probabilities: { [choice]: p }, abstained: false }];
    },
  };
  return model;
};

describe("nextStep", () => {
  it("retries once, escalates after two failures, and re-plans at opus", () => {
    expect(nextStep("haiku", [{ tier: "haiku", kind: "invalid_output" }]).action).toBe("retry");
    expect(
      nextStep("haiku", [
        { tier: "haiku", kind: "invalid_output" },
        { tier: "haiku", kind: "no_outcome" },
      ]),
    ).toMatchObject({ action: "escalate", tier: "sonnet" });
    expect(
      nextStep("opus", [
        { tier: "opus", kind: "agent_failed" },
        { tier: "opus", kind: "agent_failed" },
      ]).action,
    ).toBe("replan");
  });

  it("never escalates on transport failures and stops when the budget is gone", () => {
    expect(nextStep("sonnet", [{ tier: "sonnet", kind: "timeout" }])).toMatchObject({
      action: "retry",
      tier: "sonnet",
    });
    expect(
      nextStep("sonnet", [
        { tier: "sonnet", kind: "timeout" },
        { tier: "sonnet", kind: "rate_limited" },
      ]).action,
    ).toBe("stop");
    expect(nextStep("haiku", [{ tier: "haiku", kind: "budget_exhausted" }]).action).toBe("stop");
    // A run that hits its own call cap is an intelligence failure: retry, then escalate.
    expect(nextStep("haiku", [{ tier: "haiku", kind: "run_call_cap" }]).action).toBe("retry");
  });
});

describe("routeStep", () => {
  it("asks Clef only when no specific rule fired", async () => {
    const clef = clefSays("haiku");
    expect((await routeStep({ ...req, riskTier: "low" }, clef)).receipt.decidedBy).toBe("rules");
    expect(clef.calls).toBe(0);
    const routed = await routeStep(req, clef);
    expect(routed.receipt.decidedBy).toBe("clef");
    expect(routed.decision.selectedTier).toBe("haiku");
  });

  it("keeps deterministic floors and falls back to rules on abstain", async () => {
    const auth = await routeStep({ ...req, touchesAuthorization: true }, clefSays("haiku"));
    expect(auth.decision.selectedTier).toBe("sonnet");
    const abstained = await routeStep(req, {
      decide: async () => [
        { questionId: "tier", choice: null, probabilities: {}, abstained: true },
      ],
    });
    expect(abstained.receipt.decidedBy).toBe("rules");
  });
});
