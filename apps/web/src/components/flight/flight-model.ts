import type {
  CandidateDetail,
  ConflictDetail,
  DecisionReceiptView,
  EvidenceRecord,
  FeedEvent,
  Intent,
  JsonValue,
  TaskDetail,
  TaskRun,
  WorkspaceChangeSet,
  WorkspaceFileStat,
  WorkspaceFork,
  WorkspaceView,
} from "../../lib/api";
import {
  type ActivityEvent,
  type ActivityInput,
  type ActivityModel,
  type ActivityView,
  type CandidateView,
  type ConflictView,
  deriveActivity,
  foldActivity,
  type LaneView,
} from "../agents/activity-model";
import type { EntityKind, EntityRef } from "./flight-store";

/**
 * Flight Control read model: ONE fold that every panel reads at one instant.
 *
 *   deriveFlight(input)        -> FlightModel   (all recorded facts of the Change, sorted by time)
 *   foldFlight(model, at|null) -> FlightState   (what was true at `at`; null = now, live)
 *
 * Live mode and the time machine use the same fold: live folds every fact, historical folds the
 * facts recorded at or before `at`. Nothing is interpolated or simulated. A fact the API does not
 * record is not shown; panels that need something not recorded say so: a missing result is not a
 * result.
 *
 * Facts come from the Change page's records (activity-model.ts) plus:
 *   Workspace     Task forks and their ChangeSets with changed files (workers/api workspace.ts)
 *   Decisions     Decision Receipts of the Change's Tasks (workers/api decisions.ts, optional)
 *
 * Every entity id used in EntityRef is the API id: task id, agent id, candidate id, conflict id,
 * ChangeSet id, file path, semantic resource, `${candidateId}:${checkId}`, decision id, event id.
 */

/* --------------------------------------------------------------------------------------------
 * Inputs
 * ------------------------------------------------------------------------------------------ */

export type { DecisionReceiptView };

export type FlightInput = ActivityInput & {
  /** Project workspace view (forks, ChangeSets, changed files). Null while loading or unavailable. */
  workspace: WorkspaceView | null;
  /** Decision Receipts of this Change. Null while loading or when the API is unavailable. */
  decisions: DecisionReceiptView[] | null;
  /** Wall clock used as the live instant (Date.now() at derive time). */
  now: number;
};

/* --------------------------------------------------------------------------------------------
 * Model: facts with time
 * ------------------------------------------------------------------------------------------ */

/** Who produced a Task's work. Shown next to every agent so fixture runs never read as model runs. */
export type WorkSource = "model" | "fixture" | "system" | "unknown";

export type RunState = {
  attempt: number;
  tier: TaskRun["tier"];
  /** `running` only while the fold instant is inside the attempt. */
  status: TaskRun["status"];
  startedAt: number;
  endedAt: number | null;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  failureKind: string | null;
  failureReason: string | null;
  decidedBy: TaskRun["decidedBy"];
  routeReasons: string[];
  escalatedFrom: TaskRun["tier"] | null;
  /** Live progress for the running attempt (calls and the last tool step), live mode only. */
  lastStep: string | null;
  /**
   * Model provider from the matching Decision Receipt (`anthropic` = Claude; older receipts:
   * `google-vertex-ai` = Gemini, `openrouter`),
   * null when no receipt names one. Shown as a tag so a viewer knows which model family ran.
   */
  provider: string | null;
};

export type FlightModel = {
  input: FlightInput;
  activity: ActivityModel;
  /** Every fact, oldest first (same order as `activity.events`). */
  events: ActivityEvent[];
  /** Time bounds of the recorded facts; `end` is `now` while the Change is live. */
  bounds: { start: number; end: number; live: boolean };
  /** Task id -> its Workspace fork (latest attempt's fork) when the Workspace view lists it. */
  forks: Record<string, WorkspaceFork>;
  /** ChangeSet id -> its Workspace record (commit, files, +/-). */
  changeSets: Record<string, WorkspaceChangeSet>;
  /** Task id -> ChangeSet ids, in creation order. */
  changeSetsOfTask: Record<string, string[]>;
  /** Task id -> who did the work, from feed actors (`system:fixture` is a fixture). */
  sources: Record<string, WorkSource>;
  /** Task id -> Decision Receipts, oldest first. */
  receipts: Record<string, DecisionReceiptView[]>;
};

const time = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? null : t;
};

/** `cs_<task id without its 4-char prefix>_<attempt>` (agents worker, agent-do.ts). */
export function taskOfChangeSet(changeSetId: string, tasks: TaskDetail[]): TaskDetail | undefined {
  if (!changeSetId.startsWith("cs_")) return undefined;
  const body = changeSetId.slice(3);
  const cut = body.lastIndexOf("_");
  const suffix = cut > 0 ? body.slice(0, cut) : body;
  return tasks.find((t) => t.id.slice(4) === suffix);
}

function sourceOf(actor: FeedEvent["actor"]): WorkSource {
  if (actor.id.includes("fixture")) return "fixture";
  if (actor.kind === "agent") return "model";
  if (actor.kind === "system") return "system";
  return "unknown";
}

const ACTIVE_CHANGE = new Set([
  "created",
  "compiling",
  "running",
  "verifying",
  "awaiting_approval",
]);
const ACTIVE_TASK = new Set(["ready", "assigned", "running"]);
const ACTIVE_CANDIDATE = new Set(["composing", "composed", "verifying"]);

