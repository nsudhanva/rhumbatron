import type { AppCheckResult, VerificationCheck } from "@rhumbatron/protocol";
import { type CheckOutcome, classifyContract } from "./candidate-composer.ts";

export type CheckRunner = "dynamic-worker" | "sandbox";

/**
 * Checks eligible to run in Dynamic Workers via AppChecker:
 * - build
 * - unit
 * - contract
 *
 * Performance (benchmarks), Browser (sessions), Security (pattern-matched tests),
 * and Cart invariants (specific invariant test file) require Sandbox execution.
 * When the APPS service binding is absent (local development or a test), all checks use Sandbox.
 */
export function isAppCheckerEligible(
  check: Pick<VerificationCheck, "kind" | "checkId">,
  hasAppsBinding: boolean,
): boolean {
  if (!hasAppsBinding) return false;
  if (check.checkId === "protected-invariant-cart") return false;
  return check.kind === "build" || check.kind === "unit" || check.kind === "contract";
}

/** Pure function to determine initial runner for a check. */
export function initialRunnerForCheck(
  check: Pick<VerificationCheck, "kind" | "checkId">,
  hasAppsBinding: boolean,
): CheckRunner {
  return isAppCheckerEligible(check, hasAppsBinding) ? "dynamic-worker" : "sandbox";
}

export type AppCheckDisposition =
  | { handled: true; runner: "dynamic-worker"; outcome: CheckOutcome }
  | { handled: false; runner: "sandbox"; fallbackReason: string };

/**
 * Evaluates the outcome of an AppChecker run for build or unit checks.
 *
 * Rules (AGENTS.md 34.4.1, ADR 0020):
 * 1. supported: false -> Unsupported (missing runner, API, bundler error, timeout). Falls back to Sandbox.
 * 2. supported: true, status: "pass" -> Positive pass with checked_supported coverage.
 * 3. supported: true, status: "fail" -> Completed assertion failure. Retained as fail (not_checked),
 *    and MUST NOT fall back or be retried into a pass.
 * 4. A not_checked coverage is never a pass.
 */
export function evaluateAppCheckOutcome(
  _kind: string,
  result: AppCheckResult,
): AppCheckDisposition {
  if (!result.supported) {
    return {
      handled: false,
      runner: "sandbox",
      fallbackReason: result.summary || "AppChecker check unsupported",
    };
  }

  // AGENTS.md 34.4.1 invariant: not_checked can never be a pass.
  let status = result.status;
  let coverage = result.coverage;

  // A pass without supported coverage did not prove anything: it is an error, never a pass.
  if (status === "pass" && coverage !== "checked_supported") {
    status = "error";
    coverage = "not_checked";
  }

  return {
    handled: true,
    runner: "dynamic-worker",
    outcome: {
      status,
      coverage,
      summary: result.summary,
    },
  };
}

/**
 * Evaluates the contract check result using AppChecker extractions from candidate and base.
 * Calls classifyContract to compare route tables against declared expected changes.
 */
export function evaluateContractAppCheck(
  candidateResult: AppCheckResult,
  baseResult: AppCheckResult | null,
  declared: string[],
): AppCheckDisposition {
  if (!candidateResult.supported) {
    return {
      handled: false,
      runner: "sandbox",
      fallbackReason: candidateResult.summary || "Candidate contract extraction unsupported",
    };
  }

  if (baseResult !== null && !baseResult.supported) {
    return {
      handled: false,
      runner: "sandbox",
      fallbackReason: baseResult.summary || "Base contract extraction unsupported",
    };
  }

  const candidateRun = {
    exitCode: candidateResult.exitCode,
    output: candidateResult.output,
    timedOut: candidateResult.timedOut,
  };

  const baseRun = baseResult
    ? {
        exitCode: baseResult.exitCode,
        output: baseResult.output,
        timedOut: baseResult.timedOut,
      }
    : null;

  const outcome = classifyContract(baseRun, candidateRun, declared);

  // Invariant: not_checked can never be a pass.
  if (outcome.coverage === "not_checked" && outcome.status === "pass") {
    outcome.status = "error";
  }

  return {
    handled: true,
    runner: "dynamic-worker",
    outcome,
  };
}

/**
 * Determines whether any check in the verification plan requires Sandbox container execution.
 * Returns true if:
 * - Any check is not eligible for AppChecker (performance, security, browser, cart invariant, no APPS binding)
 * - Any eligible check returned supported: false (fallback needed)
 */
export function planNeedsSandbox(
  checks: readonly Pick<VerificationCheck, "kind" | "checkId">[],
  hasAppsBinding: boolean,
  appCheckResults?: ReadonlyMap<string, AppCheckResult>,
): boolean {
  for (const check of checks) {
    // The acceptance check is a model call in the integration Worker: no Sandbox.
    if (check.kind === "acceptance") continue;
    if (!isAppCheckerEligible(check, hasAppsBinding)) {
      return true;
    }
    const result = appCheckResults?.get(check.checkId);
    if (result && !result.supported) {
      return true;
    }
  }
  return false;
}
