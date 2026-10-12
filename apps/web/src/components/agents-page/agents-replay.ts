import type { ChangeSummary, ConflictDetail, FeedEvent, TaskDetail, TaskRun } from "../../lib/api";
import { changeLabel, formatClock } from "../../lib/format";
import type { DagEdgeKind } from "../dag/model";
import type { ReplayTick } from "../replay/replay-bar";

/**
 * Replay of the Agents graph (components/replay): when each Change, Task, agent run and conflict
 * appears, and what each looked like at a playhead. Pure functions over recorded data:
 *
 * - a Change appears at its creation;
 * - a Task appears at its `task.created` event, else at `change.compiled`, else with its
 *   Change's first agent run (the Change's opening events are read once per Change);
 * - an agent appears when its first run starts, runs until the recorded end of each attempt,
 *   and shows each retry (same tier) and escalation (higher tier);
 * - a conflict edge appears at its creation as "suspected" and takes its recorded state at its
 *   last update.
 */

export type ChangeData = {
  change: ChangeSummary;
  tasks: TaskDetail[];
  conflicts: ConflictDetail[];
};

export const TIER_LETTER: Record<TaskRun["tier"], string> = { haiku: "H", sonnet: "S", opus: "O" };
export const TIER_WORD: Record<TaskRun["tier"], string> = {
  haiku: "Haiku",
  sonnet: "Sonnet",
  opus: "Opus",
};

const ms = (iso: string | null | undefined) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

export type ReplayFact = {
  id: string;
  at: number;
  kind:
    | "request"
    | "plan"
    | "start"
    | "retry"
    | "escalate"
    | "done"
    | "fail"
    | "conflict"
    | "settle";
  text: string;
};

export type AgentsTiming = {
  changeAt: Map<string, number>;
  taskAt: Map<string, number>;
  /** Last recorded instant of each Change: from it on, the replay shows the recorded status. */
  changeEnd: Map<string, number>;
  facts: ReplayFact[];
  times: number[];
  ticks: ReplayTick[];
};

const TICK: Partial<Record<ReplayFact["kind"], { label: string; fill: string }>> = {
  request: { label: "Request", fill: "bg-tone-500" },
  escalate: { label: "Escalation", fill: "bg-kumo-warning" },
  fail: { label: "Failure", fill: "bg-kumo-danger" },
  conflict: { label: "Conflict", fill: "bg-accent-500" },
};

export const AGENTS_REPLAY_LEGEND = [
  { label: "Request", fill: "bg-tone-500" },
  { label: "Conflict", fill: "bg-accent-500" },
  { label: "Escalation", fill: "bg-kumo-warning" },
  { label: "Failure", fill: "bg-kumo-danger" },
];

export function conflictKind(c: ConflictDetail): { kind: DagEdgeKind; label: string } {
  if (c.state === "resolved" || c.recommendedAction === "dismiss") {
    return { kind: "conflict_dismissed", label: "dismissed" };
  }
  if (c.state === "fork_required" || c.forkDecision.kind === "fork") {
    return { kind: "conflict_fork", label: "fork" };
  }
  if (c.state === "confirmed") return { kind: "conflict_confirmed", label: "confirmed" };
  return { kind: "conflict_suspected", label: "suspected" };
}

