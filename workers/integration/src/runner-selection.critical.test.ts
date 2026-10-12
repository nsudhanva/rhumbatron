import type { AppCheckResult, VerificationCheck } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import {
  evaluateAppCheckOutcome,
  evaluateContractAppCheck,
  isAppCheckerEligible,
} from "./runner-selection.ts";

describe("runner selection eligibility", () => {
  it("routes build, unit and contract checks to AppChecker in prod (when APPS binding is present)", () => {
    const checks: Pick<VerificationCheck, "kind" | "checkId">[] = [
      { checkId: "build", kind: "build" },
      { checkId: "unit", kind: "unit" },
      { checkId: "contract", kind: "contract" },
    ];
    for (const check of checks) {
      expect(isAppCheckerEligible(check, true)).toBe(true);
    }
  });

  it("routes performance, browser, security, and Cart invariant checks to Sandbox even in prod", () => {
    const sandboxChecks: Pick<VerificationCheck, "kind" | "checkId">[] = [
      { checkId: "performance", kind: "performance" },
      { checkId: "browser", kind: "browser" },
      { checkId: "security", kind: "security" },
      { checkId: "protected-invariant-cart", kind: "protected-invariant" },
      { checkId: "protected-invariant-1", kind: "protected-invariant" },
    ];
    for (const check of sandboxChecks) {
      expect(isAppCheckerEligible(check, true)).toBe(false);
    }
  });

  it("routes all checks to Sandbox in dev (when APPS binding is absent)", () => {
    const allChecks: Pick<VerificationCheck, "kind" | "checkId">[] = [
      { checkId: "build", kind: "build" },
      { checkId: "unit", kind: "unit" },
      { checkId: "contract", kind: "contract" },
      { checkId: "performance", kind: "performance" },
      { checkId: "browser", kind: "browser" },
      { checkId: "security", kind: "security" },
      { checkId: "protected-invariant-cart", kind: "protected-invariant" },
    ];
    for (const check of allChecks) {
      expect(isAppCheckerEligible(check, false)).toBe(false);
    }
  });
});

describe("app check outcome evaluation and fallback", () => {
  const baseResult: AppCheckResult = {
    kind: "unit",
    status: "pass",
    coverage: "checked_supported",
    supported: true,
    summary: "12 passed",
    exitCode: 0,
    output: "12 pass",
    timedOut: false,
    passed: 12,
    failed: 0,
    failures: [],
    startedAt: "2026-10-10T12:00:00Z",
    completedAt: "2026-10-10T12:00:01Z",
  };

  it("accepts supported passes without sandbox fallback", () => {
    const disposition = evaluateAppCheckOutcome("unit", baseResult);
    expect(disposition).toEqual({
      handled: true,
      runner: "dynamic-worker",
      outcome: {
        status: "pass",
        coverage: "checked_supported",
        summary: "12 passed",
      },
    });
  });

  it("retains completed assertion failures without sandbox fallback", () => {
    const failedResult: AppCheckResult = {
      ...baseResult,
      status: "fail",
      coverage: "not_checked",
      supported: true,
      summary: "11 pass, 1 fail",
      exitCode: 1,
      passed: 11,
      failed: 1,
      failures: [{ name: "cart total", message: "expected 10 to be 20" }],
    };
    const disposition = evaluateAppCheckOutcome("unit", failedResult);
    expect(disposition).toEqual({
      handled: true,
      runner: "dynamic-worker",
      outcome: {
        status: "fail",
        coverage: "not_checked",
        summary: "11 pass, 1 fail",
      },
    });
  });

  it("falls back to Sandbox when supported is false (unsupported APIs, bundler error, empty tests, timeout)", () => {
    for (const reason of [
      "Unsupported test API: toBeGreaterThanOrEqual",
      "Check bundle exceeds 10 MB.",
      "A test file registered no tests. Missing tests are a gap.",
      "Check timed out",
    ]) {
      const unsupported: AppCheckResult = {
        ...baseResult,
        status: "error",
        coverage: "not_checked",
        supported: false,
        summary: reason,
        exitCode: null,
      };
      const disposition = evaluateAppCheckOutcome("unit", unsupported);
      expect(disposition).toEqual({
        handled: false,
        runner: "sandbox",
        fallbackReason: reason,
      });
    }
  });

  it("ensures a not_checked result NEVER becomes a pass", () => {
    const malformed: AppCheckResult = {
      ...baseResult,
      status: "pass",
      coverage: "not_checked",
      supported: false,
    };
    // If supported: false, it never passes: it falls back to sandbox
    const disp = evaluateAppCheckOutcome("unit", malformed);
    expect(disp.handled).toBe(false);

    // If an invalid result has supported: true and coverage: not_checked with status pass,
    // the evaluator must refuse to emit a pass
    const invalidSupported: AppCheckResult = {
      ...baseResult,
      status: "pass",
      coverage: "not_checked",
      supported: true,
    };
    const evaluated = evaluateAppCheckOutcome("unit", invalidSupported);
    expect(evaluated.handled).toBe(true);
    if (!evaluated.handled) return;
    expect(evaluated.outcome).toMatchObject({ status: "error", coverage: "not_checked" });
  });
});

