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
  releaseRecovery,
  restoreAfterBudgetRaise,
  TERMINAL_CHANGE_STATUSES,
  verificationHalt,
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

  it("releases only with a live app, and completes otherwise as before", () => {
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

describe("releaseRecovery (HOM-204)", () => {
  const promotedAt = "2026-10-09T10:00:00.000Z";
  const at = (minutes: number) => Date.parse(promotedAt) + minutes * 60_000;
  const recover = (
    minutes: number,
    release: {
      status: "queued" | "building" | "deployed" | "failed" | "smoke_failed" | "superseded";
      startedAt: string;
    } | null,
    hasLiveApp = true,
  ) => releaseRecovery({ hasLiveApp, release, releasingSince: promotedAt, now: at(minutes) });

  it("waits while a release can still be live", () => {
    expect(recover(44, null).kind).toBe("wait");
    expect(recover(44, { status: "building", startedAt: promotedAt }).kind).toBe("wait");
    // A release that a promotion retry started later is measured from its own start.
    expect(recover(60, { status: "queued", startedAt: "2026-10-09T10:30:00.000Z" }).kind).toBe(
      "wait",
    );
  });

  it("fails an in-flight release, records an unstarted one, and completes without a target", () => {
    for (const [decided, kind] of [
      [recover(46, { status: "building", startedAt: promotedAt }), "fail_release"],
      [recover(46, { status: "queued", startedAt: promotedAt }), "fail_release"],
      [recover(46, null), "fail_unstarted"],
      [recover(46, null, false), "complete"],
    ] as const) {
      expect(decided.kind).toBe(kind);
      expect("reason" in decided && decided.reason.length > 0).toBe(true);
    }
  });

  it("settles a finished release at once, as the release ended", () => {
    expect(recover(1, { status: "deployed", startedAt: promotedAt })).toEqual({
      kind: "settle",
      change: "completed",
    });
    expect(recover(1, { status: "superseded", startedAt: promotedAt })).toEqual({
      kind: "settle",
      change: "completed",
    });
    expect(recover(1, { status: "smoke_failed", startedAt: promotedAt })).toEqual({
      kind: "settle",
      change: "failed",
    });
  });

  it("treats an unparseable timestamp as old, so a bad row cannot hold a Change", () => {
    expect(
      releaseRecovery({ hasLiveApp: true, release: null, releasingSince: "nope", now: at(0) }).kind,
    ).toBe("fail_unstarted");
  });
});

describe("verificationHalt (HOM-204)", () => {
  it("stops on a cancelled Change before anything else", () => {
    expect(verificationHalt("cancelled", "verifying")).toBe("change_cancelled");
    expect(verificationHalt("cancelled", "rejected")).toBe("change_cancelled");
  });

  it("stops on a final or missing Candidate and continues otherwise", () => {
    for (const status of ["rejected", "stale", "promoted", null]) {
      expect(verificationHalt("verifying", status)).toBe("candidate_final");
    }
    for (const status of ["composing", "verifying"]) {
      expect(verificationHalt("verifying", status)).toBeNull();
      expect(verificationHalt("running", status)).toBeNull();
    }
  });
});
