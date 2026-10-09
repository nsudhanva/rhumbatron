import { useMemo } from "react";
import type { TaskRun } from "../../../../lib/api";
import { useFlight } from "../../flight-context";
import type { FlightState, TaskState } from "../../flight-model";
import { relatedRefs } from "../../flight-model";
import { type EntityRef, useFlightFilters, useSelection } from "../../flight-store";

/**
 * Lane selection and tier styling shared by the swimlanes, the workspace lanes and the Task
 * inspector. Tier is never shown by fill alone: every bar also carries its letter (H, S, O) and
 * every header its tier word.
 */

type Tier = TaskRun["tier"];

/** Three distinguishable tones: light (Haiku), mid (Sonnet), ink (Opus). */
export const TIER_FILL: Record<Tier, string> = {
  haiku: "bg-tone-200 text-kumo-default border border-tone-400",
  sonnet: "bg-tone-400 text-kumo-default",
  opus: "bg-kumo-ink text-kumo-inverse",
};

export const TIER_LETTER: Record<Tier, string> = { haiku: "H", sonnet: "S", opus: "O" };

/** A Task gets a lane once it has an agent or has woken (it forked a workspace). */
const hasLane = (t: TaskState) => t.agentId !== null || t.lane.forked || t.runs.length > 0;

function matches(state: FlightState, t: TaskState, query: string) {
  if (!query) return true;
  const q = query.toLowerCase();
  const fields = [
    t.key,
    t.title,
    t.agentId ?? "",
    ...t.semanticResources,
    ...t.claims,
    ...t.files.expected,
    ...t.files.changed.map((f) => f.path),
  ];
  if (fields.some((f) => f.toLowerCase().includes(q))) return true;
  return state.events.some(
    (e) => "laneId" in e && e.laneId === t.id && e.type.toLowerCase().includes(q),
  );
}

/**
 * Task ids with a lane, in Work Graph order, after the page filters (query, tiers, active only).
 * `hidden` counts Tasks without an agent yet, so the panel can say they exist.
 */
export function useVisibleLanes(): { ids: string[]; hidden: number; filtered: number } {
  const { state } = useFlight();
  const filters = useFlightFilters();
  return useMemo(() => {
    const ids: string[] = [];
    let hidden = 0;
    let filtered = 0;
    for (const id of state.taskOrder) {
      const t = state.tasks[id];
      if (!t) continue;
      if (!hasLane(t)) {
        hidden += 1;
        continue;
      }
      const tierOk =
        filters.tiers.length === 0 ||
        t.runs.some((r) => filters.tiers.includes(r.tier)) ||
        (t.lane.tier !== null && filters.tiers.includes(t.lane.tier));
      const activeOk = !filters.activeOnly || t.lane.forked;
      if (tierOk && activeOk && matches(state, t, filters.query.trim())) ids.push(id);
      else filtered += 1;
    }
    return { ids, hidden, filtered };
  }, [state, filters]);
}

/** Returns a predicate: true when `ref` should dim because something unrelated is selected. */
export function useDimmed(): (ref: EntityRef) => boolean {
  const { state } = useFlight();
  const selection = useSelection();
  const related = useMemo(() => relatedRefs(state, selection), [state, selection]);
  return (ref) => selection !== null && !related.has(`${ref.kind}:${ref.id}`);
}