describe("contract check evaluation", () => {
  const candidateSupported: AppCheckResult = {
    kind: "contract",
    status: "pass",
    coverage: "checked_supported",
    supported: true,
    summary: "2 routes extracted",
    exitCode: 0,
    output: JSON.stringify({ routes: ["GET /api/cart", "POST /api/cart"] }),
    timedOut: false,
    passed: 0,
    failed: 0,
    failures: [],
    startedAt: "2026-10-10T12:00:00Z",
    completedAt: "2026-10-10T12:00:01Z",
  };

  const baseSupported: AppCheckResult = {
    ...candidateSupported,
    output: JSON.stringify({ routes: ["GET /api/cart"] }),
  };

  it("handles contract extraction in dynamic-worker when both candidate and base are supported", () => {
    // Declared POST /api/cart
    const disposition = evaluateContractAppCheck(candidateSupported, baseSupported, [
      "POST /api/cart",
    ]);
    expect(disposition).toMatchObject({
      handled: true,
      runner: "dynamic-worker",
      outcome: {
        status: "pass",
        coverage: "checked_supported",
      },
    });
  });

  it("handles contract extraction when base is null (empty repo with no app)", () => {
    const disposition = evaluateContractAppCheck(candidateSupported, null, [
      "GET /api/cart",
      "POST /api/cart",
    ]);
    expect(disposition).toMatchObject({
      handled: true,
      runner: "dynamic-worker",
      outcome: {
        status: "pass",
        coverage: "checked_supported",
      },
    });
  });

  it("fails contract check when an undeclared route is added", () => {
    const disposition = evaluateContractAppCheck(candidateSupported, baseSupported, []);
    expect(disposition).toMatchObject({
      handled: true,
      runner: "dynamic-worker",
      outcome: {
        status: "fail",
        coverage: "checked_supported",
      },
    });
  });

  it("falls back to Sandbox when candidate extraction is unsupported", () => {
    const unsupportedCandidate: AppCheckResult = {
      ...candidateSupported,
      supported: false,
      summary: "No valid Hono route table.",
    };
    const disposition = evaluateContractAppCheck(unsupportedCandidate, baseSupported, []);
    expect(disposition).toEqual({
      handled: false,
      runner: "sandbox",
      fallbackReason: "No valid Hono route table.",
    });
  });

  it("falls back to Sandbox when base extraction is unsupported", () => {
    const unsupportedBase: AppCheckResult = {
      ...baseSupported,
      supported: false,
      summary: "Base contract script failed.",
    };
    const disposition = evaluateContractAppCheck(candidateSupported, unsupportedBase, []);
    expect(disposition).toEqual({
      handled: false,
      runner: "sandbox",
      fallbackReason: "Base contract script failed.",
    });
  });
});