export function deriveFlight(input: FlightInput): FlightModel {
  const activity = deriveActivity(input);
  const events = activity.events;
  const tasks = input.tasks;

  const forks: Record<string, WorkspaceFork> = {};
  const changeSets: Record<string, WorkspaceChangeSet> = {};
  const changeSetsOfTask: Record<string, string[]> = {};
  for (const fork of input.workspace?.workspaces ?? []) {
    if (fork.changeId !== input.change.id) continue;
    if (fork.taskId) {
      const current = forks[fork.taskId];
      if (!current || (fork.attempt ?? 0) >= (current.attempt ?? 0)) forks[fork.taskId] = fork;
    }
    if (fork.changeSet) {
      changeSets[fork.changeSet.id] = fork.changeSet;
      const task = fork.taskId ? tasks.find((t) => t.id === fork.taskId) : undefined;
      const owner = task ?? taskOfChangeSet(fork.changeSet.id, tasks);
      if (owner) {
        const list = changeSetsOfTask[owner.id] ?? [];
        if (!list.includes(fork.changeSet.id)) list.push(fork.changeSet.id);
        changeSetsOfTask[owner.id] = list;
      }
    }
  }
  for (const list of Object.values(changeSetsOfTask)) {
    list.sort(
      (a, b) => (time(changeSets[a]?.createdAt) ?? 0) - (time(changeSets[b]?.createdAt) ?? 0),
    );
  }

  // Who did the work: the actor of the Task's run or ChangeSet events. Model runs are agents;
  // the Wishlist fixture publishes as `system:fixture`.
  const sources: Record<string, WorkSource> = {};
  for (const event of input.feed ?? []) {
    if (!event.taskId) continue;
    if (
      event.eventType === "changeset.proposed" ||
      event.eventType === "task.completed" ||
      event.eventType === "task.started" ||
      event.eventType === "intent.declared"
    ) {
      const source = sourceOf(event.actor);
      const current = sources[event.taskId];
      // A fixture actor wins over a system actor; a model actor wins over both.
      if (!current || source === "model" || (source === "fixture" && current !== "model")) {
        sources[event.taskId] = source;
      }
    }
  }
  for (const task of tasks) {
    if (!sources[task.id] && task.runs.length > 0) sources[task.id] = "model";
  }

  const receipts: Record<string, DecisionReceiptView[]> = {};
  for (const receipt of input.decisions ?? []) {
    const list = receipts[receipt.taskId] ?? [];
    list.push(receipt);
    receipts[receipt.taskId] = list;
  }
  for (const list of Object.values(receipts)) {
    list.sort((a, b) => (time(a.createdAt) ?? 0) - (time(b.createdAt) ?? 0));
  }

  const changeCreated = time((input.change as { createdAt?: string }).createdAt);
  const first = events[0]?.at ?? changeCreated ?? input.now;
  const lastFact = events.length > 0 ? (events[events.length - 1]?.at ?? first) : first;
  const live =
    ACTIVE_CHANGE.has(input.change.status) ||
    tasks.some((t) => ACTIVE_TASK.has(t.status)) ||
    input.candidates.some((c) => ACTIVE_CANDIDATE.has(c.status));
  const start = Math.min(first, changeCreated ?? first);
  const end = live ? Math.max(lastFact, input.now) : Math.max(lastFact, start);

  return {
    input,
    activity,
    events,
    bounds: { start, end, live },
    forks,
    changeSets,
    changeSetsOfTask,
    sources,
    receipts,
  };
}

/* --------------------------------------------------------------------------------------------
 * State: the fold at one instant
 * ------------------------------------------------------------------------------------------ */

export type TaskState = {
  id: string;
  key: string;
  title: string;
  kind: TaskDetail["kind"];
  objective: string;
  agentId: string | null;
  source: WorkSource;
  riskTier: TaskDetail["riskTier"];
  complexity: TaskDetail["complexity"];
  semanticResources: string[];
  dependsOn: string[];
  /** Dependencies not completed at the fold instant: why this Task waits. */
  blockedBy: string[];
  /** Tasks that depend on this one. */
  dependents: string[];
  /** Status at the fold instant (from the lane fold), plus the recorded status when settled. */
  status: string;
  recordedStatus: TaskDetail["status"];
  lane: LaneView;
  /** Attempts started at or before the fold instant. */
  runs: RunState[];
  /** The attempt in progress at the fold instant, if any. */
  running: RunState | null;
  /** Intent declared at or before the fold instant (latest attempt's). */
  intent: Intent | null;
  /** Resources this Task's agent holds a Claim on at the fold instant. */
  claims: string[];
  /** ChangeSets published at or before the fold instant, oldest first. */
  changeSets: WorkspaceChangeSet[];
  fork: WorkspaceFork | null;
  /** Files this Task is expected to change (Intent) and did change (ChangeSets). */
  files: { expected: string[]; changed: WorkspaceFileStat[] };
  /** Candidates that composed one of this Task's ChangeSets, at the fold instant. */
  candidateIds: string[];
  /** Open or resolved conflicts this Task is part of, at the fold instant. */
  conflictIds: string[];
  /** Sum over attempts at the fold instant. */
  usage: { modelCalls: number; inputTokens: number; outputTokens: number; costUsd: number };
  /** The latest played fact about this Task, if any. */
  lastEvent: ActivityEvent | null;
  /** Epoch ms of the first wake and the last recorded fact. */
  startedAt: number | null;
  endedAt: number | null;
  /** True when this Task is on the longest dependency chain of the Work Graph (critical path). */
  critical: boolean;
  /** Work Graph layer (0 = no dependencies). */
  layer: number;
};

export type DependencyState = {
  /** `${dependsOnTaskId}->${taskId}` */
  id: string;
  from: string;
  to: string;
  /** `done` once the dependency completed; `blocking` while the dependent waits on it. */
  status: "blocking" | "done" | "failed" | "idle";
  critical: boolean;
};

export type CheckState = {
  checkId: string;
  kind: string;
  required: boolean;
  reason: string | null;
  command: string | null;
  /** Null until Evidence for it is recorded. */
  record: EvidenceRecord | null;
  status: EvidenceRecord["status"] | "pending";
  coverage: EvidenceRecord["coverage"] | null;
};

export type CandidateState = {
  id: string;
  letter: string;
  name: string;
  detail: CandidateDetail;
  view: CandidateView;
  /** Status at the fold instant. */
  status: string;
  reason: string | null;
  checks: CheckState[];
  /** Evidence recorded at or before the fold instant. */
  evidence: EvidenceRecord[];
  changeSetIds: string[];
  /** Tasks whose ChangeSets compose this Candidate. */
  taskIds: string[];
  forkedAt: number | null;
  approval: CandidateDetail["approval"];
  promotedGeneration: number | null;
  /** Screenshots recorded by browser checks: check id -> count (from Evidence metrics). */
  screenshots: { checkId: string; count: number; evidenceId: string }[];
};

export type ConflictState = ConflictView & {
  detail: ConflictDetail;
  /** Task ids of the two Intents, challenger first. */
  taskIds: [string, string];
  /** Candidate ids that embody each side at the fold instant (by composed ChangeSets). */
  candidateIds: [string | null, string | null];
};

