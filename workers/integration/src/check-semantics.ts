import type { VerificationCheck } from "@rhumbatron/protocol";
import type { CheckOutcome, CheckRun } from "./candidate-composer.ts";

/**
 * Result semantics of the security and browser checks (AGENTS.md sections 34.4.1, 35). Pure: no
 * I/O, so the rules have critical tests. A check that did not observe the behavior it guards is a
 * gap (`not_checked` or `checked_no_signal`), never a pass.
 */

// --- Security check (P10-10) ---------------------------------------------------------------

export type BunTestCounts = {
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  /** Tests the name filter excluded. They did not run. */
  filteredOut: number;
  /** Bun reported that the name filter matched no test (it exits 1). */
  noMatch: boolean;
};

const count = (output: string, label: string) =>
  Number(new RegExp(`^\\s*(\\d+) ${label}\\b`, "m").exec(output)?.[1] ?? 0);

/** Reads the summary block that `bun test` prints (Bun 1.3). Missing lines count as zero. */
export function parseBunTestCounts(output: string): BunTestCounts {
  return {
    passed: count(output, "pass"),
    failed: count(output, "fail"),
    skipped: count(output, "skip"),
    todo: count(output, "todo"),
    filteredOut: count(output, "filtered out"),
    noMatch: /matched 0 tests/.test(output),
  };
}

function tail(output: string, lines = 4, chars = 400) {
  const text = output.trim().split("\n").slice(-lines).join(" | ");
  return text.length > chars ? text.slice(-chars) : text;
}

/**
 * Security Evidence from `bun test --test-name-pattern authorization`:
 *
 * - timeout, Sandbox error, or no exit code: `not_checked`. The check did not run.
 * - no authorization test executed (filter matched nothing, or every match skipped or todo):
 *   `checked_no_signal`. Nothing proved that denied actions stay denied. A gap, never a pass.
 * - any executed authorization test failed, or a non-zero exit: `fail`, `checked_supported`.
 * - exit 0 and at least one authorization test passed: `pass`, `checked_supported`.
 */
export function classifySecurity(check: VerificationCheck, run: CheckRun): CheckOutcome {
  if (run.timedOut) {
    return {
      status: "error",
      coverage: "not_checked",
      summary: `Timed out after ${Math.round(check.timeoutMs / 1000)} s. A timeout is not a pass.`,
    };
  }
  if (run.error !== undefined || run.exitCode === null) {
    return {
      status: "error",
      coverage: "not_checked",
      summary: `Did not run: ${(run.error ?? "no exit code").slice(0, 200)}`,
    };
  }
  const c = parseBunTestCounts(run.output);
  const executed = c.passed + c.failed;
  const metrics = {
    authorizationTestsRun: executed,
    authorizationTestsPassed: c.passed,
    authorizationTestsFailed: c.failed,
    authorizationTestsSkipped: c.skipped + c.todo,
    testsFilteredOut: c.filteredOut,
  };
  if (executed === 0) {
    const why = c.noMatch
      ? "no test name matches the authorization pattern"
      : c.skipped + c.todo > 0
        ? `${c.skipped + c.todo} authorization tests are skipped or todo`
        : "no authorization test ran";
    return {
      status: "error",
      coverage: "checked_no_signal",
      summary: `exit ${run.exitCode}: ${why}. No authorization Evidence: a gap, never a pass.`,
      metrics,
    };
  }
  const ok = run.exitCode === 0 && c.failed === 0;
  return {
    status: ok ? "pass" : "fail",
    coverage: "checked_supported",
    summary: ok
      ? `${c.passed} authorization tests pass.`
      : `exit ${run.exitCode}: ${c.passed} pass, ${c.failed} fail. ${tail(run.output)}`,
    metrics,
  };
}

// --- Browser check (P10-11) ----------------------------------------------------------------

