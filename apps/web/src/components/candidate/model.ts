import type { CandidateDetail, EvidenceRecord, VerificationCheck } from "../../lib/api";
import { formatMs, generation } from "../../lib/format";

/**
 * Deterministic read model for Candidate pages (AGENTS.md sections 34.4.1, 36, 38.4). Everything
 * here is derived from the plan, the Evidence rows and the gate; nothing uses model confidence.
 * The gate rules mirror `packages/evidence/src/gate.ts`: only a `checked_supported` pass within
 * the timeout (and under the threshold for a metric check) satisfies a check.
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

export type CheckVerdict = "pass" | "fail" | "gap" | "pending";

export type CheckRow = {
  checkId: string;
  kind: string;
  check: VerificationCheck | undefined;
  record: EvidenceRecord | undefined;
  required: boolean;
  verdict: CheckVerdict;
  /** Why the check is not satisfied; null for a pass or while pending. */
  reason: GapReason | null;
};

const ACTIVE_STATUSES = new Set<CandidateDetail["status"]>(["composing", "composed", "verifying"]);

export const isActive = (candidate: CandidateDetail) => ACTIVE_STATUSES.has(candidate.status);

/** Verification is over: the gate ran, or the Candidate reached a final state without it. */
export const isFinished = (candidate: CandidateDetail) =>
  candidate.gate !== null ||
  ["verified", "rejected", "stale", "promoted"].includes(candidate.status);

const isPass = (e: EvidenceRecord) => e.status === "pass" && e.coverage === "checked_supported";

/** Latest record by completion time; on a tie a non-passing record wins (same as the gate). */
function latest(records: EvidenceRecord[]): EvidenceRecord | undefined {
  return [...records].sort(
    (a, b) =>
      Date.parse(b.completedAt) - Date.parse(a.completedAt) ||
      Number(isPass(a)) - Number(isPass(b)),
  )[0];
}