export type ClaimHolding = {
  claimId: string;
  agentId: string;
  taskId: string | null;
  resource: string;
  status: "active" | "released" | "expired";
  since: number;
};

export type FileTouch = {
  taskId: string;
  kind: "expected" | "changed";
  at: number;
  adds: number | null;
  dels: number | null;
  changeSetId: string | null;
};

export type FileActivity = {
  path: string;
  /** Top-level area of the path (`src/cart` -> `cart`), for the semantic rows of the heatmap. */
  area: string;
  touches: FileTouch[];
  taskIds: string[];
  adds: number;
  dels: number;
  /** More than one Task changed this file: an overlap worth a look. */
  contended: boolean;
};

export type ResourceActivity = {
  resource: string;
  taskIds: string[];
  claimedBy: string[];
  conflictIds: string[];
  /** Named in a protected invariant of the Change. */
  protectedResource: boolean;
};

export type DecisionKind = "route" | "fork" | "gate" | "approval" | "promotion";

export type Cause = {
  ref: EntityRef;
  label: string;
  at: number | null;
};

export type DecisionState = {
  id: string;
  kind: DecisionKind;
  at: number;
  title: string;
  /** One short line: the verdict in words. */
  verdict: string;
  /** Who or what decided: `rules`, `clef`, `sonnet`, `opus`, `human`, `cas`, `policy`. */
  by: string;
  subject: EntityRef;
  /** The recorded inputs that fed the decision, oldest first. */
  causes: Cause[];
  /** The Decision Receipt or the typed decision record, for the raw payload view. */
  receipt: { [key: string]: JsonValue } | null;
};

export type FlightState = {
  /** The fold instant (epoch ms). */
  at: number;
  live: boolean;
  /** Canonical generation at the fold instant. */
  generation: number;
  tasks: Record<string, TaskState>;
  /** Task ids in Work Graph order: by layer, then by key. */
  taskOrder: string[];
  dependencies: DependencyState[];
  candidates: Record<string, CandidateState>;
  candidateOrder: string[];
  conflicts: ConflictState[];
  claims: ClaimHolding[];
  files: FileActivity[];
  resources: ResourceActivity[];
  decisions: DecisionState[];
  /** Facts at or before the fold instant, oldest first. */
  events: ActivityEvent[];
  playedIds: ReadonlySet<string>;
  /** What the latest played fact is about. */
  current: EntityRef | null;
  activity: ActivityView;
  counts: {
    tasks: number;
    woken: number;
    running: number;
    completed: number;
    failed: number;
    blocked: number;
    openConflicts: number;
    candidates: number;
    filesChanged: number;
    modelCalls: number;
    costUsd: number;
  };
};

function isIntent(outcome: TaskRun["outcome"]): outcome is Intent {
  return outcome !== null && "summary" in outcome;
}

function layers(tasks: TaskDetail[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, number>();
  const depth = (id: string, seen: Set<string>): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = (byId.get(id)?.dependsOn ?? []).filter((d) => byId.has(d));
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => depth(d, seen)));
    memo.set(id, value);
    return value;
  };
  for (const t of tasks) depth(t.id, new Set());
  return memo;
}

/** Tasks on a longest path of the dependency DAG (by edge count). */
function criticalPath(tasks: TaskDetail[], layer: Map<string, number>) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const longest = new Map<string, number>();
  const next = new Map<string, string | null>();
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    for (const d of t.dependsOn)
      if (byId.has(d)) dependents.set(d, [...(dependents.get(d) ?? []), t.id]);
  }
  const walk = (id: string, seen: Set<string>): number => {
    const cached = longest.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    let best = 0;
    let via: string | null = null;
    for (const dep of dependents.get(id) ?? []) {
      const value = 1 + walk(dep, seen);
      if (value > best) {
        best = value;
        via = dep;
      }
    }
    longest.set(id, best);
    next.set(id, via);
    return best;
  };
  for (const t of tasks) walk(t.id, new Set());
  const roots = tasks.filter((t) => (layer.get(t.id) ?? 0) === 0);
  let start: string | null = null;
  let max = -1;
  for (const r of roots) {
    const value = longest.get(r.id) ?? 0;
    if (value > max) {
      max = value;
      start = r.id;
    }
  }
  const critical = new Set<string>();
  while (start) {
    critical.add(start);
    start = next.get(start) ?? null;
  }
  return critical;
}

const areaOf = (path: string) => {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return "root";
  const skip = new Set(["src", "app", "lib", "packages", "apps"]);
  const meaningful = parts.slice(0, -1).filter((p) => !skip.has(p));
  return meaningful[0] ?? parts[0] ?? "root";
};

