import type {
  ChangeSummary,
  DeadLetter,
  FeedEvent,
  LimitBlock,
  TaskDetail,
  TaskRun,
} from "../../lib/api";
import { generation, truncate } from "../../lib/format";
import { renderNow } from "../../lib/render-time";

/**
 * Pure model of the Project execution timeline: people (requesters) -> their Changes -> one row
 * per Task with its attempts as bars, Change markers from the recorded event feed, and the items
 * that need a person. Every bar is a recorded attempt (`task_runs` start and end); every marker
 * is a recorded event at its recorded time. Nothing is estimated.
 */

export type BarStatus = "running" | "completed" | "failed" | "cancelled";

export type TimelineBar = {
  key: string;
  attempt: number;
  tier: TaskRun["tier"];
  status: BarStatus;
  start: number;
  /** Null while the attempt runs: the bar grows to "now". */
  end: number | null;
  failureKind: string | null;
  modelCalls: number;
};

export type TimelineTask = {
  id: string;
  key: string;
  title: string;
  status: TaskDetail["status"];
  agentId: string | null;
  bars: TimelineBar[];
};

export type MarkerKind =
  | "request"
  | "plan"
  | "conflict"
  | "clarify"
  | "approval"
  | "verified"
  | "rejected"
  | "stale"
  | "promotion"
  | "release"
  | "release_failed"
  | "cancelled";

export type TimelineMarker = {
  key: string;
  kind: MarkerKind;
  at: number;
  label: string;
  detail: string;
  changeId: string;
  candidateId: string | null;
};

export type TimelineChange = {
  id: string;
  goal: string;
  status: string;
  start: number;
  /** Null while the Change is in flight: the span grows to "now". */
  end: number | null;
  tasks: TimelineTask[];
  /** Tasks not read yet (first load) or not readable. */
  tasksState: "loading" | "ready" | "error";
  markers: TimelineMarker[];
};

export type TimelinePerson = {
  key: string;
  name: string;
  isYou: boolean;
  isOwner: boolean;
  changes: TimelineChange[];
};

export type AttentionKind =
  | "clarify"
  | "approval"
  | "blocked"
  | "budget"
  | "limit"
  | "dead_letter"
  | "conflict";

export type AttentionItem = {
  key: string;
  kind: AttentionKind;
  title: string;
  detail: string;
  at: number | null;
  /** The Change page to open; null links to the operator banners on the Project page. */
  changeId: string | null;
};

export type TimelineModel = {
  people: TimelinePerson[];
  start: number;
  /** Latest recorded instant; "now" extends it while anything runs. */
  end: number;
  live: boolean;
  /** Promotions, for the full-height rules and axis labels. */
  promotions: TimelineMarker[];
  attention: AttentionItem[];
  counts: { changes: number; tasks: number; running: number; people: number };
};

/** Change statuses with work in flight (mirrors components/project/status.tsx). */
export const LIVE_CHANGE_STATUSES = new Set([
  "created",
  "compiling",
  "running",
  "verifying",
  "awaiting_approval",
  "needs_input",
  "promoting",
  "releasing",
]);

/** Event types the timeline draws. Everything else in the feed is dropped on read. */
export const MARKER_EVENT_TYPES = new Set([
  "change.created",
  "change.compiled",
  "change.cancelled",
  "conflict.reviewed",
  "conflict.integrated",
  "challenge.created",
  "challenge.resolved",
  "approval.requested",
  "verification.completed",
  "candidate.stale",
  "canonical.advanced",
  "deployment.completed",
  "deployment.failed",
  "release.smoke_failed",
]);

/** Clarification events are matched by name so a new event version still shows. */
export const isClarifyEvent = (type: string) => /needs_input|clarification/.test(type);

const ms = (iso: string | null | undefined) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

const str = (data: FeedEvent["data"], key: string) =>
  typeof data[key] === "string" ? (data[key] as string) : null;

