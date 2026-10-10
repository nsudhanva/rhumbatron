// Change status transitions after the Work Graph (AGENTS.md sections 36, 37, 42.10, 44): no path
// leaves a terminal state, cancel stops before promotion, and a budget raise restores only Tasks a
// budget stop blocked.
import { describe, expect, it } from "vitest";
import {
  CANCELLABLE_FROM,
  canCancel,
  changeAfterPromotion,
  changeAfterRelease,
  PROMOTABLE_FROM,
  type RestorableTask,
  restoreAfterBudgetRaise,
  TERMINAL_CHANGE_STATUSES,
} from "./change-status.ts";

const t = (
  id: string,
  status: RestorableTask["status"],
  dependsOn: string[] = [],
  blockedLimit: string | null = null,
): RestorableTask => ({ id, status, dependsOn, blockedLimit });

describe("change status transitions", () => {
  it("never leaves a terminal status by promotion or cancel", () => {
    for (const status of TERMINAL_CHANGE_STATUSES) {
      expect(PROMOTABLE_FROM).not.toContain(status);
      expect(CANCELLABLE_FROM).not.toContain(status);
    }
  });

  it("cannot cancel once promotion has started", () => {
    for (const status of ["promoting", "releasing"]) expect(canCancel(status)).toBe(false);
    for (const status of ["running", "verifying", "awaiting_approval", "budget_blocked"]) {
      expect(canCancel(status)).toBe(true);
    }
  });

  it("releases only with a release target, and completes otherwise as before", () => {
    expect(changeAfterPromotion(true)).toBe("releasing");
    expect(changeAfterPromotion(false)).toBe("completed");
  });

  it("ends a releasing Change only on a final release status", () => {
    expect(changeAfterRelease("deployed")).toBe("completed");
    expect(changeAfterRelease("superseded")).toBe("completed");
    expect(changeAfterRelease("failed")).toBe("failed");
    expect(changeAfterRelease("smoke_failed")).toBe("failed");
    expect(changeAfterRelease("queued")).toBeNull();
    expect(changeAfterRelease("building")).toBeNull();
  });
});

describe("restoreAfterBudgetRaise", () => {
  it("readies the stopped Task and returns its blocked dependents to pending", () => {
    const g = [
      t("a", "completed"),
      t("b", "blocked", ["a"], "max_cost_usd_per_change"),
      t("c", "blocked", ["b"]),
      t("d", "blocked", ["c"]),
    ];
    expect(restoreAfterBudgetRaise(g)).toEqual({ ready: ["b"], pending: ["c", "d"] });
  });

  it("keeps Tasks below a failed or dead-lettered Task blocked", () => {
    const g = [
      t("a", "failed"),
      t("b", "blocked", ["a"]),
      t("x", "blocked", [], "dead_letter"),
      t("y", "blocked", ["x"]),
      t("s", "blocked", [], "daily_model_calls"),
      t("z", "blocked", ["s", "a"]),
    ];
    expect(restoreAfterBudgetRaise(g)).toEqual({ ready: ["s"], pending: [] });
  });

  it("restores nothing that is not blocked, and is stable on a repeat", () => {
    const g = [t("a", "running"), t("b", "pending", ["a"]), t("c", "cancelled")];
    expect(restoreAfterBudgetRaise(g)).toEqual({ ready: [], pending: [] });
    const once = [t("a", "completed"), t("b", "ready", ["a"]), t("c", "pending", ["b"])];
    expect(restoreAfterBudgetRaise(once)).toEqual({ ready: [], pending: [] });
  });
});
