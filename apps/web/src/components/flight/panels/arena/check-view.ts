import type { WorkspaceChangeSet } from "../../../../lib/api";
import { formatMs, formatNumber, formatUsd } from "../../../../lib/format";
import { COVERAGE_WORDS, durationMs, formatP95, REASON_WORDS } from "../../../candidate/model";
import type { StatusFamily } from "../../../ui/status-pill";
import {
  type CandidateState,
  type CheckState,
  type FlightModel,
  type FlightState,
  taskOfChangeSet,
} from "../../flight-model";

/**
 * Pure read helpers shared by the arena, the preview wall and the Candidate inspectors. Every
 * value comes from the folded FlightState (or the recorded Workspace for ChangeSet file stats);
 * nothing is estimated. A check without a supported pass is a gap, never green,
 * and model confidence is never shown.
 */

const SETTLED = new Set(["verified", "rejected", "stale", "promoted"]);

/** The Candidate reached a final state at the fold instant: a missing check will not run. */
export const isSettled = (candidate: CandidateState) => SETTLED.has(candidate.status);

/** The winning column: promoted, else verified. */
export const isWinner = (candidate: CandidateState) =>
  candidate.status === "promoted" || candidate.status === "verified";

export const isLoser = (candidate: CandidateState) =>
  candidate.status === "rejected" || candidate.status === "stale";

export type CheckView = {
  /** Status word, always shown next to the color. */
  word: string;
  family: StatusFamily;
  /** Coverage in words (`checked, supported`, `ran, no signal`, `not checked`, `no evidence`). */
  coverage: string;
  /** Only a `checked_supported` pass satisfies a check. */
  satisfied: boolean;
  /** No result yet: drawn as a hollow square. */
  hollow: boolean;
};

export function checkView(check: CheckState, settled: boolean): CheckView {
  const coverage = check.coverage ? COVERAGE_WORDS[check.coverage] : "no evidence";
  if (check.status === "pending") {
    return {
      word: settled ? "Not run" : "Pending",
      family: "attention",
      coverage,
      satisfied: false,
      hollow: true,
    };
  }
  if (check.status === "pass") {
    if (check.coverage === "checked_supported") {
      return { word: "Pass", family: "ok", coverage, satisfied: true, hollow: false };
    }
    return {
      word: check.coverage === "checked_no_signal" ? "No signal" : "Gap",
      family: "attention",
      coverage,
      satisfied: false,
      hollow: false,
    };
  }
  if (check.status === "fail") {
    return { word: "Fail", family: "danger", coverage, satisfied: false, hollow: false };
  }
  if (check.status === "error") {
    return { word: "Error", family: "danger", coverage, satisfied: false, hollow: false };
  }
  return { word: "Skipped", family: "attention", coverage, satisfied: false, hollow: false };
}

/** The p95 a check recorded; the gate's p95 only once the gate decision has played. */
export function p95OfCheck(state: FlightState, candidate: CandidateState, check: CheckState) {
  const metric = check.record?.metrics?.p95Ms;
  if (metric !== undefined) return metric;
  if (check.kind === "performance" && check.record && gatePlayed(state, candidate.id)) {
    return candidate.detail.gate?.p95Ms ?? null;
  }
  return null;
}

/** Short mono readouts from the recorded metrics: p95, steps, tests, screenshots, duration. */
export function metricBits(state: FlightState, candidate: CandidateState, check: CheckState) {
  const out: string[] = [];
  const m = check.record?.metrics;
  const p95 = p95OfCheck(state, candidate, check);
  if (p95 !== null) out.push(`p95 ${formatP95(p95)}`);
  if (m?.stepsTotal !== undefined) {
    out.push(`${formatNumber(m.stepsPassed ?? 0)}/${formatNumber(m.stepsTotal)} steps`);
  }
  if (m?.testsPassed !== undefined || m?.testsFailed !== undefined) {
    out.push(`${formatNumber(m.testsPassed ?? 0)} pass · ${formatNumber(m.testsFailed ?? 0)} fail`);
  }
  if (m?.screenshots) out.push(`${formatNumber(m.screenshots)} shots`);
  if (check.record) {
    const ms = durationMs(check.record);
    if (ms !== null) out.push(formatMs(ms));
  }
  return out;
}

/** True once the verification verdict for this Candidate is part of the fold. */
export const gatePlayed = (state: FlightState, candidateId: string) =>
  state.decisions.some((d) => d.id === `gate:${candidateId}`);

