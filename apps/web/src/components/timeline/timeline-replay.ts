import type { ReplayTick } from "../replay/replay-bar";
import type { AttentionItem, MarkerKind, TimelineChange, TimelineModel } from "./timeline-model";

/**
 * Replay of the execution timeline (components/replay): the recorded instants the playhead stops
 * at, the ticks on the replay bar, and the "Needs attention" rail as it stood at the playhead.
 * Pure functions over the timeline model; every instant is a recorded one.
 */

/** Change starts, Task attempt starts and ends, and every marker. */
export function replayTimes(model: TimelineModel): number[] {
  const out: number[] = [];
  for (const person of model.people) {
    for (const change of person.changes) {
      out.push(change.start);
      for (const m of change.markers) out.push(m.at);
      for (const task of change.tasks) {
        for (const bar of task.bars) {
          out.push(bar.start);
          if (bar.end !== null) out.push(bar.end);
        }
      }
    }
  }
  return out;
}

const TICK: Partial<Record<MarkerKind, { label: string; fill: string }>> = {
  request: { label: "Request", fill: "bg-tone-500" },
  conflict: { label: "Conflict", fill: "bg-accent-500" },
  clarify: { label: "Question", fill: "bg-kumo-warning" },
  rejected: { label: "Rejection", fill: "bg-kumo-danger" },
  release_failed: { label: "Release failure", fill: "bg-kumo-danger" },
  verified: { label: "Verified", fill: "bg-kumo-success" },
  promotion: { label: "Promotion", fill: "bg-kumo-ink" },
};

export const REPLAY_LEGEND = [
  { label: "Request", fill: "bg-tone-500" },
  { label: "Conflict", fill: "bg-accent-500" },
  { label: "Question", fill: "bg-kumo-warning" },
  { label: "Verified", fill: "bg-kumo-success" },
  { label: "Failure", fill: "bg-kumo-danger" },
  { label: "Promotion", fill: "bg-kumo-ink" },
];

/** Ticks on the replay bar: requests, conflicts, questions, verdicts, promotions. */
export function replayTicks(model: TimelineModel): ReplayTick[] {
  const out: ReplayTick[] = [];
  for (const person of model.people) {
    for (const change of person.changes) {
      for (const m of change.markers) {
        const tick = TICK[m.kind];
        if (tick) out.push({ id: m.key, at: m.at, ...tick });
      }
    }
  }
  return out;
}

/** Markers that answer an open approval request. */
const CLOSES_APPROVAL = new Set<MarkerKind>([
  "promotion",
  "rejected",
  "cancelled",
  "stale",
  "release",
  "release_failed",
]);

/** When an item opened at `from` on `change` stops waiting: the first closing marker after it. */
function closedAt(change: TimelineChange, from: number, closes: (kind: MarkerKind) => boolean) {
  const next = change.markers.find((m) => m.at > from && closes(m.kind));
  return next?.at ?? change.end ?? Number.POSITIVE_INFINITY;
}

/**
 * The rail at the playhead `at`: questions not answered yet (a later marker of the Change closes
 * them), approval requests not decided yet, Challenges not resolved yet, and commands that had
 * failed after retries by then. Blocks and limits carry no recorded time, so they show only live.
 */
export function attentionAt(model: TimelineModel, at: number): AttentionItem[] {
  const out: AttentionItem[] = [];
  const changes = new Map<string, TimelineChange>();
  for (const person of model.people) {
    for (const change of person.changes) {
      changes.set(change.id, change);
      for (const m of change.markers) {
        if (m.at > at) break;
        if (m.kind === "clarify" && closedAt(change, m.at, (k) => k !== "clarify") > at) {
          out.push({
            key: `clarify:${m.key}`,
            kind: "clarify",
            title: "The planner asked a question",
            detail: change.title,
            at: m.at,
            changeId: change.id,
          });
        } else if (
          m.kind === "approval" &&
          closedAt(change, m.at, (k) => CLOSES_APPROVAL.has(k)) > at
        ) {
          out.push({
            key: `approval:${m.key}`,
            kind: "approval",
            title: "Approval needed before promotion",
            detail: change.title,
            at: m.at,
            changeId: change.id,
          });
        }
      }
    }
  }
  for (const c of model.challenges) {
    const change = changes.get(c.changeId);
    if (!change || c.at > at) continue;
    const until = c.resolvedAt ?? change.end ?? Number.POSITIVE_INFINITY;
    if (until <= at) continue;
    out.push({
      key: `conflict:${c.id}`,
      kind: "conflict",
      title: c.resource ? `Agents disagree on ${c.resource}` : "Agents disagree",
      detail: change.title,
      at: c.at,
      changeId: c.changeId,
    });
  }
  for (const item of model.attention) {
    if (item.kind === "dead_letter" && item.at !== null && item.at <= at) out.push(item);
  }
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}