export function durationMs(record: EvidenceRecord): number | null {
  const ms = Date.parse(record.completedAt) - Date.parse(record.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function localReason(
  check: VerificationCheck | undefined,
  record: EvidenceRecord | undefined,
): GapReason | null {
  if (!record) return "missing";
  const elapsed = durationMs(record);
  if (check && (elapsed === null || elapsed > check.timeoutMs)) return "timed_out";
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

const FAIL_REASONS = new Set<GapReason>(["failed", "expectation_not_met"]);

/** Plain words for a gap reason, used in rows, banners and the "Why" paragraph. */
export const REASON_WORDS: Record<GapReason, string> = {
  missing: "no evidence recorded",
  not_checked: "not checked",
  no_signal: "ran with no signal",
  failed: "failed",
  error: "errored without a result",
  skipped: "not automated yet",
  timed_out: "timed out",
  expectation_not_met: "over the threshold",
};

export const COVERAGE_WORDS: Record<EvidenceRecord["coverage"], string> = {
  checked_supported: "checked, supported",
  checked_no_signal: "ran, no signal",
  not_checked: "not checked",
};

/** Pill status for a verdict (StatusPill vocabulary). A gap is attention, never green. */
export const VERDICT_STATUS: Record<CheckVerdict, string> = {
  pass: "pass",
  fail: "fail",
  gap: "gap",
  pending: "queued",
};

const KIND_ORDER = [
  "composition",
  "build",
  "unit",
  "contract",
  "protected-invariant",
  "performance",
  "security",
  "browser",
  "acceptance",
];

const kindRank = (kind: string) => {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
};

/**
 * One row per planned check, plus Evidence outside the plan (for example a composition failure
 * before any check ran). The gate's recorded gap reasons win over the local mirror.
 */
export function checkRows(candidate: CandidateDetail, evidence: EvidenceRecord[]): CheckRow[] {
  const finished = isFinished(candidate);
  const plan = candidate.plan;
  const required = new Set([
    ...(plan?.requiredCheckIds ?? []),
    ...(plan?.checks.filter((c) => c.required).map((c) => c.checkId) ?? []),
  ]);
  const gateGaps = new Map((candidate.gate?.gaps ?? []).map((g) => [g.checkId, g.reason]));
  const byCheck = new Map<string, EvidenceRecord[]>();
  for (const e of evidence) byCheck.set(e.checkId, [...(byCheck.get(e.checkId) ?? []), e]);

  const row = (
    checkId: string,
    kind: string,
    check: VerificationCheck | undefined,
    isRequired: boolean,
  ): CheckRow => {
    const record = latest(byCheck.get(checkId) ?? []);
    const gated = candidate.gate && gateGaps.has(checkId);
    let reason: GapReason | null = gated
      ? ((gateGaps.get(checkId) as GapReason | undefined) ?? "missing")
      : localReason(check, record);
    // A required check the finished gate did not flag is satisfied (the gate is authoritative).
    if (candidate.gate && isRequired && !gated && record) reason = null;
    let verdict: CheckVerdict;
    if (!record && !finished && !gated) {
      verdict = "pending";
      reason = null;
    } else if (reason === null) verdict = "pass";
    else verdict = FAIL_REASONS.has(reason) ? "fail" : "gap";
    return { checkId, kind, check, record, required: isRequired, verdict, reason };
  };

  const planned = new Set(plan?.checks.map((c) => c.checkId) ?? []);
  const extra = [...byCheck.keys()]
    .filter((id) => !planned.has(id))
    .map((id) => {
      const kind = latest(byCheck.get(id) ?? [])?.kind ?? id;
      return row(id, kind, undefined, true);
    });
  const rows = [
    ...extra,
    ...(plan?.checks ?? []).map((c) => row(c.checkId, c.kind, c, required.has(c.checkId))),
  ];
  return rows.sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
}

export function requiredTally(rows: CheckRow[]) {
  const required = rows.filter((r) => r.required);
  return {
    met: required.filter((r) => r.verdict === "pass").length,
    total: required.length,
    failed: required.filter((r) => r.verdict === "fail"),
    gaps: required.filter((r) => r.verdict === "gap"),
    pending: required.filter((r) => r.verdict === "pending"),
  };
}

/** The p95 budget from the plan's performance check (section 54 default: 200 ms). */
export function p95Budget(candidate: CandidateDetail): number | null {
  const check = candidate.plan?.checks.find((c) => c.expected.kind === "metric_below");
  return check?.expected.kind === "metric_below" ? check.expected.threshold : null;
}

export function p95Of(candidate: CandidateDetail, rows: CheckRow[]): number | null {
  if (candidate.gate?.p95Ms !== undefined) return candidate.gate.p95Ms;
  const value = rows.find((r) => r.kind === "performance")?.record?.metrics?.p95Ms;
  return value === undefined ? null : value;
}

export const formatP95 = (ms: number | null | undefined) =>
  formatMs(ms, ms !== null && ms !== undefined && Math.abs(ms) < 10 ? 1 : 0);

/** A shared meter scale so bars in different columns compare at a glance. */
export function meterMax(budget: number, values: (number | null)[]) {
  const top = Math.max(budget * 1.5, ...values.map((v) => (v ?? 0) * 1.1));
  const step = top > 500 ? 100 : 50;
  return Math.ceil(top / step) * step;
}

/** Readable names: the canonical baseline, then Candidate A, B, C in creation order. */
export function candidateLabels(candidates: CandidateDetail[]): Map<string, string> {
  const ordered = [...candidates].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const labels = new Map<string, string>();
  let letter = 0;
  for (const c of ordered) {
    if (c.changeSetIds.length === 0) labels.set(c.id, "Baseline");
    else labels.set(c.id, `Candidate ${String.fromCharCode(65 + letter++)}`);
  }
  return labels;
}

const CRITERIA: Record<string, { title: string; detail: string }> = {
  composition: {
    title: "Composition",
    detail: "ChangeSets merge without a source or semantic conflict",
  },
  build: { title: "Build", detail: "The composed source typechecks" },
  unit: { title: "Project tests", detail: "bun test passes on the composed source" },
  contract: { title: "API contract", detail: "Every route change is declared" },
  "protected-invariant-cart": {
    title: "Protected Cart invariant",
    detail: "Cart add, remove, quantity and total stay unchanged",
  },
  security: { title: "Security", detail: "Denied actions stay denied" },
  browser: { title: "Browser flow", detail: "Share, collaborate and revoke in Browser Run" },
  acceptance: {
    title: "Acceptance criteria",
    detail: "Every criterion of the Change is met, with cited source lines",
  },
};

/** Criterion title and one-line explanation for a check. */
export function criterion(
  row: Pick<CheckRow, "checkId" | "kind" | "check">,
  budget: number | null,
) {
  if (row.kind === "performance") {
    return {
      title: "Performance",
      detail: `API p95 below ${budget === null ? "the budget" : formatMs(budget)}`,
    };
  }
  const known = CRITERIA[row.checkId] ?? CRITERIA[row.kind];
  if (known) return known;
  if (row.kind === "protected-invariant") {
    return {
      title: "Protected invariant",
      detail: row.check?.reason.replace(/^Protected invariant:\s*/, "") ?? row.checkId,
    };
  }
  return { title: row.checkId, detail: row.check?.reason ?? row.kind };
}

/** What a failing or missing check means, in words: "fails performance: p95 412 ms over …". */
function failurePhrase(row: CheckRow, candidate: CandidateDetail, budget: number | null) {
  const name = criterion(row, budget).title.toLowerCase();
  if (row.kind === "performance" && row.reason === "failed") {
    const p95 = row.record?.metrics?.p95Ms ?? candidate.gate?.p95Ms;
    if (p95 !== undefined && budget !== null) {
      return `fails performance: p95 ${formatP95(p95)} over the ${formatMs(budget)} budget`;
    }
  }
  if (row.verdict === "fail") {
    const tests = row.record?.metrics?.testsFailed;
    return tests ? `fails ${name} (${tests} failing)` : `fails ${name}`;
  }
  return `has a gap in ${name}: ${REASON_WORDS[row.reason ?? "missing"]}`;
}

/** One sentence on where a Candidate stands, for banners and the comparison "Why". */
export function candidateSentence(
  label: string,
  candidate: CandidateDetail,
  rows: CheckRow[],
): string {
  const tally = requiredTally(rows);
  const budget = p95Budget(candidate);
  const p95 = p95Of(candidate, rows);
  const perf =
    p95 !== null && budget !== null && p95 < budget
      ? ` p95 ${formatP95(p95)} is under the ${formatMs(budget)} budget.`
      : "";
  if (candidate.status === "promoted") {
    return `${label} was promoted, ${generation(candidate.baseGeneration)} → ${generation(
      candidate.promotedGeneration ?? candidate.baseGeneration + 1,
    )}, after all ${tally.total} required checks passed with evidence.`;
  }
  if (candidate.status === "stale") {
    return `${label} is stale: ${candidate.statusReason ?? "the canonical state moved"}`.replace(
      /\.?$/,
      ".",
    );
  }
  if (isActive(candidate)) {
    const recorded = rows.filter((r) => r.record).length;
    return `${label} is still verifying: ${recorded} of ${rows.length} checks have evidence so far.`;
  }
  if (candidate.gate?.promotable && candidate.status === "verified") {
    return `${label} passes all ${tally.total} required checks with evidence.${perf}`;
  }
  const problems = [...tally.failed, ...tally.gaps];
  if (problems.length > 0) {
    return `${label} ${problems.map((r) => failurePhrase(r, candidate, budget)).join("; ")}.`;
  }
  if (candidate.status === "rejected" && candidate.approval?.decision === "rejected") {
    return `${label} was rejected by a human decision${
      candidate.approval.reason ? `: ${candidate.approval.reason}` : ""
    }`.replace(/\.?$/, ".");
  }
  if (candidate.statusReason) return `${label}: ${candidate.statusReason}`.replace(/\.?$/, ".");
  return `${label} meets ${tally.met} of ${tally.total} required checks.`;
}

/**
 * The column to recommend: a promoted Candidate, else a promotable one (more ChangeSets first,
 * then lower p95), else the finished Candidate with the most required checks met.
 */
export function recommend(
  items: { candidate: CandidateDetail; rows: CheckRow[] }[],
): { id: string; kind: "promoted" | "promotable" | "closest" } | null {
  const promoted = items.find((i) => i.candidate.status === "promoted");
  if (promoted) return { id: promoted.candidate.id, kind: "promoted" };
  const promotable = items
    .filter((i) => i.candidate.status === "verified" && i.candidate.gate?.promotable)
    .sort(
      (a, b) =>
        b.candidate.changeSetIds.length - a.candidate.changeSetIds.length ||
        (p95Of(a.candidate, a.rows) ?? Infinity) - (p95Of(b.candidate, b.rows) ?? Infinity),
    );
  if (promotable[0]) return { id: promotable[0].candidate.id, kind: "promotable" };
  const finished = items
    .filter((i) => isFinished(i.candidate) && i.candidate.status !== "stale")
    .sort((a, b) => requiredTally(b.rows).met - requiredTally(a.rows).met);
  const best = finished[0];
  if (!best || items.some((i) => isActive(i.candidate))) return null;
  return { id: best.candidate.id, kind: "closest" };
}

/** Names the policy rule that requires a human, in one line (DESIGN.md section 12). */
export function gateRule(candidate: CandidateDetail, riskTier: string | null | undefined) {
  const policy = candidate.plan?.policyVersion ?? candidate.approval?.policyVersion;
  const named = policy ? `Policy ${policy}` : "Project policy";
  if (!candidate.approvalRequired) {
    return `${named} does not require a human decision for this Candidate.`;
  }
  const authorization = candidate.plan?.checks.some(
    (c) => c.kind === "security" && /authorization/i.test(c.reason),
  );
  if (authorization) {
    return `${named} requires human approval because this Candidate changes authorization${
      riskTier ? ` (risk tier ${riskTier})` : ""
    }.`;
  }
  if (riskTier) return `${named} requires human approval for risk tier ${riskTier}.`;
  return `${named} requires human approval before promotion.`;
}

export const shortHash = (value: string | null | undefined, length = 12) =>
  value ? value.slice(0, length) : null;