function markerOf(event: FeedEvent, change: ChangeSummary | undefined): TimelineMarker | null {
  const at = ms(event.occurredAt);
  if (at === null || !event.changeId) return null;
  const base = {
    key: event.eventId,
    at,
    changeId: event.changeId,
    candidateId: event.candidateId,
    detail: event.summary,
  };
  const status = str(event.data, "status");
  if (isClarifyEvent(event.eventType)) return { ...base, kind: "clarify", label: "Question" };
  switch (event.eventType) {
    case "change.created":
      return { ...base, kind: "request", label: "Request" };
    case "change.compiled": {
      const n = event.data.taskCount;
      return { ...base, kind: "plan", label: typeof n === "number" ? `Plan · ${n}` : "Plan" };
    }
    case "conflict.reviewed":
    case "challenge.created":
      return { ...base, kind: "conflict", label: "Conflict" };
    case "conflict.integrated":
      return { ...base, kind: "conflict", label: "Integrated" };
    case "approval.requested":
      return { ...base, kind: "approval", label: "Approval" };
    case "verification.completed":
      if (status === "rejected" || status === "failed") {
        return { ...base, kind: "rejected", label: "Rejected" };
      }
      return { ...base, kind: "verified", label: "Verified" };
    case "candidate.stale":
      return { ...base, kind: "stale", label: "Stale" };
    case "canonical.advanced": {
      const from = event.data.fromGeneration;
      const to = event.data.toGeneration;
      const label =
        typeof from === "number" && typeof to === "number"
          ? `${generation(from)} → ${generation(to)}`
          : "Promoted";
      return { ...base, kind: "promotion", label };
    }
    case "deployment.completed": {
      const g = event.data.generation;
      return {
        ...base,
        kind: "release",
        label: typeof g === "number" ? `Live ${generation(g)}` : "Live",
      };
    }
    case "deployment.failed":
    case "release.smoke_failed":
      return { ...base, kind: "release_failed", label: "Release failed" };
    case "change.cancelled":
      // A request stopped by an earlier, conflicting request reads as a conflict.
      if (change?.status === "not_selected" || str(event.data, "winnerChangeId")) {
        return { ...base, kind: "conflict", label: "Not selected" };
      }
      return { ...base, kind: "cancelled", label: "Cancelled" };
    default:
      return null;
  }
}

function barStatus(run: TaskRun, task: TaskDetail): BarStatus {
  if (run.status === "completed") return "completed";
  if (run.status === "failed") return "failed";
  // A running attempt of a Task that no longer runs was stopped with its Task or Change.
  return task.status === "cancelled" || task.status === "failed" || task.status === "completed"
    ? "cancelled"
    : "running";
}