/** One browser session per check, at most this long (Browser Run free timeout is 60 s). */
export const BROWSER_SESSION_MS = 55_000;
/** Section 44: max full browser verification runs per Candidate. */
export const MAX_BROWSER_RUNS_PER_CANDIDATE = 2;
/**
 * Daily Browser Run guard when the `BROWSER_DAILY_SECONDS` binding is absent or invalid: a safe
 * value below prod's. Prod sets the binding from Terraform `browser_daily_seconds = 960`
 * (envs/prod, ADR 0017: 80 % of the included 10 browser hours per month).
 */
export const BROWSER_DAILY_SECONDS = 500;
/** Seconds reserved before a session opens; settled to the real duration after it closes. */
export const BROWSER_RESERVATION_SECONDS = 60;

export type BrowserStep = {
  name: string;
  ok: boolean;
  /** `assert`: the app did not behave as specified. `infra`: the run could not observe it. */
  failure?: { kind: "assert" | "infra"; detail: string };
  ms: number;
};

/** Wishlist UI flow, Wishlist API flow from the page (no UI yet), or the minimal cart flow. */
export type BrowserScenario = "wishlist" | "wishlist-api" | "cart" | "app";

export type BrowserRun =
  | { kind: "refused"; reason: string }
  | { kind: "no_preview"; detail: string }
  | { kind: "launch_failed"; detail: string }
  | {
      kind: "ran";
      scenario: BrowserScenario;
      steps: BrowserStep[];
      /** Steps the scenario defines; steps after a failure never ran. */
      total: number;
      deadlineHit: boolean;
      screenshots: number;
      sessionMs: number;
    };

/**
 * Browser Evidence (section 35). Only a complete run with every scenario step observed passing is
 * a pass. A refused budget, a missing preview, a failed launch, the session deadline, or an
 * infrastructure failure inside the run is `not_checked`: a gap, never a pass. A step that
 * observed wrong app behavior is a `fail`.
 */
export function classifyBrowser(run: BrowserRun): CheckOutcome {
  if (run.kind === "refused") {
    return { status: "skipped", coverage: "not_checked", summary: `Not run: ${run.reason}` };
  }
  if (run.kind === "no_preview") {
    return {
      status: "error",
      coverage: "not_checked",
      summary: `No Candidate preview: ${run.detail.slice(0, 200)}. A gap, never a pass.`,
    };
  }
  if (run.kind === "launch_failed") {
    return {
      status: "error",
      coverage: "not_checked",
      summary: `Browser Run did not start: ${run.detail.slice(0, 200)}. A gap, never a pass.`,
    };
  }
  const passed = run.steps.filter((s) => s.ok).length;
  const metrics = {
    stepsPassed: passed,
    stepsTotal: run.total,
    screenshots: run.screenshots,
    browserSeconds: Math.ceil(run.sessionMs / 1000),
  };
  const ratio = `${passed}/${run.total} steps`;
  const failed = run.steps.find((s) => !s.ok);
  if (failed?.failure?.kind === "assert") {
    return {
      status: "fail",
      coverage: "checked_supported",
      summary:
        `${run.scenario} flow: ${ratio}; "${failed.name}" failed: ${failed.failure.detail}`.slice(
          0,
          500,
        ),
      metrics,
    };
  }
  if (run.deadlineHit || failed || passed < run.total || run.total === 0) {
    const why = run.deadlineHit
      ? `session deadline (${Math.round(BROWSER_SESSION_MS / 1000)} s) reached`
      : failed
        ? `"${failed.name}" could not run: ${failed.failure?.detail ?? "unknown"}`
        : "not every step ran";
    return {
      status: "error",
      coverage: "not_checked",
      summary: `${run.scenario} flow: ${ratio}; ${why}. A gap, never a pass.`.slice(0, 500),
      metrics,
    };
  }
  return {
    status: "pass",
    coverage: "checked_supported",
    summary: `${run.scenario} flow: ${ratio} pass in ${metrics.browserSeconds} s.`,
    metrics,
  };
}
