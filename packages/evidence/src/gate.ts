import type { EvidenceRecord, VerificationPlan } from "@rhumbatron/protocol";

/**
 * Required-check gate (AGENTS.md section 34.4.1). A missing result is not a negative result, and a
 * timeout is not a pass: only `checked_supported` Evidence with status `pass` satisfies a check.
 */

export type GapReason =
  | "missing"
  | "not_checked"
  | "no_signal"
  | "failed"
  | "error"
  | "skipped"
  | "timed_out"
  | "expectation_not_met";

export type CheckGap = { checkId: string; reason: GapReason };

export type GateResult = { promotable: boolean; gaps: CheckGap[] };

function durationMs(e: EvidenceRecord): number {
  return Date.parse(e.completedAt) - Date.parse(e.startedAt);
}

function isPass(e: EvidenceRecord): boolean {
  return e.status === "pass" && e.coverage === "checked_supported";
}

/** Latest record by completion time. On a tie, a non-passing record wins. */
function latest(records: readonly EvidenceRecord[]): EvidenceRecord | undefined {
  return [...records].sort(
    (a, b) =>
      Date.parse(b.completedAt) - Date.parse(a.completedAt) ||
      Number(isPass(a)) - Number(isPass(b)),
  )[0];
}

function gapFor(
  plan: VerificationPlan,
  checkId: string,
  records: readonly EvidenceRecord[],
): GapReason | null {
  const record = latest(records);
  if (!record) return "missing";
  const check = plan.checks.find((c) => c.checkId === checkId);
  const elapsed = durationMs(record);
  if (check && !(elapsed >= 0 && elapsed <= check.timeoutMs)) return "timed_out";
  if (record.status === "skipped") return "skipped";
  if (record.status === "error") return "error";
  if (record.status === "fail") return "failed";
  if (record.coverage === "not_checked") return "not_checked";
  if (record.coverage === "checked_no_signal") return "no_signal";
  if (check?.expected.kind === "metric_below") {
    const value = record.metrics?.[check.expected.metric];
    if (value === undefined || !Number.isFinite(value) || value >= check.expected.threshold) {
      return "expectation_not_met";
    }
  }
  return null;
}

export function gateRequiredChecks(
  plan: VerificationPlan,
  evidence: readonly EvidenceRecord[],
): GateResult {
  const required = new Set([
    ...plan.requiredCheckIds,
    ...plan.checks.filter((c) => c.required).map((c) => c.checkId),
  ]);
  const gaps: CheckGap[] = [];
  for (const checkId of required) {
    const records = evidence.filter(
      (e) => e.candidateId === plan.candidateId && e.checkId === checkId,
    );
    const reason = gapFor(plan, checkId, records);
    if (reason) gaps.push({ checkId, reason });
  }
  return { promotable: gaps.length === 0, gaps };
}