/** Folds the model at `at` (epoch ms). `null` folds every fact (live view). */
export function foldFlight(model: FlightModel, at: number | null): FlightState {
  const { input, activity } = model;
  const live = at === null;
  const instant = at ?? model.bounds.end;
  const played = new Set<string>();
  const events: ActivityEvent[] = [];
  for (const event of model.events) {
    if (event.at <= instant) {
      played.add(event.id);
      events.push(event);
    }
  }
  const complete = live || instant >= model.bounds.end;
  const view = foldActivity(activity, played, complete);

  const tasks = input.tasks;
  const layer = layers(tasks);
  const critical = criticalPath(tasks, layer);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const dependentsOf = new Map<string, string[]>();
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (byId.has(d)) dependentsOf.set(d, [...(dependentsOf.get(d) ?? []), t.id]);
    }
  }

  const lastEventOfLane = new Map<string, ActivityEvent>();
  const lastEventOfCandidate = new Map<string, ActivityEvent>();
  for (const event of events) {
    if ("laneId" in event && event.laneId) lastEventOfLane.set(event.laneId, event);
    if ("candidateId" in event && event.candidateId) {
      lastEventOfCandidate.set(event.candidateId, event);
    }
  }

  // Candidates first: Task states reference the Candidates that composed their ChangeSets.
  const candidateTasks = new Map<string, string[]>();
  const candidates: Record<string, CandidateState> = {};
  const candidateOrder: string[] = [];
  for (const spec of activity.candidates) {
    const detail = input.candidates.find((c) => c.id === spec.id);
    const cv = view.candidates[spec.id];
    if (!detail || !cv) continue;
    const forkedAt = time(detail.createdAt);
    if (!cv.forked && !live && forkedAt !== null && forkedAt > instant) continue;
    const records = (input.evidence[spec.id] ?? []).filter((r) => {
      const t = time(r.completedAt) ?? time(r.startedAt);
      return t !== null && t <= instant;
    });
    const byCheck = new Map<string, EvidenceRecord>();
    for (const r of records) byCheck.set(r.checkId, r);
    const planChecks = detail.plan?.checks ?? [];
    const checks: CheckState[] = spec.checks.map((c) => {
      const plan = planChecks.find((p) => p.checkId === c.checkId);
      const record = byCheck.get(c.checkId) ?? null;
      return {
        checkId: c.checkId,
        kind: c.kind,
        required: c.required,
        reason: plan?.reason ?? null,
        command: plan?.command ?? plan?.procedure ?? null,
        record,
        status: record?.status ?? "pending",
        coverage: record?.coverage ?? null,
      };
    });
    const taskIds = detail.changeSetIds
      .map((id) => taskOfChangeSet(id, tasks)?.id)
      .filter((id): id is string => !!id);
    for (const taskId of taskIds) {
      candidateTasks.set(taskId, [...(candidateTasks.get(taskId) ?? []), spec.id]);
    }
    const approvedAt = time(detail.approval?.createdAt);
    const approval =
      detail.approval && approvedAt !== null && approvedAt <= instant ? detail.approval : null;
    const promoted = cv.status === "promoted";
    candidates[spec.id] = {
      id: spec.id,
      letter: spec.letter,
      name: spec.name,
      detail,
      view: cv,
      status: cv.status,
      reason: cv.reason,
      checks,
      evidence: records,
      changeSetIds: detail.changeSetIds,
      taskIds,
      forkedAt,
      approval,
      promotedGeneration: promoted ? detail.promotedGeneration : null,
      screenshots: records
        .filter((r) => typeof r.metrics?.screenshots === "number" && r.metrics.screenshots > 0)
        .map((r) => ({
          checkId: r.checkId,
          count: r.metrics?.screenshots ?? 0,
          evidenceId: r.evidenceId,
        })),
    };
    candidateOrder.push(spec.id);
  }

  // Conflicts at the instant.
  const conflicts: ConflictState[] = [];
  const conflictsOfTask = new Map<string, string[]>();
  for (const cv of view.conflicts) {
    const detail = input.conflicts.find((c) => c.id === cv.id);
    if (!detail) continue;
    const taskIds: [string, string] = [cv.fromLaneId, cv.toLaneId];
    const side = (taskId: string) =>
      candidateOrder.find((id) => candidates[id]?.taskIds.includes(taskId)) ?? null;
    conflicts.push({
      ...cv,
      detail,
      taskIds,
      candidateIds: [side(taskIds[0]), side(taskIds[1])],
    });
    for (const taskId of taskIds) {
      conflictsOfTask.set(taskId, [...(conflictsOfTask.get(taskId) ?? []), cv.id]);
    }
  }

  // Claims at the instant: fold the claim facts that played.
  const claimMap = new Map<string, ClaimHolding>();
  const laneByAgent = new Map(
    tasks.filter((t) => t.assignedAgentId).map((t) => [t.assignedAgentId as string, t.id]),
  );
  for (const event of events) {
    if (event.kind !== "claim") continue;
    const current = claimMap.get(event.claimId);
    const agentId = current?.agentId ?? agentOfClaim(event, input);
    const taskId = event.laneId ?? (agentId ? (laneByAgent.get(agentId) ?? null) : null);
    const status: ClaimHolding["status"] =
      event.action === "acquired" || event.action === "renewed"
        ? "active"
        : event.action === "released"
          ? "released"
          : "expired";
    claimMap.set(event.claimId, {
      claimId: event.claimId,
      agentId: agentId ?? "",
      taskId,
      resource: event.resource,
      status,
      since: current?.status === "active" && status === "active" ? current.since : event.at,
    });
  }
  const claims = [...claimMap.values()];

  // Tasks.
  const taskStates: Record<string, TaskState> = {};
  const fileMap = new Map<string, FileActivity>();
  const touchFile = (path: string, touch: FileTouch) => {
    let file = fileMap.get(path);
    if (!file) {
      file = {
        path,
        area: areaOf(path),
        touches: [],
        taskIds: [],
        adds: 0,
        dels: 0,
        contended: false,
      };
      fileMap.set(path, file);
    }
    file.touches.push(touch);
    if (!file.taskIds.includes(touch.taskId)) file.taskIds.push(touch.taskId);
    if (touch.kind === "changed") {
      file.adds += touch.adds ?? 0;
      file.dels += touch.dels ?? 0;
    }
  };

  let modelCalls = 0;
  let costUsd = 0;
  for (const task of tasks) {
    const lane = view.lanes[task.id];
    if (!lane) continue;
    const runs: RunState[] = [];
    let previousTier: TaskRun["tier"] | null = null;
    let intent: Intent | null = null;
    for (const run of task.runs) {
      const startedAt = time(run.startedAt);
      if (startedAt === null || startedAt > instant) {
        previousTier = run.tier;
        continue;
      }
      const endedAt = time(run.endedAt);
      const ended = endedAt !== null && endedAt <= instant && run.status !== "running";
      const progress = live
        ? input.progress?.find((p) => p.taskId === task.id && p.attempt === run.attempt)
        : undefined;
      const state: RunState = {
        attempt: run.attempt,
        tier: run.tier,
        status: ended ? run.status : "running",
        startedAt,
        endedAt: ended ? endedAt : null,
        modelCalls: ended ? run.modelCalls : Math.max(run.modelCalls, progress?.modelCalls ?? 0),
        inputTokens: ended
          ? run.inputTokens
          : Math.max(run.inputTokens, progress?.inputTokens ?? 0),
        outputTokens: ended
          ? run.outputTokens
          : Math.max(run.outputTokens, progress?.outputTokens ?? 0),
        costUsd: ended ? run.costUsd : Math.max(run.costUsd, progress?.costUsd ?? 0),
        failureKind: ended && run.status === "failed" ? run.failureKind : null,
        failureReason:
          ended && run.status === "failed" && run.outcome && "reason" in run.outcome
            ? run.outcome.reason
            : null,
        decidedBy: run.decidedBy,
        routeReasons: run.routeReasons,
        escalatedFrom: previousTier !== null && previousTier !== run.tier ? previousTier : null,
        lastStep: !ended && live ? (progress?.lastStep ?? null) : null,
        provider: providerOf(model.receipts[task.id] ?? [], run.tier, startedAt),
      };
      // Historical folds of a still-running attempt cannot know the calls at that instant.
      if (!ended && !live) {
        state.modelCalls = 0;
        state.inputTokens = 0;
        state.outputTokens = 0;
        state.costUsd = 0;
      }
      runs.push(state);
      if (ended && isIntent(run.outcome)) intent = run.outcome;
      previousTier = run.tier;
    }
    const running = runs.find((r) => r.status === "running") ?? null;
    const changeSets = (model.changeSetsOfTask[task.id] ?? [])
      .map((id) => model.changeSets[id])
      .filter((cs): cs is WorkspaceChangeSet => !!cs && (time(cs.createdAt) ?? 0) <= instant);
    const changed: WorkspaceFileStat[] = [];
    for (const cs of changeSets) {
      const csAt = time(cs.createdAt) ?? instant;
      for (const stat of cs.fileStats) {
        changed.push(stat);
        touchFile(stat.path, {
          taskId: task.id,
          kind: "changed",
          at: csAt,
          adds: stat.adds,
          dels: stat.dels,
          changeSetId: cs.id,
        });
      }
      for (const path of cs.files) {
        if (!cs.fileStats.some((s) => s.path === path)) {
          touchFile(path, {
            taskId: task.id,
            kind: "changed",
            at: csAt,
            adds: null,
            dels: null,
            changeSetId: cs.id,
          });
        }
      }
    }
    const expected = intent?.expectedFiles ?? [];
    const intentAt = runs.findLast((r) => r.endedAt !== null)?.endedAt ?? instant;
    for (const path of expected) {
      touchFile(path, {
        taskId: task.id,
        kind: "expected",
        at: intentAt,
        adds: null,
        dels: null,
        changeSetId: null,
      });
    }
    const blockedBy = task.dependsOn.filter((d) => {
      const dep = view.lanes[d];
      return dep ? dep.status !== "completed" : false;
    });
    const usage = runs.reduce(
      (acc, r) => ({
        modelCalls: acc.modelCalls + r.modelCalls,
        inputTokens: acc.inputTokens + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
        costUsd: acc.costUsd + r.costUsd,
      }),
      { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    );
    modelCalls += usage.modelCalls;
    costUsd += usage.costUsd;
    const lastEvent = lastEventOfLane.get(task.id) ?? null;
    taskStates[task.id] = {
      id: task.id,
      key: task.key,
      title: task.title,
      kind: task.kind,
      objective: task.objective,
      agentId: task.assignedAgentId,
      source: model.sources[task.id] ?? (task.runs.length > 0 ? "model" : "unknown"),
      riskTier: task.riskTier,
      complexity: task.complexity,
      semanticResources: task.semanticResources,
      dependsOn: task.dependsOn.filter((d) => byId.has(d)),
      blockedBy,
      dependents: dependentsOf.get(task.id) ?? [],
      status: lane.status,
      recordedStatus: task.status,
      lane,
      runs,
      running,
      intent,
      claims: lane.claims,
      changeSets,
      fork: model.forks[task.id] ?? null,
      files: { expected, changed },
      candidateIds: candidateTasks.get(task.id) ?? [],
      conflictIds: conflictsOfTask.get(task.id) ?? [],
      usage,
      lastEvent,
      startedAt: runs[0]?.startedAt ?? null,
      endedAt: lastEvent?.at ?? null,
      critical: critical.has(task.id),
      layer: layer.get(task.id) ?? 0,
    };
  }
  const taskOrder = [...tasks]
    .sort((a, b) => (layer.get(a.id) ?? 0) - (layer.get(b.id) ?? 0) || a.key.localeCompare(b.key))
    .map((t) => t.id);

  const dependencies: DependencyState[] = [];
  for (const task of tasks) {
    for (const d of task.dependsOn) {
      if (!byId.has(d)) continue;
      const dep = taskStates[d];
      const dependent = taskStates[task.id];
      const status: DependencyState["status"] =
        dep?.status === "completed"
          ? "done"
          : dep?.status === "failed" || dep?.status === "blocked"
            ? "failed"
            : dependent && ["pending", "ready"].includes(dependent.status) && dep?.lane.forked
              ? "blocking"
              : dependent && ["pending", "ready"].includes(dependent.status)
                ? "blocking"
                : "idle";
      dependencies.push({
        id: `${d}->${task.id}`,
        from: d,
        to: task.id,
        status,
        critical: critical.has(d) && critical.has(task.id),
      });
    }
  }

  const files = [...fileMap.values()].map((f) => ({
    ...f,
    contended:
      f.taskIds.filter((id) => f.touches.some((t) => t.taskId === id && t.kind === "changed"))
        .length > 1,
  }));
  files.sort((a, b) => b.touches.length - a.touches.length || a.path.localeCompare(b.path));

  const protectedWords = input.change.invariants.join(" ").toLowerCase();
  const resourceMap = new Map<string, ResourceActivity>();
  const resource = (key: string) => {
    let r = resourceMap.get(key);
    if (!r) {
      r = {
        resource: key,
        taskIds: [],
        claimedBy: [],
        conflictIds: [],
        protectedResource: key
          .split(/[:.]/)
          .some((part) => part.length > 2 && protectedWords.includes(part.toLowerCase())),
      };
      resourceMap.set(key, r);
    }
    return r;
  };
  for (const task of tasks) {
    for (const key of task.semanticResources) {
      const r = resource(key);
      if (!r.taskIds.includes(task.id)) r.taskIds.push(task.id);
    }
  }
  for (const claim of claims) {
    if (claim.status !== "active") continue;
    const r = resource(claim.resource);
    if (!r.claimedBy.includes(claim.agentId)) r.claimedBy.push(claim.agentId);
  }
  for (const c of conflicts) resource(c.resource).conflictIds.push(c.id);
  const resources = [...resourceMap.values()].sort((a, b) => a.resource.localeCompare(b.resource));

  const decisions = deriveDecisions(model, taskStates, candidates, conflicts, claims, instant);

  const generation = view.promoted?.generation ?? input.change.baseGeneration;
  const current = currentRef(events[events.length - 1] ?? null);
  const states = Object.values(taskStates);

  return {
    at: instant,
    live,
    generation,
    tasks: taskStates,
    taskOrder,
    dependencies,
    candidates,
    candidateOrder,
    conflicts,
    claims,
    files,
    resources,
    decisions,
    events,
    playedIds: played,
    current,
    activity: view,
    counts: {
      tasks: states.length,
      woken: states.filter((t) => t.lane.forked).length,
      running: states.filter((t) => t.status === "running").length,
      completed: states.filter((t) => t.status === "completed").length,
      failed: states.filter((t) => t.status === "failed").length,
      blocked: states.filter((t) => t.status === "blocked" || t.blockedBy.length > 0).length,
      openConflicts: conflicts.filter((c) => c.open).length,
      candidates: candidateOrder.length,
      filesChanged: files.filter((f) => f.touches.some((t) => t.kind === "changed")).length,
      modelCalls,
      costUsd,
    },
  };
}

