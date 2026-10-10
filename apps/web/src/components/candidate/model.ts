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

/** The promoted generation's release is still building (ADR 0018): keep polling the Candidate. */
export const releaseInFlight = (candidate: CandidateDetail) =>
  candidate.release?.status === "queued" || candidate.release?.status === "building";

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

/** Plain words for a gap reason (spec 7.6), used in rows, banners and the result sentence. */
export const REASON_WORDS: Record<GapReason, string> = {
  missing: "no result recorded",
  not_checked: "not run",
  no_signal: "ran with no result",
  failed: "failed",
  error: "couldn't run",
  skipped: "skipped (not automated yet)",
  timed_out: "timed out",
  expectation_not_met: "over the limit",
};

export const COVERAGE_WORDS: Record<EvidenceRecord["coverage"], string> = {
  checked_supported: "ran, result recorded",
  checked_no_signal: "ran with no result",
  not_checked: "not run",
};

/** Pill status for a verdict (StatusPill vocabulary). A gap is attention, never green. */
export const VERDICT_STATUS: Record<CheckVerdict, string> = {
  pass: "pass",
  fail: "fail",
  gap: "gap",
  pending: "queued",
};

/** Plain word for one check (spec 7.4 check words). A gap is amber and never reads as a pass. */
export function verdictWord(row: Pick<CheckRow, "verdict" | "reason">): string {
  if (row.verdict === "pass") return "Passed";
  if (row.verdict === "fail") return "Failed";
  if (row.verdict === "pending") return "Queued";
  if (row.reason === "error") return "Couldn't run";
  if (row.reason === "no_signal") return "No result";
  if (row.reason === "skipped") return "Skipped";
  if (row.reason === "timed_out") return "Timed out";
  return "Not run";
}

