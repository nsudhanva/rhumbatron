import type {
  CandidateDetail,
  ChangeDetail,
  ConflictDetail,
  EvidenceRecord,
  FeedEvent,
  Intent,
  ClaimFact as LifecycleClaimFact,
  RunProgress,
  TaskDetail,
  TaskRun,
} from "../../lib/api";
import { generation, truncate } from "../../lib/format";
import { candidateLabels } from "../candidate/model";

/** Advisory facts extend the web's lifecycle read type. Missing holder data stays unknown. */
type ClaimFact = Omit<LifecycleClaimFact, "action"> & {
  action: LifecycleClaimFact["action"] | "contended";
  heldByAgentId?: string;
};

/**
 * Agent activity as a sequence of facts (AGENTS.md sections 17 and 31-36). The Debug view
 * (components/flight) folds it at any recorded instant; the Change page reuses `describeStep`.
 *
 * The sequence comes from records the page reads, and from nothing else:
 *
 *   Task runs        lane.forked, run.started, run.completed / run.failed, intent.declared
 *   Conflicts        challenge.created (earlier Intent's agent -> later Intent's agent),
 *                    conflict.suspected, challenge.resolved
 *   Candidates       candidate.forked, changeset.composed (from `changeSetIds`),
 *                    candidate status, approval, canonical.advanced
 *   Evidence         verification.check.completed
 *   Claims feed      claim.acquired / renewed / released / expired / contended
 *   Event feed       every other recorded event of the Change (task.ready, agent.woken,
 *                    model.route.decided, changeset.proposed, ...). A feed event that a derived
 *                    fact above already shows is dropped, so one fact never appears twice.
 *   Run progress     calls and the last tool step of a running attempt (state, not a fact)
 *
 * Each fact carries the time the API recorded. Nothing is interpolated: a fact the API does not
 * record is not drawn.
 */

/** Model calls a run may make per tier. Mirrors MAX_CALLS_PER_RUN in packages/model-router. */
export const CALLS_PER_RUN: Record<TaskRun["tier"], number> = { haiku: 16, sonnet: 32, opus: 32 };

export type LaneSpec = {
  id: string;
  key: string;
  title: string;
  kind: TaskDetail["kind"];
  agentId: string | null;
  status: TaskDetail["status"];
  /** Time the latest run started while it is still running, for the elapsed readout. */
  runningSince: number | null;
  /** Live progress of the running attempt (calls so far and the last tool step). */
  live: { attempt: number; calls: number; lastStep: string | null } | null;
};

export type CandidateCheckSpec = { checkId: string; kind: string; required: boolean };