/** The receipt written for this attempt: same tier, created within two minutes of the start. */
function receiptOf(
  receipts: DecisionReceiptView[],
  tier: TaskRun["tier"],
  startedAt: number,
): DecisionReceiptView | null {
  return (
    receipts.find(
      (r) => r.selectedTier === tier && Math.abs((time(r.createdAt) ?? 0) - startedAt) < 120_000,
    ) ?? null
  );
}

function providerOf(receipts: DecisionReceiptView[], tier: TaskRun["tier"], startedAt: number) {
  const provider = receiptOf(receipts, tier, startedAt)?.receipt.provider;
  return typeof provider === "string" ? provider : null;
}

/** Short display name of a provider id: `anthropic` -> `Claude`, `google-vertex-ai` -> `Gemini`. */
export function providerName(provider: string | null): string | null {
  if (!provider) return null;
  if (provider === "anthropic") return "Claude";
  if (provider === "google-vertex-ai") return "Gemini";
  if (provider === "openrouter") return "OpenRouter";
  return provider;
}

function agentOfClaim(event: Extract<ActivityEvent, { kind: "claim" }>, input: FlightInput) {
  const fact = input.claims?.find((c) => `claim:${c.eventId}` === event.id);
  return fact?.agentId ?? null;
}

/** The entity a fact is about, for "current step" highlighting. */
export function currentRef(event: ActivityEvent | null): EntityRef | null {
  if (!event) return null;
  switch (event.kind) {
    case "lane.fork":
    case "run.start":
    case "run.end":
    case "intent":
      return { kind: "task", id: event.laneId };
    case "claim":
      return event.laneId
        ? { kind: "task", id: event.laneId }
        : { kind: "resource", id: event.resource };
    case "challenge":
      return { kind: "conflict", id: event.conflictId };
    case "conflict.resolved":
      return { kind: "conflict", id: event.conflictId };
    case "candidate.fork":
    case "candidate.status":
    case "approval":
    case "promoted":
      return { kind: "candidate", id: event.candidateId };
    case "changeset":
      return { kind: "changeset", id: event.changeSetId };
    case "check":
      return { kind: "check", id: `${event.candidateId}:${event.checkId}` };
    case "fact":
      return event.laneId
        ? { kind: "task", id: event.laneId }
        : event.candidateId
          ? { kind: "candidate", id: event.candidateId }
          : { kind: "event", id: event.id };
  }
}