const KIND_ORDER = [
  "composition",
  "build",
  "unit",
  "contract",
  "protected-invariant",
  "performance",
  "security",
  "browser",
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

/** Readable names (spec 7.6): the empty baseline, then Version A, B, C in creation order. */
export function candidateLabels(candidates: CandidateDetail[]): Map<string, string> {
  const ordered = [...candidates].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const labels = new Map<string, string>();
  let letter = 0;
  for (const c of ordered) {
    if (c.changeSetIds.length === 0) labels.set(c.id, "Baseline");
    else labels.set(c.id, `Version ${String.fromCharCode(65 + letter++)}`);
  }
  return labels;
}

const CRITERIA: Record<string, { title: string; detail: string }> = {
  composition: {
    title: "Code combines cleanly",
    detail: "The code changes from every task merge without a conflict",
  },
  build: { title: "Build", detail: "The combined code typechecks" },
  unit: { title: "Project tests", detail: "The project's tests pass on the combined code" },
  contract: { title: "API contract", detail: "Every API route change is declared" },
  "protected-invariant-cart": {
    title: "Cart unchanged",
    detail: "Cart add, remove, quantity and total stay exactly the same",
  },
  security: { title: "Security", detail: "Denied actions stay denied" },
  browser: { title: "Browser flow", detail: "Share, collaborate and revoke, in a real browser" },
};

/** Criterion title and one-line explanation for a check. */
export function criterion(
  row: Pick<CheckRow, "checkId" | "kind" | "check">,
  budget: number | null,
) {
  if (row.kind === "performance") {
    return {
      title: "Performance",
      detail: `API response time (p95) under ${budget === null ? "the limit" : formatMs(budget)}`,
    };
  }
  const known = CRITERIA[row.checkId] ?? CRITERIA[row.kind];
  if (known) return known;
  if (row.kind === "protected-invariant") {
    return {
      title: "Must not change",
      detail: row.check?.reason.replace(/^Protected invariant:\s*/, "") ?? row.checkId,
    };
  }
  return { title: row.checkId, detail: row.check?.reason ?? row.kind };
}

/** What a failing or missing check means, in words: "Project tests failed (3 failing)". */
function problemPhrase(row: CheckRow, candidate: CandidateDetail, budget: number | null) {
  const name = criterion(row, budget).title;
  if (
    row.kind === "performance" &&
    (row.reason === "failed" || row.reason === "expectation_not_met")
  ) {
    const p95 = row.record?.metrics?.p95Ms ?? candidate.gate?.p95Ms;
    if (p95 !== undefined && budget !== null) {
      return `API response time (p95) was ${formatP95(p95)} (limit ${formatMs(budget)})`;
    }
  }
  if (row.verdict === "fail") {
    const tests = row.record?.metrics?.testsFailed;
    return tests ? `${name} failed (${tests} failing)` : `${name} failed`;
  }
  return `${name} ${REASON_WORDS[row.reason ?? "missing"]}`;
}

/** Why a finished version did not pass, as one clause; null when nothing is known. */
function setAsideReason(candidate: CandidateDetail, rows: CheckRow[]): string | null {
  const tally = requiredTally(rows);
  const budget = p95Budget(candidate);
  const problems = [...tally.failed, ...tally.gaps];
  if (problems.length > 0) {
    return problems.map((r) => problemPhrase(r, candidate, budget)).join("; ");
  }
  if (candidate.approval?.decision === "rejected") {
    return `rejected by a person${candidate.approval.reason ? `: ${candidate.approval.reason}` : ""}`;
  }
  return candidate.statusReason;
}

/** The release that shipped first, read from the stale reason ("... advanced to S1842 ..."). */
function shippedFirst(candidate: CandidateDetail): number {
  const match = /S(\d+)/.exec(candidate.statusReason ?? "");
  return match ? Number(match[1]) : candidate.baseGeneration + 1;
}

const VERSION_WORDS: Record<CandidateDetail["status"], string> = {
  composing: "Assembling",
  composed: "Ready for checks",
  verifying: "Checking",
  verified: "Passed",
  rejected: "Set aside",
  stale: "Out of date",
  promoted: "Shipped",
};

/** One word for a version's status (spec 7.4 Version table). */
export const versionWord = (status: CandidateDetail["status"]) => VERSION_WORDS[status];

const sentence = (text: string) => text.replace(/\.?$/, ".");

/** One sentence on where a version stands (spec 7.4 Version table), for the status header. */
export function versionSentence(candidate: CandidateDetail, rows: CheckRow[]): string {
  const n = candidate.changeSetIds.length;
  switch (candidate.status) {
    case "composing":
      return `Combining code changes from ${n} ${n === 1 ? "task" : "tasks"}.`;
    case "composed":
      return "Built. Checks start next.";
    case "verifying":
      return `${rows.filter((r) => r.record).length} of ${rows.length} checks finished.`;
    case "verified":
      return `Passed all ${requiredTally(rows).total} required checks.`;
    case "stale":
      return `Another change shipped first (${generation(shippedFirst(candidate))}). This version must be rebuilt on it.`;
    case "promoted":
      return `Shipped as ${generation(candidate.promotedGeneration ?? candidate.baseGeneration + 1)}.`;
    default: {
      const reason = setAsideReason(candidate, rows);
      return sentence(`Set aside: ${reason ?? "a required check did not pass"}`);
    }
  }
}

/** One sentence naming the version, for the compare page result line and banners. */
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
      ? ` Response time (p95) ${formatP95(p95)}, under the ${formatMs(budget)} limit.`
      : "";
  if (candidate.status === "promoted") {
    return `${label} shipped as ${generation(
      candidate.promotedGeneration ?? candidate.baseGeneration + 1,
    )} after passing all ${tally.total} required checks.`;
  }
  if (candidate.status === "stale") {
    return `${label} is out of date: another change shipped first (${generation(
      shippedFirst(candidate),
    )}). It must be rebuilt on it.`;
  }
  if (isActive(candidate)) {
    const recorded = rows.filter((r) => r.record).length;
    return `${label} is still being checked: ${recorded} of ${rows.length} checks finished.`;
  }
  if (candidate.gate?.promotable && candidate.status === "verified") {
    return `${label} passed all ${tally.total} required checks.${perf}`;
  }
  if (candidate.status === "rejected" && candidate.approval?.decision === "rejected") {
    return sentence(
      `${label} was rejected by a person${candidate.approval.reason ? `: ${candidate.approval.reason}` : ""}`,
    );
  }
  const reason = setAsideReason(candidate, rows);
  if (reason) return sentence(`${label} was set aside: ${reason}`);
  return `${label} passed ${tally.met} of ${tally.total} required checks.`;
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

/** Why a person must (or need not) approve this version, in one plain sentence. */
export function gateRule(candidate: CandidateDetail, riskTier: string | null | undefined) {
  if (!candidate.approvalRequired) return "No approval is needed for this version.";
  const authorization = candidate.plan?.checks.some(
    (c) => c.kind === "security" && /authorization/i.test(c.reason),
  );
  if (authorization) {
    return `A person must approve this version because it changes who can do what${
      riskTier ? ` (${riskTier} risk)` : ""
    }.`;
  }
  if (riskTier) return `A person must approve ${riskTier} risk changes.`;
  return "A person must approve this version before it ships.";
}

export const shortHash = (value: string | null | undefined, length = 12) =>
  value ? value.slice(0, length) : null;