/** Gate gaps in words, only after the gate decision has played. */
export function gateGaps(state: FlightState, candidate: CandidateState) {
  if (!gatePlayed(state, candidate.id)) return [];
  return (candidate.detail.gate?.gaps ?? []).map((g) => ({
    checkId: g.checkId,
    words: REASON_WORDS[g.reason as keyof typeof REASON_WORDS] ?? g.reason.replace(/_/g, " "),
  }));
}

/** Why the Candidate stands where it does, in one line ("Rejected: …"). */
export function standing(state: FlightState, candidate: CandidateState): string | null {
  const gaps = gateGaps(state, candidate);
  const because =
    candidate.reason ??
    (gaps.length > 0 ? gaps.map((g) => `${g.checkId} ${g.words}`).join("; ") : null);
  switch (candidate.status) {
    case "rejected":
      return `Rejected: ${because ?? "no reason recorded"}`;
    case "stale":
      return `Stale: ${because ?? "the canonical state moved"}`;
    case "promoted":
      return candidate.promotedGeneration !== null
        ? `Promoted: S${candidate.detail.baseGeneration} → S${candidate.promotedGeneration}`
        : "Promoted";
    case "verified":
      return "Verified: every required check passed with evidence";
    default: {
      const recorded = candidate.checks.filter((c) => c.record).length;
      return candidate.checks.length > 0
        ? `${recorded} of ${candidate.checks.length} checks have evidence`
        : "Verification plan not built yet";
    }
  }
}

export type ComposedChangeSet = {
  id: string;
  taskId: string | null;
  taskKey: string;
  record: WorkspaceChangeSet | null;
};

/** The ChangeSets a Candidate composed, with their Task key and Workspace record. */
export function composedChangeSets(
  state: FlightState,
  model: FlightModel,
  candidate: CandidateState,
): ComposedChangeSet[] {
  return candidate.changeSetIds.map((id) => {
    const task = taskOfChangeSet(id, model.input.tasks);
    return {
      id,
      taskId: task?.id ?? null,
      taskKey: (task && state.tasks[task.id]?.key) ?? task?.key ?? id,
      record: model.changeSets[id] ?? null,
    };
  });
}

export type CandidateSummary = {
  required: { met: number; total: number };
  failed: string[];
  evidence: number;
  files: { count: number; adds: number; dels: number; recorded: boolean };
  /** Null when none of the composing Tasks recorded a model run (fixture or system work). */
  costUsd: number | null;
  changeSets: number;
};

export function summarize(
  state: FlightState,
  model: FlightModel,
  candidate: CandidateState,
): CandidateSummary {
  const required = candidate.checks.filter((c) => c.required);
  const settled = isSettled(candidate);
  const composed = composedChangeSets(state, model, candidate);
  const paths = new Set<string>();
  let adds = 0;
  let dels = 0;
  let recorded = false;
  for (const cs of composed) {
    if (!cs.record) continue;
    recorded = true;
    for (const path of cs.record.files) paths.add(path);
    adds += cs.record.insertions;
    dels += cs.record.deletions;
  }
  const tasks = [...new Set(candidate.taskIds)].map((id) => state.tasks[id]).filter((t) => !!t);
  const ran = tasks.some((t) => t.runs.length > 0);
  return {
    required: {
      met: required.filter((c) => checkView(c, settled).satisfied).length,
      total: required.length,
    },
    failed: candidate.checks
      .filter((c) => c.status === "fail" || c.status === "error")
      .map((c) => c.checkId),
    evidence: candidate.evidence.length,
    files: { count: paths.size, adds, dels, recorded },
    costUsd: ran ? tasks.reduce((sum, t) => sum + t.usage.costUsd, 0) : null,
    changeSets: candidate.changeSetIds.length,
  };
}

export const formatCost = (usd: number | null) => (usd === null ? "not recorded" : formatUsd(usd));

/** `${candidateId}:${checkId}` -> the id of the check fact that recorded it. */
export function checkEventIds(state: FlightState): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of state.events) {
    if (e.kind === "check") out.set(`${e.candidateId}:${e.checkId}`, e.id);
  }
  return out;
}

/** Epoch ms -> ISO, for the shared clock formatter. */
export const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** A duration token from theme.css (`--rh-dur-heat: 0.4s`) in ms; `fallback` during SSR. */
export function tokenMs(name: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return raw.endsWith("ms") ? value : value * 1000;
}

/** Screenshot URL served by the same-origin proxy route (routes/evidence.$candidateId...). */
export const screenshotUrl = (candidateId: string, checkId: string, n: number) =>
  `/evidence/${encodeURIComponent(candidateId)}/${encodeURIComponent(checkId)}/${n}`;