/* --------------------------------------------------------------------------------------------
 * Decisions and their causal history
 * ------------------------------------------------------------------------------------------ */

function deriveDecisions(
  model: FlightModel,
  tasks: Record<string, TaskState>,
  candidates: Record<string, CandidateState>,
  conflicts: ConflictState[],
  claims: ClaimHolding[],
  instant: number,
): DecisionState[] {
  const out: DecisionState[] = [];

  for (const task of Object.values(tasks)) {
    const receipts = model.receipts[task.id] ?? [];
    for (const run of task.runs) {
      const receipt = receiptOf(receipts, run.tier, run.startedAt);
      const causes: Cause[] = [
        {
          ref: { kind: "task", id: task.id },
          label: `${task.key}: ${task.complexity} · risk ${task.riskTier}`,
          at: null,
        },
      ];
      const previous = task.runs.find((r) => r.attempt === run.attempt - 1);
      if (previous) {
        causes.push({
          ref: { kind: "event", id: `${task.id}:run${previous.attempt}:end` },
          label: `Attempt ${previous.attempt} on ${previous.tier} ${previous.status}${previous.failureKind ? ` (${previous.failureKind})` : ""}`,
          at: previous.endedAt,
        });
      }
      for (const conflictId of task.conflictIds) {
        const c = conflicts.find((x) => x.id === conflictId);
        if (
          c &&
          (model.events.find((e) => e.id === c.eventId)?.at ?? Number.POSITIVE_INFINITY) <=
            run.startedAt
        ) {
          causes.push({
            ref: { kind: "conflict", id: c.id },
            label: `Conflict on ${c.resource}`,
            at: null,
          });
        }
      }
      const reasons =
        run.routeReasons.length > 0
          ? run.routeReasons
          : ((receipt?.receipt.reasons as string[] | undefined) ?? []);
      out.push({
        id: `route:${task.id}:${run.attempt}`,
        kind: "route",
        at: run.startedAt,
        title: `${task.key} routed to ${run.tier}${run.escalatedFrom ? ` (escalated from ${run.escalatedFrom})` : ""}`,
        verdict:
          reasons.length > 0 ? reasons.join("; ") : `Attempt ${run.attempt} runs on ${run.tier}.`,
        by: run.decidedBy ?? receipt?.decidedBy ?? "rules",
        subject: { kind: "task", id: task.id },
        causes,
        receipt: receipt
          ? { ...receipt.receipt, decisionType: receipt.decisionType, receiptId: receipt.id }
          : null,
      });
    }
  }

  for (const c of conflicts) {
    const d = c.detail;
    const at = time(d.updatedAt) ?? time(d.createdAt) ?? instant;
    if (at > instant) continue;
    const [a, b] = c.taskIds;
    const causes: Cause[] = [
      {
        ref: { kind: "event", id: c.eventId },
        label: `Overlap on ${c.resource} detected`,
        at: time(d.createdAt),
      },
      {
        ref: { kind: "task", id: a },
        label: `${tasks[a]?.key ?? a}: ${d.intents[0].summary}`,
        at: time(d.intents[0].createdAt),
      },
      {
        ref: { kind: "task", id: b },
        label: `${tasks[b]?.key ?? b}: ${d.intents[1].summary}`,
        at: time(d.intents[1].createdAt),
      },
      ...d.signals.map((s) => ({
        ref: { kind: "conflict" as const, id: c.id },
        label: `${s.severity} ${s.kind.replace(/_/g, " ")}: ${s.detail}`,
        at: null,
      })),
      ...claims
        .filter((cl) => cl.resource === c.resource)
        .map((cl) => ({
          ref: { kind: "resource" as const, id: cl.resource },
          label: `Claim ${cl.status} by ${tasks[cl.taskId ?? ""]?.key ?? cl.agentId}`,
          at: cl.since,
        })),
    ];
    const fd = d.forkDecision;
    out.push({
      id: `fork:${c.id}`,
      kind: "fork",
      at,
      title: `Conflict on ${c.resource}: ${fd.kind === "fork" ? "fork Candidates" : fd.kind === "blocked" ? "fork blocked" : "no fork"}`,
      verdict:
        fd.kind === "fork"
          ? fd.reason
          : fd.kind === "blocked"
            ? `Candidate limit of ${fd.maxCandidates} reached.`
            : fd.reason.replace(/_/g, " "),
      by: d.review.decidedBy,
      subject: { kind: "conflict", id: c.id },
      causes,
      receipt: {
        state: d.state,
        recommendedAction: d.recommendedAction,
        review: d.review,
        forkDecision: fd,
      },
    });
  }

  for (const cand of Object.values(candidates)) {
    const d = cand.detail;
    const gateAt =
      cand.evidence.reduce((max, r) => Math.max(max, time(r.completedAt) ?? 0), 0) ||
      (time(d.updatedAt) ?? instant);
    if (
      d.gate &&
      gateAt <= instant &&
      (cand.status === "verified" || cand.status === "rejected" || cand.status === "promoted")
    ) {
      const causes: Cause[] = cand.evidence.map((r) => ({
        ref: { kind: "check" as const, id: `${cand.id}:${r.checkId}` },
        label: `${r.checkId}: ${r.status} (${r.coverage.replace(/_/g, " ")})`,
        at: time(r.completedAt),
      }));
      for (const taskId of cand.taskIds) {
        causes.unshift({
          ref: { kind: "task", id: taskId },
          label: `ChangeSet of ${tasks[taskId]?.key ?? taskId} composed`,
          at: cand.forkedAt,
        });
      }
      out.push({
        id: `gate:${cand.id}`,
        kind: "gate",
        at: gateAt,
        title: `${cand.name} ${d.gate.promotable ? "verified" : "rejected"}`,
        verdict: d.gate.promotable
          ? `Every required check passed${d.gate.p95Ms !== undefined ? ` · p95 ${Math.round(d.gate.p95Ms)} ms` : ""}.`
          : (cand.reason ?? d.gate.gaps.map((g) => `${g.checkId}: ${g.reason}`).join("; ")),
        by: "policy",
        subject: { kind: "candidate", id: cand.id },
        causes,
        receipt: {
          gate: d.gate,
          plan: d.plan
            ? {
                requiredCheckIds: d.plan.requiredCheckIds,
                humanApprovalRequired: d.plan.humanApprovalRequired,
                policyVersion: d.plan.policyVersion,
              }
            : null,
        },
      });
    }
    if (cand.approval) {
      const at = time(cand.approval.createdAt) ?? instant;
      out.push({
        id: `approval:${cand.id}`,
        kind: "approval",
        at,
        title: `${cand.name} ${cand.approval.decision === "granted" ? "approved" : "rejected"} by a person`,
        verdict:
          cand.approval.reason ??
          `Decision ${cand.approval.decision}, bound to tree ${cand.approval.candidateTree.slice(0, 12)}.`,
        by: "human",
        subject: { kind: "candidate", id: cand.id },
        causes: [
          {
            ref: { kind: "decision", id: `gate:${cand.id}` },
            label: "Verification verdict",
            at: gateAt,
          },
          {
            ref: { kind: "candidate", id: cand.id },
            label: `Approval required by policy ${cand.approval.policyVersion}`,
            at: null,
          },
        ],
        receipt: { ...cand.approval },
      });
    }
    if (cand.promotedGeneration !== null) {
      const promotedEvent = model.events.find(
        (e) => e.kind === "promoted" && e.candidateId === cand.id,
      );
      const at = promotedEvent?.at ?? instant;
      if (at <= instant) {
        out.push({
          id: `promotion:${cand.id}`,
          kind: "promotion",
          at,
          title: `${cand.name} promoted: S${d.baseGeneration} → S${cand.promotedGeneration}`,
          verdict: `Compare-and-swap on generation ${d.baseGeneration} succeeded.`,
          by: "cas",
          subject: { kind: "candidate", id: cand.id },
          causes: [
            {
              ref: { kind: "decision", id: `gate:${cand.id}` },
              label: "Verification verdict",
              at: gateAt,
            },
            ...(cand.approval
              ? [
                  {
                    ref: { kind: "decision" as const, id: `approval:${cand.id}` },
                    label: "Human approval",
                    at: time(cand.approval.createdAt),
                  },
                ]
              : []),
            {
              ref: { kind: "candidate", id: cand.id },
              label: `Expected generation S${d.baseGeneration}`,
              at: null,
            },
          ],
          receipt: {
            baseGeneration: d.baseGeneration,
            promotedGeneration: cand.promotedGeneration,
            composedTree: d.composedTree,
            baseTree: d.baseTree,
          },
        });
      }
    }
  }

  out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return out;
}

