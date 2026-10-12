// Release safety: security and browser Evidence pass only when the guarded behavior was observed.
// A run that matched no authorization test, or a browser run that could not reach the app, is a
// gap, never a pass.
import { buildVerificationPlan, gateRequiredChecks } from "@rhumbatron/evidence";
import type { EvidenceRecord } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, isAllowedCheckCommand } from "./candidate-composer.ts";
import {
  type BrowserRun,
  type BrowserStep,
  classifyBrowser,
  classifySecurity,
  parseBunTestCounts,
} from "./check-semantics.ts";

const plan = buildVerificationPlan({
  candidateId: "cand_s",
  riskTier: "high",
  policy: DEFAULT_POLICY,
  touches: { authorization: true, performanceConstraint: false, protectedInvariants: [], ui: true },
});
const security = plan.checks.find((c) => c.kind === "security");
if (!security) throw new Error("plan has no security check");
const run = (exitCode: number | null, output: string) => ({ exitCode, output, timedOut: false });

// Real Bun 1.3 output shapes.
const MATCHED =
  " 3 pass\n 12 filtered out\n 0 fail\n 5 expect() calls\nRan 3 tests across 2 files.";
const NO_MATCH =
  'error: regex "authorization" matched 0 tests. Searched 4 files (skipping 15 tests) [7.00ms]';
const ALL_SKIPPED = " 0 pass\n 2 skip\n 0 fail\nRan 2 tests across 1 file.";
const ONE_FAILED =
  "(fail) wishlist authorization > revoked link denies writes\n 2 pass\n 12 filtered out\n 1 fail";

describe("security check", () => {
  it("its command is on the Sandbox allow-list", () => {
    expect(isAllowedCheckCommand(security.command ?? "")).toBe(true);
  });

  it("0 authorization tests matched is checked_no_signal: a gap, never a pass", () => {
    for (const r of [run(1, NO_MATCH), run(0, ALL_SKIPPED), run(0, "")]) {
      const outcome = classifySecurity(security, r);
      expect(outcome.status).not.toBe("pass");
      expect(outcome.coverage).toBe("checked_no_signal");
      expect(outcome.metrics?.authorizationTestsRun).toBe(0);
    }
    expect(parseBunTestCounts(NO_MATCH).noMatch).toBe(true);
  });

  it("exit 0 with at least one executed authorization test is checked_supported pass", () => {
    expect(classifySecurity(security, run(0, MATCHED))).toMatchObject({
      status: "pass",
      coverage: "checked_supported",
      metrics: { authorizationTestsRun: 3, authorizationTestsPassed: 3, testsFilteredOut: 12 },
    });
  });

  it("a failed authorization test or a non-zero exit fails", () => {
    expect(classifySecurity(security, run(1, ONE_FAILED))).toMatchObject({
      status: "fail",
      coverage: "checked_supported",
      metrics: { authorizationTestsFailed: 1 },
    });
    expect(classifySecurity(security, run(1, MATCHED)).status).toBe("fail");
  });

  it("a timeout or Sandbox error did not run", () => {
    expect(
      classifySecurity(security, { exitCode: null, output: "", timedOut: true }).coverage,
    ).toBe("not_checked");
    expect(
      classifySecurity(security, { exitCode: null, output: "", timedOut: false, error: "lost" })
        .coverage,
    ).toBe("not_checked");
  });
});

const pass = (name: string): BrowserStep => ({ name, ok: true, ms: 10 });
const ran = (steps: BrowserStep[], over: Partial<Extract<BrowserRun, { kind: "ran" }>> = {}) =>
  ({
    kind: "ran",
    scenario: "wishlist",
    steps,
    total: 3,
    deadlineHit: false,
    screenshots: 2,
    sessionMs: 20_000,
    ...over,
  }) as const;

describe("browser check", () => {
  it("only a complete run with every step passing is a pass, with k/N metrics", () => {
    expect(classifyBrowser(ran([pass("a"), pass("b"), pass("c")]))).toMatchObject({
      status: "pass",
      coverage: "checked_supported",
      metrics: { stepsPassed: 3, stepsTotal: 3, screenshots: 2, browserSeconds: 20 },
    });
  });

  it("refused budget, missing preview, failed launch, deadline, or infra failure is a gap", () => {
    const infra: BrowserStep = {
      name: "b",
      ok: false,
      failure: { kind: "infra", detail: "proxy" },
      ms: 1,
    };
    const runs: BrowserRun[] = [
      { kind: "refused", reason: "daily guard" },
      { kind: "no_preview", detail: "port not ready" },
      { kind: "launch_failed", detail: "429" },
      ran([pass("a"), pass("b")], { deadlineHit: true }),
      ran([pass("a"), infra]),
      ran([pass("a"), pass("b")]),
      ran([], { total: 0 }),
    ];
    for (const r of runs) {
      const outcome = classifyBrowser(r);
      expect(outcome.status).not.toBe("pass");
      expect(outcome.coverage).toBe("not_checked");
    }
  });

  it("a step that observed wrong app behavior fails with checked_supported", () => {
    const denied: BrowserStep = {
      name: "later collaborator write is denied",
      ok: false,
      failure: { kind: "assert", detail: "write after revoke returned 200" },
      ms: 5,
    };
    expect(classifyBrowser(ran([pass("a"), denied]))).toMatchObject({
      status: "fail",
      coverage: "checked_supported",
      metrics: { stepsPassed: 1, stepsTotal: 3 },
    });
  });

  it("a gap from a refused browser run blocks promotion", () => {
    const outcome = classifyBrowser({ kind: "refused", reason: "2 runs used" });
    const evidence: EvidenceRecord[] = plan.requiredCheckIds.map((checkId) => ({
      evidenceId: `ev_${checkId}`,
      candidateId: "cand_s",
      checkId,
      kind: checkId,
      startedAt: "2026-10-09T10:00:00.000Z",
      completedAt: "2026-10-09T10:00:10.000Z",
      contentHash: "sha256:x",
      sourceRefs: [],
      ...(checkId === "browser"
        ? { status: outcome.status, coverage: outcome.coverage, summary: outcome.summary }
        : { status: "pass", coverage: "checked_supported", summary: "ok" }),
    }));
    expect(gateRequiredChecks(plan, evidence)).toEqual({
      promotable: false,
      gaps: [{ checkId: "browser", reason: "skipped" }],
    });
  });
});
