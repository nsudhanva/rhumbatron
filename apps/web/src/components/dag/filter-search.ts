import type { ChangeSummary, FeedEvent, TaskDetail } from "../../lib/api";
import { changeLabel } from "../../lib/format";
import type { FilterOption } from "./dag-filters";
import {
  type DagFilter,
  EVENT_GROUPS,
  type EventGroup,
  eventGroupOf,
  filterActive,
  inTimeRange,
  TIME_RANGES,
  type TimeRange,
} from "./model";

/**
 * The Events page filter in the URL (`?q=&person=&change=&task=&group=&range=`), so the List and
 * Graph views share one filter and a filtered view can be linked. `change` is also the server
 * scope of the stream: with it, the page reads that Change's events, so "Load older" pages
 * through that Change only. The other fields filter the loaded events in the browser.
 */

export type FilterSearch = {
  change?: string;
  q?: string;
  person?: string;
  task?: string;
  group?: EventGroup;
  range?: Exclude<TimeRange, "all">;
};

export type EventsFilter = DagFilter & { query: string };

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;

/** The filter fields of a raw search object, for a route's `validateSearch`. */
export function parseFilterSearch(search: Record<string, unknown>): FilterSearch {
  const out: FilterSearch = {};
  const change = text(search.change);
  const q = text(search.q);
  const person = text(search.person);
  const task = text(search.task);
  if (change) out.change = change;
  if (q) out.q = q;
  if (person) out.person = person;
  if (task) out.task = task;
  if (typeof search.group === "string" && search.group in EVENT_GROUPS) {
    out.group = search.group as EventGroup;
  }
  if (typeof search.range === "string" && search.range !== "all" && search.range in TIME_RANGES) {
    out.range = search.range as Exclude<TimeRange, "all">;
  }
  return out;
}

export function filterFromSearch(search: FilterSearch): EventsFilter {
  return {
    query: search.q ?? "",
    person: search.person ?? null,
    changeId: search.change ?? null,
    taskId: search.task ?? null,
    group: search.group ?? null,
    range: search.range ?? "all",
  };
}

/** The search fields of a filter; empty fields are left out of the URL. */
export function searchFromFilter(filter: EventsFilter): FilterSearch {
  const out: FilterSearch = {};
  if (filter.changeId) out.change = filter.changeId;
  if (filter.query.trim()) out.q = filter.query.trim();
  if (filter.person) out.person = filter.person;
  if (filter.taskId) out.task = filter.taskId;
  if (filter.group) out.group = filter.group;
  if (filter.range !== "all") out.range = filter.range;
  return out;
}

/** Fields that narrow the events: search text, person, Change, Task or agent, type, time. */
export const activeFilterCount = (f: EventsFilter) =>
  (f.query.trim() ? 1 : 0) +
  (f.person ? 1 : 0) +
  (f.changeId ? 1 : 0) +
  (f.taskId ? 1 : 0) +
  (f.group ? 1 : 0) +
  (f.range !== "all" ? 1 : 0);

export const eventsFilterActive = (f: EventsFilter) => f.query.trim() !== "" || filterActive(f);

/** True when the event passes every field of the filter. */
export function matchesEvent(
  e: FeedEvent,
  filter: EventsFilter,
  changes: ReadonlyMap<string, ChangeSummary>,
): boolean {
  if (filter.changeId && e.changeId !== filter.changeId) return false;
  if (filter.taskId && e.taskId !== filter.taskId && e.actor.id !== filter.taskId) return false;
  if (filter.group && eventGroupOf(e.eventType) !== filter.group) return false;
  if (!inTimeRange(e.occurredAt, filter.range)) return false;
  const change = e.changeId ? changes.get(e.changeId) : undefined;
  if (filter.person && change?.requester?.userId !== filter.person) return false;
  const q = filter.query.trim().toLowerCase();
  if (q) {
    const haystack = [
      e.eventType,
      e.summary,
      e.eventId,
      String(e.seq),
      e.changeId,
      e.taskId,
      e.candidateId,
      e.actor.id,
      e.resource,
      change ? changeLabel(change) : null,
      change?.goal,
    ];
    if (!haystack.some((v) => v?.toLowerCase().includes(q))) return false;
  }
  return true;
}

/** Requesters of the Changes that loaded events belong to. */
export function personOptions(
  events: readonly FeedEvent[],
  changes: ReadonlyMap<string, ChangeSummary>,
): FilterOption[] {
  const seen = new Map<string, string>();
  for (const e of events) {
    const r = e.changeId ? changes.get(e.changeId)?.requester : undefined;
    if (r) seen.set(r.userId, r.isYou ? "You" : (r.name ?? "Unnamed"));
  }
  return [...seen].map(([value, label]) => ({ value, label }));
}

/** Changes of the Project (by short title), narrowed to the chosen person. */
export function changeOptions(
  changes: readonly ChangeSummary[],
  person: string | null,
): FilterOption[] {
  return changes
    .filter((c) => person === null || c.requester?.userId === person)
    .map((c) => ({ value: c.id, label: changeLabel(c) }));
}

/**
 * Tasks of the loaded events (inside the chosen Change), each with the agent that acted on it.
 * Names come from `tasks` when that Change's Task list is loaded.
 */
export function taskOptions(
  events: readonly FeedEvent[],
  changeId: string | null,
  tasks: ReadonlyMap<string, TaskDetail>,
): FilterOption[] {
  const agents = new Map<string, string>();
  const order: string[] = [];
  for (const e of events) {
    if (!e.taskId || (changeId && e.changeId !== changeId)) continue;
    if (!agents.has(e.taskId)) {
      agents.set(e.taskId, "");
      order.push(e.taskId);
    }
    if (e.actor.kind === "agent" && !agents.get(e.taskId)) agents.set(e.taskId, e.actor.id);
  }
  return order.map((id) => {
    const t = tasks.get(id);
    const agent = agents.get(id);
    const name = t ? `${t.key} ${t.title}` : id;
    return { value: id, label: agent ? `${name} · ${agent}` : name };
  });
}