/* --------------------------------------------------------------------------------------------
 * Relations and labels (shared by every panel)
 * ------------------------------------------------------------------------------------------ */

export const refKey = (ref: EntityRef) => `${ref.kind}:${ref.id}`;

/** Resolves an agent id to its Task lane, so a click on an agent selects its Task everywhere. */
export function taskOfAgent(state: FlightState, agentId: string): TaskState | undefined {
  return Object.values(state.tasks).find((t) => t.agentId === agentId);
}

/**
 * Entities related to `ref`: panels dim everything else when something is selected. Includes
 * `ref` itself. For a Task: its dependencies, dependents, files, ChangeSets, Candidates, conflicts
 * and resources. For a file: the Tasks that touched it. And so on.
 */
export function relatedRefs(state: FlightState, ref: EntityRef | null): ReadonlySet<string> {
  const out = new Set<string>();
  if (!ref) return out;
  const add = (kind: EntityKind, id: string | null | undefined) => {
    if (id) out.add(`${kind}:${id}`);
  };
  add(ref.kind, ref.id);
  const task = (id: string) => {
    const t = state.tasks[id];
    if (!t) return;
    add("task", t.id);
    add("agent", t.agentId);
    for (const d of t.dependsOn) {
      add("task", d);
      add("dependency", `${d}->${t.id}`);
    }
    for (const d of t.dependents) {
      add("task", d);
      add("dependency", `${t.id}->${d}`);
    }
    for (const f of t.files.changed) add("file", f.path);
    for (const f of t.files.expected) add("file", f);
    for (const cs of t.changeSets) add("changeset", cs.id);
    for (const c of t.candidateIds) add("candidate", c);
    for (const c of t.conflictIds) add("conflict", c);
    for (const r of t.semanticResources) add("resource", r);
    for (const r of t.claims) add("resource", r);
  };
  switch (ref.kind) {
    case "task":
      task(ref.id);
      break;
    case "agent": {
      const t = taskOfAgent(state, ref.id);
      if (t) task(t.id);
      break;
    }
    case "dependency": {
      const [from, to] = ref.id.split("->");
      add("task", from);
      add("task", to);
      break;
    }
    case "candidate": {
      const c = state.candidates[ref.id];
      if (!c) break;
      for (const t of c.taskIds) add("task", t);
      for (const cs of c.changeSetIds) add("changeset", cs);
      for (const ch of c.checks) add("check", `${c.id}:${ch.checkId}`);
      for (const conflict of state.conflicts) {
        if (conflict.candidateIds.includes(c.id)) add("conflict", conflict.id);
      }
      for (const d of state.decisions) if (d.subject.id === c.id) add("decision", d.id);
      break;
    }
    case "conflict": {
      const c = state.conflicts.find((x) => x.id === ref.id);
      if (!c) break;
      for (const t of c.taskIds) add("task", t);
      for (const cand of c.candidateIds) add("candidate", cand);
      add("resource", c.resource);
      add("decision", `fork:${c.id}`);
      break;
    }
    case "changeset": {
      const t = Object.values(state.tasks).find((x) => x.changeSets.some((cs) => cs.id === ref.id));
      if (t) add("task", t.id);
      const cs = t?.changeSets.find((x) => x.id === ref.id);
      for (const f of cs?.files ?? []) add("file", f);
      for (const c of Object.values(state.candidates))
        if (c.changeSetIds.includes(ref.id)) add("candidate", c.id);
      break;
    }
    case "file": {
      const f = state.files.find((x) => x.path === ref.id);
      for (const t of f?.taskIds ?? []) add("task", t);
      for (const touch of f?.touches ?? []) add("changeset", touch.changeSetId);
      break;
    }
    case "resource": {
      const r = state.resources.find((x) => x.resource === ref.id);
      for (const t of r?.taskIds ?? []) add("task", t);
      for (const c of r?.conflictIds ?? []) add("conflict", c);
      for (const cl of state.claims) if (cl.resource === ref.id) add("task", cl.taskId);
      break;
    }
    case "check": {
      const [candidateId] = ref.id.split(":");
      add("candidate", candidateId);
      add("decision", `gate:${candidateId}`);
      break;
    }
    case "decision": {
      const d = state.decisions.find((x) => x.id === ref.id);
      if (!d) break;
      add(d.subject.kind, d.subject.id);
      for (const c of d.causes) add(c.ref.kind, c.ref.id);
      break;
    }
    case "event": {
      const e = state.events.find((x) => x.id === ref.id);
      const c = currentRef(e ?? null);
      if (c) add(c.kind, c.id);
      break;
    }
  }
  return out;
}

