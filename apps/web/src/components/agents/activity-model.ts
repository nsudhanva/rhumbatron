import type {
  CandidateDetail,
  ChangeDetail,
  ConflictDetail,
  EvidenceRecord,
  Intent,
  TaskDetail,
  TaskRun,
} from "../../lib/api";
import { generation, truncate } from "../../lib/format";
import { candidateLabels } from "../candidate/model";

/**
 * Agent activity as a sequence of facts (DESIGN.md 11.1, AGENTS.md sections 17 and 31-36).
 *
 * The API has no per-Change event feed, so this module derives the sequence from records the
 * page already reads, and from nothing else:
 *
 *   Task runs        lane.forked, run.started, run.completed / run.failed, intent.declared
 *   Conflicts        challenge.created (earlier Intent's agent -> later Intent's agent),
 *                    conflict.suspected, challenge.resolved
 *   Candidates       candidate.forked, changeset.composed (from `changeSetIds`),
 *                    candidate status, approval, canonical.advanced
 *   Evidence         verification.check.completed
 *
 * Each fact carries the time the API recorded. Nothing is interpolated: a fact the API does not
 * record (Claims, per-tool-call progress) is not drawn.
 */

/** Model calls a run may make per tier. Mirrors MAX_CALLS_PER_RUN in packages/model-router. */
export const CALLS_PER_RUN: Record<TaskRun["tier"], number> = { haiku: 8, sonnet: 16, opus: 16 };

export type LaneSpec = {
  id: string;
  key: string;
  title: string;
  kind: TaskDetail["kind"];
  agentId: string | null;
  status: TaskDetail["status"];
  /** Time the latest run started while it is still running, for the elapsed readout. */
  runningSince: number | null;
};

export type CandidateCheckSpec = { checkId: string; kind: string; required: boolean };

export type CandidateSpec = {
  id: string;
  /** A, B, C in creation order. */
  letter: string;
  /** Display name shared with the Candidate pages: "Baseline" or "Candidate A". */
  name: string;
  status: CandidateDetail["status"];
  checks: CandidateCheckSpec[];
  baseGeneration: number;
};

type Base = {
  /** Stable across refetches, so a replay never plays one fact twice. */
  id: string;
  /** Epoch milliseconds recorded by the API. */
  at: number;
  /** Dotted event type in the AGENTS.md section 17 vocabulary. */
  type: string;
  /** Lane key or Candidate letter: who the fact is about. */
  actor: string;
  /** One plain sentence. */
  detail: string;
};

export type ActivityEvent = Base &
  (
    | { kind: "lane.fork"; laneId: string; tier: TaskRun["tier"]; attempt: number }
    | {
        kind: "run.start";
        laneId: string;
        tier: TaskRun["tier"];
        attempt: number;
        previousTier: TaskRun["tier"] | null;
      }
    | {
        kind: "run.end";
        laneId: string;
        tier: TaskRun["tier"];
        attempt: number;
        status: "completed" | "failed";
        calls: number;
        intent: string | null;
        failure: string | null;
      }
    | { kind: "intent"; laneId: string; summary: string }
    | {
        kind: "challenge";
        conflictId: string;
        fromLaneId: string;
        toLaneId: string;
        resource: string;
        /** False when the detector only suspects a conflict: no Challenge message exists. */
        challenged: boolean;
        state: ConflictDetail["state"];
        /** Intent summaries, challenger first. */
        statements: [string, string];
      }
    | { kind: "conflict.resolved"; conflictId: string }
    | { kind: "candidate.fork"; candidateId: string }
    | { kind: "changeset"; candidateId: string; laneId: string; changeSetId: string }
    | {
        kind: "check";
        candidateId: string;
        checkId: string;
        status: EvidenceRecord["status"];
        coverage: EvidenceRecord["coverage"];
      }
    | {
        kind: "candidate.status";
        candidateId: string;
        status: CandidateDetail["status"];
        reason: string | null;
      }
    | { kind: "approval"; candidateId: string; decision: "granted" | "rejected" }
    | { kind: "promoted"; candidateId: string; generation: number }
  );

export type ActivityInput = {
  change: ChangeDetail;
  tasks: TaskDetail[];
  conflicts: ConflictDetail[];
  candidates: CandidateDetail[];
  /** Evidence per Candidate id, when loaded. */
  evidence: Record<string, EvidenceRecord[] | undefined>;
};

export type ActivityModel = {
  baseGeneration: number;
  lanes: LaneSpec[];
  candidates: CandidateSpec[];
  /** Sorted by time, then by causal order within one instant. */
  events: ActivityEvent[];
};