export function buildTimeline(input: {
  changes: ChangeSummary[];
  tasks: ReadonlyMap<string, { tasks: TaskDetail[] } | { error: string }>;
  events: readonly FeedEvent[];
  deadLetters: readonly DeadLetter[];
  limits: readonly LimitBlock[];
}): TimelineModel {
  const byId = new Map(input.changes.map((c) => [c.id, c]));
  const markersByChange = new Map<string, TimelineMarker[]>();
  const challenges = new Map<string, { at: number; changeId: string; resource: string | null }>();
  const resolved = new Set<string>();

  for (const event of input.events) {
    if (!event.changeId || !byId.has(event.changeId)) continue;
    const challengeId = str(event.data, "challengeId");
    if (event.eventType === "challenge.created" && challengeId) {
      challenges.set(challengeId, {
        at: ms(event.occurredAt) ?? 0,
        changeId: event.changeId,
        resource: event.resource,
      });
    }
    if (event.eventType === "challenge.resolved" && challengeId) {
      resolved.add(challengeId);
      continue;
    }
    const marker = markerOf(event, byId.get(event.changeId));
    if (!marker) continue;
    const list = markersByChange.get(marker.changeId) ?? [];
    list.push(marker);
    markersByChange.set(marker.changeId, list);
  }

  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  let live = false;
  let running = 0;
  let taskCount = 0;
  const people = new Map<string, TimelinePerson>();
  const promotions: TimelineMarker[] = [];
  const attention: AttentionItem[] = [];

  const ordered = [...input.changes].sort(
    (a, b) => (ms(a.createdAt) ?? 0) - (ms(b.createdAt) ?? 0),
  );
  for (const change of ordered) {
    const created = ms(change.createdAt) ?? renderNow();
    const read = input.tasks.get(change.id);
    const markers = (markersByChange.get(change.id) ?? []).sort((a, b) => a.at - b.at);
    // Without a recorded `change.created`, the request marker sits at the Change's creation.
    if (!markers.some((m) => m.kind === "request")) {
      markers.unshift({
        key: `${change.id}:request`,
        kind: "request",
        at: created,
        label: "Request",
        detail: "Request sent",
        changeId: change.id,
        candidateId: null,
      });
    }
    const changeLive = LIVE_CHANGE_STATUSES.has(change.status);
    let last = created;
    const tasks: TimelineTask[] = [];
    const openEnded = new Set<string>();
    if (read && "tasks" in read) {
      for (const task of read.tasks) {
        const bars: TimelineBar[] = task.runs
          .map((run) => {
            const s = ms(run.startedAt);
            if (s === null) return null;
            const status = barStatus(run, task);
            const e = ms(run.endedAt);
            if (status === "running") running += 1;
            if (status === "cancelled" && e === null) openEnded.add(`${task.id}:${run.attempt}`);
            last = Math.max(last, e ?? s);
            return {
              key: `${task.id}:${run.attempt}`,
              attempt: run.attempt,
              tier: run.tier,
              status,
              start: s,
              end: status === "running" ? null : (e ?? s),
              failureKind: run.failureKind,
              modelCalls: run.modelCalls,
            } satisfies TimelineBar;
          })
          .filter((b): b is TimelineBar => b !== null);
        tasks.push({
          id: task.id,
          key: task.key,
          title: task.title,
          status: task.status,
          agentId: task.assignedAgentId,
          bars,
        });
        if (task.status === "blocked" && changeLive) {
          attention.push({
            key: `blocked:${task.id}`,
            kind: "blocked",
            title: `${task.key} is blocked`,
            detail: truncate(task.title, 90),
            at: null,
            changeId: change.id,
          });
        }
      }
      taskCount += read.tasks.length;
    }
    for (const m of markers) last = Math.max(last, m.at);
    // Bars without an end (stopped attempts) close at the last recorded fact of their Change.
    for (const t of tasks) {
      for (const b of t.bars) if (openEnded.has(b.key)) b.end = last;
    }
    const hasRunning = tasks.some((t) => t.bars.some((b) => b.status === "running"));
    const inFlight = changeLive || hasRunning;
    if (inFlight) live = true;
    start = Math.min(start, created);
    end = Math.max(end, last);
    for (const m of markers) if (m.kind === "promotion") promotions.push(m);

    const requester = change.requester;
    const personKey = requester?.userId ?? "unknown";
    const person = people.get(personKey) ?? {
      key: personKey,
      name: requester?.isYou ? (requester.name ?? "You") : (requester?.name ?? "Unknown requester"),
      isYou: requester?.isYou ?? false,
      isOwner: requester?.rank === 0,
      changes: [],
    };
    person.changes.push({
      id: change.id,
      goal: change.goal,
      status: change.status,
      start: created,
      end: inFlight ? null : last,
      tasks,
      tasksState: !read ? "loading" : "tasks" in read ? "ready" : "error",
      markers,
    });
    people.set(personKey, person);

    const goal = truncate(change.goal, 90);
    const lastAt = markers.at(-1)?.at ?? created;
    if (change.status === "needs_input") {
      const question = [...markers].reverse().find((m) => m.kind === "clarify");
      attention.push({
        key: `clarify:${change.id}`,
        kind: "clarify",
        title: "The planner asked a question",
        detail: goal,
        at: question?.at ?? lastAt,
        changeId: change.id,
      });
    } else if (change.status === "awaiting_approval") {
      attention.push({
        key: `approval:${change.id}`,
        kind: "approval",
        title: "Approval needed before promotion",
        detail: goal,
        at: lastAt,
        changeId: change.id,
      });
    } else if (change.status === "budget_blocked") {
      attention.push({
        key: `budget:${change.id}`,
        kind: "budget",
        title: "Stopped at its budget",
        detail: goal,
        at: lastAt,
        changeId: change.id,
      });
    }
  }

  for (const [id, c] of challenges) {
    const change = byId.get(c.changeId);
    if (resolved.has(id) || !change || !LIVE_CHANGE_STATUSES.has(change.status)) continue;
    attention.push({
      key: `conflict:${id}`,
      kind: "conflict",
      title: c.resource ? `Agents disagree on ${c.resource}` : "Agents disagree",
      detail: truncate(change.goal, 90),
      at: c.at,
      changeId: c.changeId,
    });
  }
  for (const letter of input.deadLetters) {
    attention.push({
      key: `dead:${letter.id}`,
      kind: "dead_letter",
      title: `${letter.commandType} failed after retries`,
      detail: truncate(letter.taskTitle ?? letter.error, 90),
      at: ms(letter.lastSeenAt),
      changeId: letter.changeId,
    });
  }
  for (const block of input.limits) {
    if (block.scope === "change" && byId.get(block.changeId)?.status === "budget_blocked") continue;
    attention.push({
      key: `limit:${block.scope}:${block.id}`,
      kind: "limit",
      title: block.title ? truncate(block.title, 60) : "Stopped by a limit",
      detail: block.reason,
      at: null,
      changeId: block.changeId,
    });
  }
  attention.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  if (!Number.isFinite(start)) start = renderNow();
  if (!Number.isFinite(end)) end = start;
  return {
    people: [...people.values()],
    start,
    end: Math.max(end, start + 60_000),
    live,
    promotions,
    attention,
    counts: { changes: input.changes.length, tasks: taskCount, running, people: people.size },
  };
}

/** Durations: `48s`, `3m 12s`, `1 h 5m`. */
export function spanText(fromMs: number, toMs: number) {
  const s = Math.max(0, Math.round((toMs - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const m = Math.floor((s % 3600) / 60);
  return `${Math.floor(s / 3600)} h${m ? ` ${m}m` : ""}`;
}