/** A short human label for any entity, for the inspector title, palette rows and crumbs. */
export function entityLabel(state: FlightState, ref: EntityRef): { title: string; kicker: string } {
  switch (ref.kind) {
    case "task": {
      const t = state.tasks[ref.id];
      return { kicker: `Task · ${t?.key ?? ref.id}`, title: t?.title ?? ref.id };
    }
    case "agent": {
      const t = taskOfAgent(state, ref.id);
      return { kicker: "Agent", title: t ? `${t.key} agent` : ref.id };
    }
    case "dependency": {
      const [from, to] = ref.id.split("->");
      return {
        kicker: "Dependency",
        title: `${state.tasks[from ?? ""]?.key ?? from} → ${state.tasks[to ?? ""]?.key ?? to}`,
      };
    }
    case "candidate":
      return { kicker: "Candidate", title: state.candidates[ref.id]?.name ?? ref.id };
    case "conflict": {
      const c = state.conflicts.find((x) => x.id === ref.id);
      return { kicker: "Conflict", title: c ? `On ${c.resource}` : ref.id };
    }
    case "changeset":
      return { kicker: "ChangeSet", title: ref.id };
    case "file":
      return { kicker: "File", title: ref.id };
    case "resource":
      return { kicker: "Semantic resource", title: ref.id };
    case "check": {
      const [candidateId, checkId] = ref.id.split(":");
      return {
        kicker: `Check · ${state.candidates[candidateId ?? ""]?.name ?? candidateId}`,
        title: checkId ?? ref.id,
      };
    }
    case "decision": {
      const d = state.decisions.find((x) => x.id === ref.id);
      return { kicker: `Decision · ${d?.kind ?? ""}`, title: d?.title ?? ref.id };
    }
    case "event": {
      const e = state.events.find((x) => x.id === ref.id);
      return { kicker: `Event · ${e?.type ?? ""}`, title: e?.detail ?? ref.id };
    }
  }
}
