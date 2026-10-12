// Budget stop (P13-04). A wrong check lets an autonomous agent keep
// calling models after its run or Change budget is gone, which is the one failure that bills.
import { describe, expect, it } from "vitest";
import { checkRunBudget, MAX_CALLS_PER_RUN, taskBudgetUsd } from "./budget.ts";
import { nextStep } from "./escalation.ts";

describe("checkRunBudget", () => {
  it("allows calls below the tier cap and within the budget", () => {
    expect(checkRunBudget({ tier: "haiku", callsSoFar: 0, spentUsd: 0, budgetUsd: 0.03 })).toEqual({
      ok: true,
    });
    // Spending exactly the budget is allowed; only going over it stops.
    expect(
      checkRunBudget({ tier: "sonnet", callsSoFar: 3, spentUsd: 0.2, budgetUsd: 0.2 }),
    ).toEqual({ ok: true });
  });

  it("stops at the per-run call cap of each tier, never one call later", () => {
    for (const tier of ["haiku", "sonnet", "opus"] as const) {
      const cap = MAX_CALLS_PER_RUN[tier];
      expect(checkRunBudget({ tier, callsSoFar: cap - 1, spentUsd: 0, budgetUsd: 1 }).ok).toBe(
        true,
      );
      expect(checkRunBudget({ tier, callsSoFar: cap, spentUsd: 0, budgetUsd: 1 })).toEqual({
        ok: false,
        reason: "call_cap",
      });
    }
  });

  it("stops when spend passes the budget, including a zero budget", () => {
    expect(checkRunBudget({ tier: "opus", callsSoFar: 1, spentUsd: 0.51, budgetUsd: 0.5 })).toEqual(
      { ok: false, reason: "cost_cap" },
    );
    expect(checkRunBudget({ tier: "haiku", callsSoFar: 0, spentUsd: 0.001, budgetUsd: 0 })).toEqual(
      { ok: false, reason: "cost_cap" },
    );
  });
});

describe("taskBudgetUsd", () => {
  it("splits what is left of the Change budget across open Tasks", () => {
    expect(taskBudgetUsd(3, 1, 4)).toBe(0.5);
  });

  it("is never negative when the Change is over budget", () => {
    expect(taskBudgetUsd(3, 4.2, 2)).toBe(0);
  });

  it("gives nothing when no Task is open", () => {
    expect(taskBudgetUsd(3, 0, 0)).toBe(0);
  });
});

describe("budget stop", () => {
  it("a budget stop ends the Task instead of retrying or escalating to a stronger tier", () => {
    const step = nextStep("haiku", [
      { tier: "haiku", kind: "invalid_output" },
      { tier: "haiku", kind: "budget_exhausted" },
    ]);
    expect(step).toEqual({ action: "stop", reason: "budget_exhausted" });
  });
});