/** Within one recorded instant, causes come before effects. */
const ORDER: Record<ActivityEvent["kind"], number> = {
  "lane.fork": 0,
  "run.start": 1,
  "run.end": 2,
  intent: 3,
  challenge: 4,
  "conflict.resolved": 5,
  "candidate.fork": 6,
  changeset: 7,
  check: 8,
  "candidate.status": 9,
  approval: 10,
  promoted: 11,
};

const time = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? null : t;
};

function isIntent(outcome: TaskRun["outcome"]): outcome is Intent {
  return outcome !== null && "summary" in outcome;
}

/** `cs_<task id without its 4-char prefix>_<attempt>` (agents worker, agent-do.ts). */
function laneOfChangeSet(changeSetId: string, tasks: TaskDetail[]) {
  if (!changeSetId.startsWith("cs_")) return undefined;
  const body = changeSetId.slice(3);
  const cut = body.lastIndexOf("_");
  const suffix = cut > 0 ? body.slice(0, cut) : body;
  return tasks.find((t) => t.id.slice(4) === suffix);
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function candidateLetter(index: number) {
  return LETTERS[index] ?? String(index + 1);
}

/** The reason a Candidate lost, in words: status reason, failed check, or open gaps. */
function candidateReason(
  candidate: CandidateDetail,
  evidence: EvidenceRecord[] | undefined,
): string | null {
  if (candidate.statusReason) return candidate.statusReason;
  const failed = (evidence ?? []).find((e) => e.status === "fail" || e.status === "error");
  if (failed) return `${failed.checkId}: ${failed.summary}`;
  const gaps = candidate.gate?.gaps ?? [];
  if (gaps.length > 0) return gaps.map((g) => `${g.checkId}: ${g.reason}`).join("; ");
  return null;
}

export function deriveActivity(input: ActivityInput): ActivityModel {
  const { change, tasks } = input;
  const events: ActivityEvent[] = [];
  const keyOf = new Map(tasks.map((t) => [t.id, t.key]));
  const push = (event: ActivityEvent | null) => {
    if (event) events.push(event);
  };

  const lanes: LaneSpec[] = tasks.map((task) => {
    const last = task.runs[task.runs.length - 1];
    return {
      id: task.id,
      key: task.key,
      title: task.title,
      kind: task.kind,
      agentId: task.assignedAgentId,
      status: task.status,
      runningSince: last?.status === "running" ? time(last.startedAt) : null,
    };
  });

  for (const task of tasks) {
    let previousTier: TaskRun["tier"] | null = null;
    for (const run of task.runs) {
      const started = time(run.startedAt);
      if (started !== null) {
        const base = { laneId: task.id, tier: run.tier, attempt: run.attempt, at: started };
        if (previousTier === null) {
          push({
            ...base,
            id: `${task.id}:fork`,
            kind: "lane.fork",
            type: "agent.woken",
            actor: task.key,
            detail: `${task.key} forks from ${generation(change.baseGeneration)} on ${run.tier}.`,
          });
        } else {
          push({
            ...base,
            id: `${task.id}:run${run.attempt}:start`,
            kind: "run.start",
            previousTier,
            type: previousTier === run.tier ? "task.started" : "agent.escalated",
            actor: task.key,
            detail:
              previousTier === run.tier
                ? `${task.key} retries on ${run.tier}, attempt ${run.attempt}.`
                : `${task.key} escalates ${previousTier} → ${run.tier}, attempt ${run.attempt}.`,
          });
        }
      }
      previousTier = run.tier;

      const ended = time(run.endedAt);
      if (ended === null || run.status === "running") continue;
      const intent = isIntent(run.outcome) ? run.outcome : null;
      const failure =
        run.status === "failed"
          ? [run.failureKind, run.outcome && "reason" in run.outcome ? run.outcome.reason : null]
              .filter(Boolean)
              .join(": ") || "failed"
          : null;
      push({
        id: `${task.id}:run${run.attempt}:end`,
        at: ended,
        kind: "run.end",
        laneId: task.id,
        tier: run.tier,
        attempt: run.attempt,
        status: run.status,
        calls: run.modelCalls,
        intent: intent?.summary ?? null,
        failure,
        type: run.status === "completed" ? "task.completed" : "task.failed",
        actor: task.key,
        detail:
          run.status === "completed"
            ? `${task.key} completes after ${run.modelCalls} model calls.`
            : `${task.key} fails: ${truncate(failure ?? "failed", 120)}.`,
      });
      if (intent) {
        push({
          id: `${task.id}:run${run.attempt}:intent`,
          at: ended,
          kind: "intent",
          laneId: task.id,
          summary: intent.summary,
          type: "intent.declared",
          actor: task.key,
          detail: `${task.key} declares Intent: ${truncate(intent.summary, 120)}`,
        });
      }
    }
  }

  for (const conflict of input.conflicts) {
    const at = time(conflict.createdAt);
    if (at === null) continue;
    // The Challenge flows from the earlier Intent's agent to the later Intent (conflicts.ts).
    const [earlier, later] = [...conflict.intents].sort(
      (a, b) => (time(a.createdAt) ?? 0) - (time(b.createdAt) ?? 0),
    ) as [ConflictDetail["intents"][0], ConflictDetail["intents"][1]];
    if (!keyOf.has(earlier.taskId) || !keyOf.has(later.taskId)) continue;
    const challenged = conflict.challengeId !== null;
    const fromKey = keyOf.get(earlier.taskId) ?? earlier.taskKey;
    const toKey = keyOf.get(later.taskId) ?? later.taskKey;
    push({
      id: `${conflict.id}:open`,
      at,
      kind: "challenge",
      conflictId: conflict.id,
      fromLaneId: earlier.taskId,
      toLaneId: later.taskId,
      resource: conflict.resource,
      challenged,
      // A resolved conflict was open first. Only a confirmed conflict carries a Challenge.
      state:
        conflict.state !== "resolved" ? conflict.state : challenged ? "confirmed" : "suspected",
      statements: [earlier.summary, later.summary],
      type: challenged ? "challenge.created" : "conflict.suspected",
      actor: fromKey,
      detail: challenged
        ? `${fromKey} challenges ${toKey} on ${conflict.resource}.`
        : `${fromKey} and ${toKey} may conflict on ${conflict.resource}.`,
    });
    const resolved = time(conflict.updatedAt);
    if (conflict.state === "resolved" && resolved !== null) {
      push({
        id: `${conflict.id}:resolved`,
        at: Math.max(resolved, at),
        kind: "conflict.resolved",
        conflictId: conflict.id,
        type: "challenge.resolved",
        actor: fromKey,
        detail: `Conflict on ${conflict.resource} is resolved.`,
      });
    }
  }

  const sorted = [...input.candidates].sort(
    (a, b) => (time(a.createdAt) ?? 0) - (time(b.createdAt) ?? 0),
  );
  const names = candidateLabels(sorted);
  const candidates: CandidateSpec[] = sorted.map((candidate, index) => {
    const letter = candidateLetter(index);
    const records = input.evidence[candidate.id];
    const planChecks = candidate.plan?.checks ?? [];
    const required = new Set(candidate.plan?.requiredCheckIds ?? []);
    const checks: CandidateCheckSpec[] =
      planChecks.length > 0
        ? planChecks.map((c) => ({
            checkId: c.checkId,
            kind: c.kind,
            required: required.has(c.checkId),
          }))
        : [...new Map((records ?? []).map((r) => [r.checkId, r])).values()].map((r) => ({
            checkId: r.checkId,
            kind: r.kind,
            required: true,
          }));

    const created = time(candidate.createdAt);
    const name = names.get(candidate.id) ?? `Candidate ${letter}`;
    if (created !== null) {
      push({
        id: `${candidate.id}:fork`,
        at: created,
        kind: "candidate.fork",
        candidateId: candidate.id,
        type: "candidate.forked",
        actor: name,
        detail: `${name} forks from ${generation(candidate.baseGeneration)}.`,
      });
      for (const changeSetId of candidate.changeSetIds) {
        const lane = laneOfChangeSet(changeSetId, tasks);
        if (!lane) continue;
        push({
          id: `${candidate.id}:${changeSetId}`,
          at: created,
          kind: "changeset",
          candidateId: candidate.id,
          laneId: lane.id,
          changeSetId,
          type: "changeset.accepted",
          actor: lane.key,
          detail: `${lane.key} ChangeSet composes into ${name}.`,
        });
      }
    }

    let lastCheck = created ?? 0;
    for (const record of records ?? []) {
      const at = time(record.completedAt) ?? time(record.startedAt);
      if (at === null) continue;
      lastCheck = Math.max(lastCheck, at);
      push({
        id: `${candidate.id}:check:${record.evidenceId}`,
        at,
        kind: "check",
        candidateId: candidate.id,
        checkId: record.checkId,
        status: record.status,
        coverage: record.coverage,
        type: record.status === "fail" ? "test.failed" : "verification.check.completed",
        actor: name,
        detail: `${name} ${record.checkId}: ${record.status}. ${truncate(record.summary, 100)}`,
      });
    }

    const updated = Math.max(time(candidate.updatedAt) ?? 0, lastCheck);
    const promoted = candidate.status === "promoted";
    if (candidate.status !== "composing" && updated > 0) {
      const status = promoted ? "verified" : candidate.status;
      const reason = status === "rejected" ? candidateReason(candidate, records) : null;
      push({
        id: `${candidate.id}:status:${status}`,
        // A promoted Candidate was verified before the human decision and the promotion.
        at: promoted ? Math.min(updated, time(candidate.approval?.createdAt) ?? updated) : updated,
        kind: "candidate.status",
        candidateId: candidate.id,
        status,
        reason,
        type:
          status === "verified" || status === "rejected"
            ? "verification.completed"
            : status === "stale"
              ? "candidate.stale"
              : "candidate.composed",
        actor: name,
        detail:
          status === "rejected"
            ? `${name} is rejected${reason ? `: ${truncate(reason, 120)}` : "."}`
            : status === "verified"
              ? `${name} is verified. Every required check passed.`
              : `${name} is ${status}.`,
      });
    }
    const approved = time(candidate.approval?.createdAt);
    if (candidate.approval && approved !== null) {
      push({
        id: `${candidate.id}:approval`,
        at: approved,
        kind: "approval",
        candidateId: candidate.id,
        decision: candidate.approval.decision,
        type: candidate.approval.decision === "granted" ? "approval.granted" : "approval.rejected",
        actor: name,
        detail:
          candidate.approval.decision === "granted"
            ? `A person approves ${name}.`
            : `A person rejects ${name}.`,
      });
    }
    if (promoted && candidate.promotedGeneration !== null) {
      push({
        id: `${candidate.id}:promoted`,
        at: Math.max(updated, approved ?? 0),
        kind: "promoted",
        candidateId: candidate.id,
        generation: candidate.promotedGeneration,
        type: "canonical.advanced",
        actor: name,
        detail: `${name} merges. ${generation(candidate.baseGeneration)} → ${generation(candidate.promotedGeneration)}.`,
      });
    }
    return {
      id: candidate.id,
      letter,
      name,
      status: candidate.status,
      checks,
      baseGeneration: candidate.baseGeneration,
    };
  });

  events.sort((a, b) => a.at - b.at || ORDER[a.kind] - ORDER[b.kind]);
  return { baseGeneration: change.baseGeneration, lanes, candidates, events };
}

/* --------------------------------------------------------------------------------------------
 * Fold: the visible state after a set of played events.
 * ------------------------------------------------------------------------------------------ */

export type LaneView = {
  forked: boolean;
  status: string;
  tier: TaskRun["tier"] | null;
  attempt: number;
  step: string;
  calls: number | null;
  /** Event id of the last message that arrived at this lane (restarts the flash). */
  arrival: string | null;
};

export type CandidateView = {
  forked: boolean;
  status: string;
  reason: string | null;
  checks: Record<
    string,
    { status: EvidenceRecord["status"]; coverage: EvidenceRecord["coverage"] }
  >;
  changeSets: number;
  approval: "granted" | "rejected" | null;
  arrival: string | null;
};

export type ConflictView = {
  id: string;
  fromLaneId: string;
  toLaneId: string;
  resource: string;
  challenged: boolean;
  state: ConflictDetail["state"];
  open: boolean;
  statements: [string, string];
  eventId: string;
};

export type ActivityView = {
  lanes: Record<string, LaneView>;
  candidates: Record<string, CandidateView>;
  conflicts: ConflictView[];
  /** Lanes with a declared Intent: the possible changes. */
  intents: number;
  /** Workspace arrivals restart the workspace flash. */
  workspaceArrival: string | null;
  /** Set once a Candidate merges. */
  promoted: { candidateId: string; generation: number; eventId: string } | null;
  /** Lane or Candidate the latest fact is about: the current step. */
  current: string | null;
};

export function foldActivity(
  model: ActivityModel,
  played: ReadonlySet<string>,
  /** True when every fact has played: settle lanes on their recorded status. */
  complete: boolean,
): ActivityView {
  const lanes: Record<string, LaneView> = {};
  for (const lane of model.lanes) {
    lanes[lane.id] = {
      forked: false,
      status: lane.status === "pending" || lane.status === "ready" ? lane.status : "pending",
      tier: null,
      attempt: 0,
      step: lane.status === "ready" ? "Ready, waiting for an agent" : "Waiting on dependencies",
      calls: null,
      arrival: null,
    };
  }
  const candidates: Record<string, CandidateView> = {};
  for (const c of model.candidates) {
    candidates[c.id] = {
      forked: false,
      status: "composing",
      reason: null,
      checks: {},
      changeSets: 0,
      approval: null,
      arrival: null,
    };
  }
  const conflicts = new Map<string, ConflictView>();
  const intentLanes = new Set<string>();
  const view: ActivityView = {
    lanes,
    candidates,
    conflicts: [],
    intents: 0,
    workspaceArrival: null,
    promoted: null,
    current: null,
  };

  for (const event of model.events) {
    if (!played.has(event.id)) continue;
    switch (event.kind) {
      case "lane.fork":
      case "run.start": {
        const lane = lanes[event.laneId];
        if (!lane) break;
        lane.forked = true;
        lane.status = "running";
        lane.tier = event.tier;
        lane.attempt = event.attempt;
        lane.calls = null;
        lane.step =
          event.kind === "lane.fork"
            ? `Attempt ${event.attempt} · working from ${generation(model.baseGeneration)}`
            : event.previousTier !== event.tier
              ? `Attempt ${event.attempt} · escalated from ${event.previousTier}`
              : `Attempt ${event.attempt} · retry`;
        view.current = event.laneId;
        break;
      }
      case "run.end": {
        const lane = lanes[event.laneId];
        if (!lane) break;
        lane.forked = true;
        lane.status = event.status;
        lane.tier = event.tier;
        lane.attempt = event.attempt;
        lane.calls = event.calls;
        lane.step =
          event.status === "completed"
            ? event.intent
              ? `Intent: ${event.intent}`
              : "Done"
            : `Failed · ${event.failure ?? "no reason recorded"}`;
        view.current = event.laneId;
        break;
      }
      case "intent":
        intentLanes.add(event.laneId);
        view.workspaceArrival = event.id;
        view.current = event.laneId;
        break;
      case "challenge": {
        conflicts.set(event.conflictId, {
          id: event.conflictId,
          fromLaneId: event.fromLaneId,
          toLaneId: event.toLaneId,
          resource: event.resource,
          challenged: event.challenged,
          state: event.state,
          open: true,
          statements: event.statements,
          eventId: event.id,
        });
        const target = lanes[event.toLaneId];
        if (target && event.challenged) target.arrival = event.id;
        view.current = event.toLaneId;
        break;
      }
      case "conflict.resolved": {
        const conflict = conflicts.get(event.conflictId);
        if (conflict) {
          conflict.open = false;
          conflict.state = "resolved";
        }
        break;
      }
      case "candidate.fork": {
        const c = candidates[event.candidateId];
        if (c) c.forked = true;
        view.current = event.candidateId;
        break;
      }
      case "changeset": {
        const c = candidates[event.candidateId];
        if (!c) break;
        c.changeSets += 1;
        c.arrival = event.id;
        view.current = event.candidateId;
        break;
      }
      case "check": {
        const c = candidates[event.candidateId];
        if (!c) break;
        c.status = c.status === "composing" ? "verifying" : c.status;
        c.checks[event.checkId] = { status: event.status, coverage: event.coverage };
        view.current = event.candidateId;
        break;
      }
      case "candidate.status": {
        const c = candidates[event.candidateId];
        if (!c) break;
        c.status = event.status;
        c.reason = event.reason;
        view.current = event.candidateId;
        break;
      }
      case "approval": {
        const c = candidates[event.candidateId];
        if (c) c.approval = event.decision;
        view.current = event.candidateId;
        break;
      }
      case "promoted": {
        const c = candidates[event.candidateId];
        if (c) c.status = "promoted";
        view.promoted = {
          candidateId: event.candidateId,
          generation: event.generation,
          eventId: event.id,
        };
        view.current = event.candidateId;
        break;
      }
    }
  }

  if (complete) {
    for (const spec of model.lanes) {
      const lane = lanes[spec.id];
      if (!lane) continue;
      // Statuses without a recorded time (blocked, cancelled) settle once every fact has played.
      if (["blocked", "cancelled", "assigned"].includes(spec.status)) lane.status = spec.status;
      if (spec.status === "assigned" && !lane.forked) lane.step = "Assigned, agent waking";
    }
    for (const spec of model.candidates) {
      const c = candidates[spec.id];
      if (c && c.status !== "promoted") c.status = spec.status;
    }
  }

  view.intents = intentLanes.size;
  view.conflicts = [...conflicts.values()];
  return view;
}