export type CandidateSpec = {
  id: string;
  /** A, B, C in creation order. */
  letter: string;
  /** Display name shared with the Candidate pages (`candidateLabels`). */
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
        kind: "claim";
        /** Null when the claiming agent is not one of this Change's lanes. */
        laneId: string | null;
        /** Recorded holder; null when absent or outside this Change's lanes. */
        holderLaneId: string | null;
        holderAgentId: string | null;
        claimId: string;
        action: ClaimFact["action"];
        resource: string;
      }
    | {
        /** A recorded event no derived fact shows. Drawn in the event list only. */
        kind: "fact";
        laneId: string | null;
        candidateId: string | null;
        eventType: string;
        data: FeedEvent["data"];
      }
    | {
        kind: "challenge";
        conflictId: string;
        challengeId: string | null;
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
  /** Running attempts with their latest calls and tool step. */
  progress?: RunProgress[];
  /** Claim facts of the Change, oldest first. */
  claims?: ClaimFact[];
  /** Recorded events of the Change, any order. */
  feed?: FeedEvent[];
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
  fact: 0,
  "lane.fork": 1,
  "run.start": 2,
  claim: 3,
  "run.end": 4,
  intent: 5,
  challenge: 6,
  "conflict.resolved": 7,
  "candidate.fork": 8,
  changeset: 9,
  check: 10,
  "candidate.status": 11,
  approval: 12,
  promoted: 13,
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

  const progressOf = new Map((input.progress ?? []).map((p) => [p.taskId, p]));
  const lanes: LaneSpec[] = tasks.map((task) => {
    const last = task.runs[task.runs.length - 1];
    const running = last?.status === "running" ? last : undefined;
    const progress = running ? progressOf.get(task.id) : undefined;
    const live =
      running && (!progress || progress.attempt === running.attempt)
        ? {
            attempt: running.attempt,
            // Both sources are written by the same per-call update; take the newer count.
            calls: Math.max(running.modelCalls, progress?.modelCalls ?? 0),
            lastStep: progress?.lastStep ?? null,
          }
        : null;
    return {
      id: task.id,
      key: task.key,
      title: task.title,
      kind: task.kind,
      agentId: task.assignedAgentId,
      status: task.status,
      runningSince: running ? time(running.startedAt) : null,
      live,
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
      challengeId: conflict.challengeId,
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
    const name = names.get(candidate.id) ?? `Version ${letter}`;
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

  addRecordedFacts(events, input, candidates);
  events.sort((a, b) => a.at - b.at || ORDER[a.kind] - ORDER[b.kind]);
  return { baseGeneration: change.baseGeneration, lanes, candidates, events };
}

/* --------------------------------------------------------------------------------------------
 * Recorded facts: the Claims feed and the per-Change event feed.
 * ------------------------------------------------------------------------------------------ */

/** The identity of a derived fact in event-feed terms, used to drop the feed's copy of it. */
function derivedCover(event: ActivityEvent): string | null {
  switch (event.kind) {
    case "lane.fork":
      return `task.started|${event.laneId}`;
    case "run.start":
      return event.previousTier !== event.tier
        ? `agent.escalated|${event.laneId}|${event.previousTier}>${event.tier}`
        : null;
    case "run.end":
      return `${event.status === "completed" ? "task.completed" : "task.failed"}|${event.laneId}`;
    case "intent":
      return `intent.declared|${event.laneId}`;
    case "challenge":
      return event.challengeId ? `challenge.created|${event.challengeId}` : null;
    case "check":
      return `check|${event.candidateId}|${event.id.split(":check:")[1] ?? ""}`;
    case "candidate.status":
      return `candidate.status|${event.candidateId}`;
    case "approval":
      return `approval|${event.candidateId}`;
    case "promoted":
      return `promoted|${event.candidateId}`;
    default:
      return null;
  }
}

const str = (data: FeedEvent["data"], key: string) =>
  typeof data[key] === "string" ? (data[key] as string) : null;

function feedCover(event: FeedEvent): string | null {
  const d = event.data;
  switch (event.eventType) {
    case "task.started":
    case "task.completed":
    case "task.failed":
    case "intent.declared":
      return event.taskId ? `${event.eventType}|${event.taskId}` : null;
    case "agent.escalated":
      return event.taskId
        ? `agent.escalated|${event.taskId}|${str(d, "from")}>${str(d, "to")}`
        : null;
    case "challenge.created":
      return str(d, "challengeId") ? `challenge.created|${str(d, "challengeId")}` : null;
    case "challenge.resolved":
      // The derived conflict.resolved fact shows it when the conflict row is resolved.
      return str(d, "challengeId") ? `challenge.resolved|${str(d, "challengeId")}` : null;
    case "verification.check.completed":
      return `check|${event.candidateId}|${str(d, "evidenceId")}`;
    case "verification.completed":
    case "candidate.stale":
      return event.candidateId ? `candidate.status|${event.candidateId}` : null;
    case "approval.granted":
    case "approval.rejected":
      return event.candidateId ? `approval|${event.candidateId}` : null;
    case "canonical.advanced":
      return event.candidateId ? `promoted|${event.candidateId}` : null;
    default:
      return null;
  }
}

/** One plain sentence for a recorded event, from its typed fields. */
function factDetail(event: FeedEvent, who: string | null): string {
  const d = event.data;
  const subject = who ?? event.actor.id;
  switch (event.eventType) {
    case "change.created":
      return "Change created.";
    case "change.compiled":
      return `Work Graph compiled: ${d.taskCount ?? "?"} Tasks${str(d, "riskTier") ? `, risk ${str(d, "riskTier")}` : ""}.`;
    case "task.created":
      return `${subject} planned${str(d, "title") ? `: ${str(d, "title")}` : ""}.`;
    case "task.ready":
      return `${subject} is ready. Its dependencies are done.`;
    case "task.assigned":
      return `${subject} is assigned to ${str(d, "agentId") ?? "an agent"}.`;
    case "agent.woken":
      return `${subject} agent wakes${str(d, "reason") ? ` (${str(d, "reason")})` : ""}.`;
    case "model.route.decided":
      return `${subject} routes to ${str(d, "selectedTier") ?? "a model"}${str(d, "decidedBy") ? ` by ${str(d, "decidedBy")}` : ""}.`;
    case "changeset.proposed":
      return str(d, "changeSetId")
        ? `${subject} proposes ChangeSet ${str(d, "changeSetId")}.`
        : `${subject} proposes a ChangeSet.`;
    case "verification.started":
      return "Every Task is done. Verification can start.";
    case "candidate.composed":
      return `${subject} is composed from its ChangeSets.`;
    case "approval.requested":
      return `${subject} needs a human approval${str(d, "riskTier") ? ` (${str(d, "riskTier")} risk)` : ""}.`;
    case "canonical.promotion.requested":
      return `Promotion of ${subject} is requested.`;
    case "challenge.resolved":
      return `Challenge resolved${str(d, "resolution") ? `: ${str(d, "resolution")}` : ""}.`;
    default:
      return event.summary;
  }
}

function claimDetail(
  agent: string,
  action: ClaimFact["action"],
  resource: string,
  holder: string | null,
) {
  switch (action) {
    case "acquired":
      return `${agent} claims ${resource}.`;
    case "renewed":
      return `${agent} renews its claim on ${resource}.`;
    case "released":
      return `${agent} releases ${resource}.`;
    case "expired":
      return `${agent}'s claim on ${resource} expired.`;
    case "contended":
      return `${agent} contended for ${resource}${holder ? `, held by ${holder}` : "; holder not recorded"}.`;
  }
}

function addRecordedFacts(
  events: ActivityEvent[],
  input: ActivityInput,
  candidates: CandidateSpec[],
) {
  const laneByTask = new Map(input.tasks.map((t) => [t.id, t]));
  const laneByAgent = new Map(
    input.tasks.filter((t) => t.assignedAgentId).map((t) => [t.assignedAgentId as string, t]),
  );
  const nameOf = new Map(candidates.map((c) => [c.id, c.name]));

  // Claims: the Claims feed, plus any claim event of the event feed it does not hold yet.
  const claims = new Map<string, ClaimFact>();
  for (const fact of input.claims ?? []) claims.set(fact.eventId, fact);
  for (const event of input.feed ?? []) {
    if (!event.eventType.startsWith("claim.") || claims.has(event.eventId)) continue;
    const action = event.eventType.slice("claim.".length) as ClaimFact["action"];
    const claimId = str(event.data, "claimId");
    const agentId = str(event.data, "agentId");
    const heldByAgentId = str(event.data, "heldByAgentId");
    if (
      !claimId ||
      !agentId ||
      !["acquired", "renewed", "released", "expired", "contended"].includes(action)
    )
      continue;
    claims.set(event.eventId, {
      seq: event.seq,
      eventId: event.eventId,
      action,
      claimId,
      agentId,
      ...(action === "contended" && heldByAgentId ? { heldByAgentId } : {}),
      resource: event.resource ?? "",
      leaseExpiresAt: str(event.data, "leaseExpiresAt"),
      occurredAt: event.occurredAt,
    });
  }
  // A Claim ID identifies one owner. Recover that recorded identity for older projections
  // only when a lifecycle fact for the same Claim is present; never guess from the resource.
  const holderByClaim = new Map(
    [...claims.values()].filter((f) => f.action !== "contended").map((f) => [f.claimId, f.agentId]),
  );
  for (const fact of claims.values()) {
    const at = time(fact.occurredAt);
    if (at === null) continue;
    const lane = laneByAgent.get(fact.agentId);
    const holderAgentId =
      fact.action === "contended"
        ? (fact.heldByAgentId ?? holderByClaim.get(fact.claimId) ?? null)
        : null;
    const holderLane = holderAgentId ? laneByAgent.get(holderAgentId) : undefined;
    events.push({
      id: `claim:${fact.eventId}`,
      at,
      kind: "claim",
      laneId: lane?.id ?? null,
      holderLaneId: holderLane?.id ?? null,
      holderAgentId,
      claimId: fact.claimId,
      action: fact.action,
      resource: fact.resource,
      type: `claim.${fact.action}`,
      actor: lane?.key ?? fact.agentId,
      detail: claimDetail(
        lane?.key ?? fact.agentId,
        fact.action,
        fact.resource,
        holderLane?.key ?? holderAgentId,
      ),
    });
  }

  // Every other recorded event, unless a derived fact already shows it.
  const covered = new Set(events.map(derivedCover).filter((k): k is string => k !== null));
  for (const event of input.feed ?? []) {
    if (event.eventType.startsWith("claim.")) continue;
    const cover = feedCover(event);
    if (cover && covered.has(cover)) continue;
    const at = time(event.occurredAt);
    if (at === null) continue;
    const lane = event.taskId ? laneByTask.get(event.taskId) : undefined;
    const candidateName = event.candidateId ? nameOf.get(event.candidateId) : undefined;
    const who = lane?.key ?? candidateName ?? null;
    events.push({
      id: `feed:${event.eventId}`,
      at,
      kind: "fact",
      laneId: lane?.id ?? null,
      candidateId: candidateName ? event.candidateId : null,
      eventType: event.eventType,
      data: event.data,
      type: event.eventType,
      actor: who ?? event.actor.id,
      detail: factDetail(event, who),
    });
  }
}

/** A tool step in words, for example `read_file src/cart.ts` -> `Reading src/cart.ts`. */
export function describeStep(step: string): string {
  const cut = step.indexOf(" ");
  const tool = cut < 0 ? step : step.slice(0, cut);
  const target = cut < 0 ? "" : step.slice(cut + 1);
  switch (tool) {
    case "read_file":
      return `Reading ${target}`;
    case "write_file":
      return `Writing ${target}`;
    case "list_files":
      return target ? `Listing ${target}` : "Listing files";
    case "run_command":
      return `Running ${target}`;
    default:
      return step;
  }
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
  /** Resources this lane's agent holds a Claim on, after the played facts. */
  claims: string[];
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
  /** Set once a Candidate merges. */
  promoted: { candidateId: string; generation: number; eventId: string } | null;
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
      claims: [],
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
    };
  }
  const conflicts = new Map<string, ConflictView>();
  const view: ActivityView = { lanes, candidates, conflicts: [], promoted: null };

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
        break;
      }
      case "claim": {
        const lane = event.laneId ? lanes[event.laneId] : undefined;
        if (!lane) break;
        const held = new Set(lane.claims);
        if (event.action === "acquired" || event.action === "renewed") held.add(event.resource);
        else if (event.action === "released" || event.action === "expired")
          held.delete(event.resource);
        lane.claims = [...held];
        break;
      }
      case "fact": {
        const lane = event.laneId ? lanes[event.laneId] : undefined;
        // Before its first run, a lane shows how far it got: ready, assigned, woken, routed.
        if (lane && !lane.forked) {
          if (event.eventType === "task.ready") {
            lane.status = "ready";
            lane.step = "Ready, waiting for an agent";
          } else if (event.eventType === "task.assigned") {
            lane.status = "assigned";
            lane.step = "Assigned, agent waking";
          } else if (event.eventType === "agent.woken") {
            lane.step = "Agent awake, compiling context";
          } else if (event.eventType === "model.route.decided") {
            const tier = event.data.selectedTier;
            if (tier === "haiku" || tier === "sonnet" || tier === "opus") lane.tier = tier;
            lane.step = `Routed to ${String(tier ?? "a model")}`;
          }
        }
        break;
      }
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
        break;
      }
      case "changeset": {
        const c = candidates[event.candidateId];
        if (!c) break;
        c.changeSets += 1;
        break;
      }
      case "check": {
        const c = candidates[event.candidateId];
        if (!c) break;
        c.status = c.status === "composing" ? "verifying" : c.status;
        c.checks[event.checkId] = { status: event.status, coverage: event.coverage };
        break;
      }
      case "candidate.status": {
        const c = candidates[event.candidateId];
        if (!c) break;
        c.status = event.status;
        c.reason = event.reason;
        break;
      }
      case "approval": {
        const c = candidates[event.candidateId];
        if (c) c.approval = event.decision;
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
        break;
      }
    }
  }

  if (complete) {
    for (const spec of model.lanes) {
      const lane = lanes[spec.id];
      if (!lane) continue;
      // Live progress of the running attempt: real calls and the last tool step.
      if (lane.status === "running" && spec.live && spec.live.attempt === lane.attempt) {
        lane.calls = spec.live.calls;
        lane.step = `Attempt ${lane.attempt} · ${
          spec.live.lastStep
            ? describeStep(spec.live.lastStep)
            : `model call ${spec.live.calls || 1}`
        }`;
      }
      // Statuses without a recorded time (blocked, cancelled) settle once every fact has played.
      if (["blocked", "cancelled", "assigned"].includes(spec.status)) lane.status = spec.status;
      if (spec.status === "assigned" && !lane.forked) lane.step = "Assigned, agent waking";
    }
    for (const spec of model.candidates) {
      const c = candidates[spec.id];
      if (c && c.status !== "promoted") c.status = spec.status;
    }
  }

  view.conflicts = [...conflicts.values()];
  return view;
}