export function buildTiming(
  data: readonly ChangeData[],
  openings: ReadonlyMap<string, readonly FeedEvent[]>,
): AgentsTiming {
  const changeAt = new Map<string, number>();
  const taskAt = new Map<string, number>();
  const changeEnd = new Map<string, number>();
  const facts: ReplayFact[] = [];

  for (const { change, tasks, conflicts } of data) {
    const created = ms(change.createdAt) ?? 0;
    changeAt.set(change.id, created);
    facts.push({
      id: `request:${change.id}`,
      at: created,
      kind: "request",
      text: `Request: ${changeLabel(change)}`,
    });
    let last = created;

    const events = openings.get(change.id) ?? [];
    const compiled = events.find((e) => e.eventType === "change.compiled");
    const createdTask = new Map<string, number>();
    for (const e of events) {
      const t = ms(e.occurredAt);
      if (e.eventType === "task.created" && e.taskId && t !== null) createdTask.set(e.taskId, t);
    }
    const firstRun = Math.min(
      ...tasks.flatMap((t) => t.runs.map((r) => ms(r.startedAt) ?? Number.POSITIVE_INFINITY)),
    );
    const planAt = ms(compiled?.occurredAt) ?? (Number.isFinite(firstRun) ? firstRun : created);
    if (tasks.length > 0) {
      facts.push({
        id: `plan:${change.id}`,
        at: planAt,
        kind: "plan",
        text: `Plan ready: ${tasks.length} ${tasks.length === 1 ? "Task" : "Tasks"}`,
      });
    }

    for (const task of tasks) {
      const appear = Math.max(created, createdTask.get(task.id) ?? planAt);
      taskAt.set(task.id, appear);
      last = Math.max(last, appear);
      let previous: TaskRun["tier"] | null = null;
      for (const run of task.runs) {
        const start = ms(run.startedAt);
        if (start === null) continue;
        const tier = TIER_WORD[run.tier];
        const kind: ReplayFact["kind"] =
          previous === null ? "start" : previous === run.tier ? "retry" : "escalate";
        const text =
          kind === "start"
            ? `${task.key} agent wakes on ${tier}`
            : kind === "retry"
              ? `${task.key} retries on ${tier}, attempt ${run.attempt}`
              : `${task.key} escalates ${TIER_WORD[previous as TaskRun["tier"]]} → ${tier}, attempt ${run.attempt}`;
        facts.push({ id: `run:${task.id}:${run.attempt}`, at: start, kind, text });
        previous = run.tier;
        last = Math.max(last, start);
        const end = ms(run.endedAt);
        if (end !== null && run.status !== "running") {
          facts.push({
            id: `end:${task.id}:${run.attempt}`,
            at: end,
            kind: run.status === "failed" ? "fail" : "done",
            text:
              run.status === "failed"
                ? `${task.key} fails on ${tier}${run.failureKind ? ` (${run.failureKind})` : ""}`
                : `${task.key} done on ${tier}`,
          });
          last = Math.max(last, end);
        }
      }
    }

    const keyOf = new Map(tasks.map((t) => [t.id, t.key]));
    for (const c of conflicts) {
      const at = ms(c.createdAt);
      if (at === null) continue;
      const [a, b] = c.intents;
      const pair = `${keyOf.get(a.taskId) ?? a.taskKey} and ${keyOf.get(b.taskId) ?? b.taskKey}`;
      facts.push({
        id: `conflict:${c.id}`,
        at,
        kind: "conflict",
        text: `Conflict on ${c.resource} between ${pair}`,
      });
      last = Math.max(last, at);
      const settled = ms(c.updatedAt);
      const { kind, label } = conflictKind(c);
      if (settled !== null && settled > at && kind !== "conflict_suspected") {
        facts.push({
          id: `settle:${c.id}`,
          at: settled,
          kind: "settle",
          text: `Conflict on ${c.resource}: ${label}`,
        });
        last = Math.max(last, settled);
      }
    }
    changeEnd.set(change.id, last);
  }

  facts.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const ticks: ReplayTick[] = [];
  for (const f of facts) {
    const tick = TICK[f.kind];
    if (tick) ticks.push({ id: f.id, at: f.at, ...tick });
  }
  return { changeAt, taskAt, changeEnd, facts, times: facts.map((f) => f.at), ticks };
}

/** What a Task's agent was doing at `at`. */
export type AgentAt = {
  /** Attempts started by `at`. */
  runs: TaskRun[];
  current: TaskRun | null;
  status: "running" | "completed" | "failed" | null;
  /** Share of the current attempt's recorded duration behind the playhead. */
  progress: number | null;
};

export function agentAt(task: TaskDetail, at: number): AgentAt {
  const runs = task.runs.filter((r) => (ms(r.startedAt) ?? Number.POSITIVE_INFINITY) <= at);
  const last = runs.at(-1) ?? null;
  if (!last) return { runs, current: null, status: null, progress: null };
  const start = ms(last.startedAt) ?? at;
  const end = ms(last.endedAt);
  if (end === null || end > at) {
    const progress = end === null ? null : Math.min(1, Math.max(0, (at - start) / (end - start)));
    return { runs, current: last, status: "running", progress };
  }
  return {
    runs,
    current: null,
    status: last.status === "failed" ? "failed" : "completed",
    progress: null,
  };
}

/** The conflict edge as it stood at `at`; null before the conflict was recorded. */
export function conflictAt(
  c: ConflictDetail,
  at: number,
): { kind: DagEdgeKind; label: string } | null {
  const created = ms(c.createdAt);
  if (created === null || created > at) return null;
  const settled = ms(c.updatedAt) ?? created;
  return at >= settled ? conflictKind(c) : { kind: "conflict_suspected", label: "suspected" };
}

/** One line for the screen reader and the step list: `14:02:11 · T2 agent wakes on Sonnet`. */
export const factLine = (f: ReplayFact) =>
  `${formatClock(new Date(f.at).toISOString())} · ${f.text}`;
