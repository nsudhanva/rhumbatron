import type { CandidateDetail, EvidenceRecord, ProjectVerification } from "../../lib/api";
import {
  type CheckRow,
  type CheckVerdict,
  candidateLabels,
  checkRows,
  isActive,
  p95Budget,
  p95Of,
  REASON_WORDS,
  requiredTally,
} from "../candidate/model";

/**
 * Project-wide verification read model. Every verdict comes from
 * `checkRows` in the Candidate model, so a gap here is the same gap as on the Candidate page: a
 * missing, skipped, timed-out or no-signal check is never counted as a pass.
 */

export type ChangeRef = ProjectVerification["changes"][number];

export type VerifiedCandidate = {
  candidate: CandidateDetail;
  /** "Baseline", "Candidate A", ... within its Change (same names as the compare page). */
  label: string;
  change: ChangeRef | undefined;
  /** Candidates of the same Change in this window; the compare link needs at least two. */
  siblings: number;
  rows: CheckRow[];
  tally: ReturnType<typeof requiredTally>;
  p95: number | null;
  budget: number | null;
  /** 1-based position in the heat grid, oldest left; null when outside the grid window. */
  gridIndex: number | null;
};

export type Stage = "composing" | "verifying" | "verified" | "rejected" | "promoted";

/** Heat grid width (fixed 8-16 columns). */
export const GRID_COLUMNS = 16;

/** Newest first, with the per-Change labels and check rows the Candidate pages use. */
export function buildModel(data: ProjectVerification): VerifiedCandidate[] {
  const evidenceBy = new Map<string, EvidenceRecord[]>();
  for (const e of data.evidence) {
    evidenceBy.set(e.candidateId, [...(evidenceBy.get(e.candidateId) ?? []), e]);
  }
  const byChange = new Map<string, CandidateDetail[]>();
  for (const c of data.candidates)
    byChange.set(c.changeId, [...(byChange.get(c.changeId) ?? []), c]);
  const labels = new Map<string, string>();
  for (const group of byChange.values()) {
    for (const [id, label] of candidateLabels(group)) labels.set(id, label);
  }
  const changes = new Map(data.changes.map((c) => [c.id, c]));

  const newestFirst = [...data.candidates].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  const inGrid = newestFirst.slice(0, GRID_COLUMNS).reverse();
  const gridIndex = new Map(inGrid.map((c, i) => [c.id, i + 1]));

  return newestFirst.map((candidate) => {
    const rows = checkRows(candidate, evidenceBy.get(candidate.id) ?? []);
    return {
      candidate,
      label: labels.get(candidate.id) ?? candidate.id,
      change: changes.get(candidate.changeId),
      siblings: byChange.get(candidate.changeId)?.length ?? 1,
      rows,
      tally: requiredTally(rows),
      p95: p95Of(candidate, rows),
      budget: p95Budget(candidate),
      gridIndex: gridIndex.get(candidate.id) ?? null,
    };
  });
}

/** A verification plan exists, or the Candidate is past composition. */
const reachedVerifying = (c: CandidateDetail) =>
  c.plan !== null || ["verifying", "verified", "promoted"].includes(c.status);

/**
 * Which pipeline stages a Candidate counts toward. Stages are cumulative ("reached"), so each bar
 * is a share of all Candidates. A stale Candidate counts only up to verifying:
 * its base generation moved, so it cannot be promoted as is.
 */
export function stagesOf(c: CandidateDetail): Set<Stage> {
  const stages = new Set<Stage>(["composing"]);
  if (reachedVerifying(c)) stages.add("verifying");
  if (c.status === "verified" || c.status === "promoted") stages.add("verified");
  if (c.status === "rejected") stages.add("rejected");
  if (c.status === "promoted") stages.add("promoted");
  return stages;
}

export function stats(items: VerifiedCandidate[]) {
  const count = (status: CandidateDetail["status"]) =>
    items.filter((i) => i.candidate.status === status).length;
  const required = items.flatMap((i) => i.rows.filter((r) => r.required));
  const p95s = items
    .filter((i) => !isActive(i.candidate) && i.p95 !== null)
    .map((i) => i.p95 as number)
    .sort((a, b) => a - b);
  const budget = items.find((i) => i.budget !== null)?.budget ?? null;
  return {
    total: items.length,
    verified: count("verified") + count("promoted"),
    promoted: count("promoted"),
    rejected: count("rejected"),
    stale: count("stale"),
    inFlight: items.filter((i) => isActive(i.candidate)).length,
    requiredMet: required.filter((r) => r.verdict === "pass").length,
    requiredTotal: required.length,
    requiredFailed: required.filter((r) => r.verdict === "fail").length,
    requiredGaps: required.filter((r) => r.verdict === "gap").length,
    requiredPending: required.filter((r) => r.verdict === "pending").length,
    medianP95: median(p95s),
    p95Measured: p95s.length,
    p95Values: p95s,
    budget,
  };
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Gate words for a table row: "7 / 7 met", "5 / 7 met · performance timed out". A finished
 * Candidate without a plan reads "No plan recorded" (with its status reason), never as met.
 */
export function gateWords(item: VerifiedCandidate): string {
  const { tally, candidate } = item;
  if (tally.total === 0) {
    if (isActive(candidate)) return "plan pending";
    if (candidate.plan === null) {
      return candidate.statusReason
        ? `No plan recorded · ${candidate.statusReason}`
        : "No plan recorded";
    }
    return candidate.statusReason ?? "no required checks";
  }
  const head = `${tally.met} / ${tally.total} met`;
  const problem = tally.failed[0] ?? tally.gaps[0];
  if (problem) {
    const more = tally.failed.length + tally.gaps.length - 1;
    const reason = REASON_WORDS[problem.reason ?? "missing"] ?? problem.reason;
    return `${head} · ${problem.kind}: ${reason}${more > 0 ? ` · +${more} more` : ""}`;
  }
  if (tally.pending.length > 0) return `${head} · ${tally.pending.length} pending`;
  return head;
}

/** Heat grid cell for one check kind of one Candidate: the worst verdict among its checks. */
export type HeatCell = { verdict: CheckVerdict | "none"; rows: CheckRow[] };

const SEVERITY: Record<CheckVerdict, number> = { fail: 3, gap: 2, pending: 1, pass: 0 };

export function heatCell(item: VerifiedCandidate, kind: string): HeatCell {
  const rows = item.rows.filter((r) => r.kind === kind);
  if (rows.length === 0) return { verdict: "none", rows };
  const worst = rows.reduce((a, b) => (SEVERITY[b.verdict] > SEVERITY[a.verdict] ? b : a));
  return { verdict: worst.verdict, rows };
}

/**
 * Check kinds in the order the Candidate model sorts them. Each Candidate's rows are already in
 * that order, so an unseen kind is placed right after the kind that precedes it in that list.
 */
export function kindsOf(items: VerifiedCandidate[]): string[] {
  const kinds: string[] = [];
  for (const item of items) {
    let previous: string | null = null;
    for (const row of item.rows) {
      if (!kinds.includes(row.kind)) {
        const at = previous === null ? 0 : kinds.indexOf(previous) + 1;
        kinds.splice(at, 0, row.kind);
      }
      previous = row.kind;
    }
  }
  return kinds;
}
