import { ArrowRight } from "@phosphor-icons/react";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { type ChangeSummary, listTasks, type TaskDetail } from "../../lib/api";
import { formatClock, formatNumber, timeAgo, truncate } from "../../lib/format";
import { DagCanvas, edgeSwatch, type LegendItem, nodeSwatch } from "../dag/dag-canvas";
import { DagFilters, type FilterOption } from "../dag/dag-filters";
import {
  type DagEdgeSpec,
  type DagFilter,
  type DagNodeSpec,
  EMPTY_FILTER,
  EVENT_GROUPS,
  eventGroupOf,
  inTimeRange,
} from "../dag/model";
import { EmptyState } from "../ui/empty-state";
import { KeyValue } from "../ui/key-value";
import { Mono } from "../ui/mono";
import { Section } from "../ui/page";
import { StatusPill } from "../ui/status-pill";
import { EventDetail } from "./event-stream";
import { type FeedEvent, ingestLagMs, TONE_TEXT, typeTone } from "./feed-model";

/**
 * Events graph (AGENTS.md 17, 38.7; DESIGN.md 9.13): the loaded events as a DAG. An event links
 * to the event that caused it when the feed carries `causedBy`; the feed projection does not
 * keep it today, so each event sits in the lane of its Task under its Change, in sequence order.
 * Events with no Task sit in their Change's own lane, and events with no Change in the Project
 * lane. Task names come from one Task list per Change in view (at most MAX_TASK_LISTS).
 */

/** Newest matching events drawn; the rest stay in the list view. */
const MAX_EVENTS = 160;
const MAX_TASK_LISTS = 6;
const COLUMN = 260;
const EVENT_COLUMN = 220;
const ROW = 104;
const GROUP_GAP = 40;

/** `causedBy` when a feed row carries it. */
const causeOf = (e: FeedEvent) => (e as FeedEvent & { causedBy?: string | null }).causedBy ?? null;

type Selection =
  | { kind: "event"; event: FeedEvent }
  | { kind: "change"; changeId: string; change: ChangeSummary | undefined; count: number }
  | { kind: "task"; taskId: string; changeId: string; task: TaskDetail | undefined; count: number }
  | { kind: "project"; count: number };

const PROJECT_NODE = "project";
const changeNode = (id: string) => `change:${id}`;
const taskNode = (id: string) => `task:${id}`;
const eventNode = (seq: number) => `event:${seq}`;

function buildGraph(
  events: FeedEvent[],
  changes: Map<string, ChangeSummary>,
  tasks: Map<string, TaskDetail>,
): { nodes: DagNodeSpec[]; edges: DagEdgeSpec[]; select: Map<string, Selection> } {
  const nodes: DagNodeSpec[] = [];
  const edges: DagEdgeSpec[] = [];
  const select = new Map<string, Selection>();

  // Oldest first, so lanes read left to right in time.
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const groups = new Map<string, Map<string, FeedEvent[]>>();
  for (const e of ordered) {
    const g = e.changeId ?? "";
    const lane = e.taskId ?? "";
    const lanes = groups.get(g) ?? new Map<string, FeedEvent[]>();
    lanes.set(lane, [...(lanes.get(lane) ?? []), e]);
    groups.set(g, lanes);
  }

  const bySeqOfId = new Map(ordered.map((e) => [e.eventId, e.seq]));
  let top = 0;
  // Project lane first, then Changes by their first event.
  const groupKeys = [...groups.keys()].sort((a, b) =>
    a === ""
      ? -1
      : b === ""
        ? 1
        : (groups.get(a)?.values().next().value?.[0]?.seq ?? 0) -
          (groups.get(b)?.values().next().value?.[0]?.seq ?? 0),
  );
  for (const g of groupKeys) {
    const lanes = groups.get(g) as Map<string, FeedEvent[]>;
    // The Change's own lane first, then Tasks by their first event.
    const laneKeys = [...lanes.keys()].sort((a, b) =>
      a === "" ? -1 : b === "" ? 1 : (lanes.get(a)?.[0]?.seq ?? 0) - (lanes.get(b)?.[0]?.seq ?? 0),
    );
    const count = [...lanes.values()].reduce((n, l) => n + l.length, 0);
    const headId = g === "" ? PROJECT_NODE : changeNode(g);
    const change = g ? changes.get(g) : undefined;
    nodes.push({
      id: headId,
      position: { x: 0, y: top + ((laneKeys.length - 1) * ROW) / 2 },
      kicker: g === "" ? "Project" : "Change",
      title: g === "" ? "Project events" : change ? truncate(change.goal, 56) : g,
      meta: `${formatNumber(count)} events${change?.requester?.name ? ` · ${change.requester.name}` : ""}`,
      status: change?.status,
      border: "ink",
      width: 230,
    });
    select.set(
      headId,
      g === "" ? { kind: "project", count } : { kind: "change", changeId: g, change, count },
    );

    laneKeys.forEach((lane, row) => {
      const y = top + row * ROW;
      const laneEvents = lanes.get(lane) ?? [];
      let previous = headId;
      if (lane !== "") {
        const task = tasks.get(lane);
        const tId = taskNode(lane);
        nodes.push({
          id: tId,
          position: { x: COLUMN, y },
          kicker: task ? `Task · ${task.kind}` : "Task",
          title: task ? `${task.key} ${task.title}` : lane,
          meta: `${formatNumber(laneEvents.length)} events`,
          status: task?.status,
          border: "ink",
          monoTitle: !task,
          width: 210,
        });
        select.set(tId, {
          kind: "task",
          taskId: lane,
          changeId: g,
          task,
          count: laneEvents.length,
        });
        edges.push({ id: `${headId}>${tId}`, source: headId, target: tId, kind: "flow" });
        previous = tId;
      }
      laneEvents.forEach((e, i) => {
        const id = eventNode(e.seq);
        const tone = typeTone(e);
        const group = eventGroupOf(e.eventType);
        nodes.push({
          id,
          position: { x: 2 * COLUMN + i * EVENT_COLUMN, y },
          kicker: group === "other" ? e.actor.kind : EVENT_GROUPS[group].label,
          title: e.eventType,
          monoTitle: true,
          titleClass: TONE_TEXT[tone],
          meta: `#${e.seq} · ${formatClock(e.occurredAt)}`,
          border: tone === "danger" ? "accent" : "divider",
          width: 190,
        });
        select.set(id, { kind: "event", event: e });
        const cause = causeOf(e);
        const causeSeq = cause ? bySeqOfId.get(cause) : undefined;
        if (causeSeq !== undefined) {
          edges.push({
            id: `cause:${e.seq}`,
            source: eventNode(causeSeq),
            target: id,
            kind: "cause",
          });
        }
        edges.push({
          id: `${previous}>${id}`,
          source: previous,
          target: id,
          kind: i === 0 ? "flow" : "sequence",
        });
        previous = id;
      });
    });
    top += laneKeys.length * ROW + GROUP_GAP;
  }
  return { nodes, edges, select };
}

const LEGEND: LegendItem[] = [
  { key: "lane", label: "Change or Task", swatch: nodeSwatch("ink") },
  { key: "event", label: "Event", swatch: nodeSwatch("divider") },
  { key: "fail", label: "Failure event", swatch: nodeSwatch("accent") },
  { key: "flow", label: "Belongs to", swatch: edgeSwatch("flow") },
  { key: "sequence", label: "Next in the same lane", swatch: edgeSwatch("sequence") },
];

export function EventsGraph({
  projectId,
  events,
  changes,
  scopedToChange,
  footer,
}: {
  projectId: string;
  /** Loaded events, newest first. */
  events: FeedEvent[];
  /** Changes of the Project, newest first, for names and requesters. */
  changes: ChangeSummary[];
  scopedToChange: boolean;
  /** Load-older control and paging state. */
  footer?: ReactNode;
}) {
  const [filter, setFilter] = useState<DagFilter>(EMPTY_FILTER);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const changeById = useMemo(() => new Map(changes.map((c) => [c.id, c])), [changes]);

  const matching = useMemo(
    () =>
      events.filter((e) => {
        if (filter.changeId && e.changeId !== filter.changeId) return false;
        if (filter.taskId && e.taskId !== filter.taskId) return false;
        if (filter.group && eventGroupOf(e.eventType) !== filter.group) return false;
        if (!inTimeRange(e.occurredAt, filter.range)) return false;
        if (filter.person) {
          const change = e.changeId ? changeById.get(e.changeId) : undefined;
          if (change?.requester?.userId !== filter.person) return false;
        }
        return true;
      }),
    [events, filter, changeById],
  );
  const shown = useMemo(() => matching.slice(0, MAX_EVENTS), [matching]);

  // Task names: one Task list per Change in view, newest Changes first.
  const changeIds = useMemo(
    () =>
      [...new Set(shown.flatMap((e) => (e.changeId && e.taskId ? [e.changeId] : [])))].slice(
        0,
        MAX_TASK_LISTS,
      ),
    [shown],
  );
  const taskQueries = useQueries({
    queries: changeIds.map((id) => ({
      queryKey: ["tasks", id],
      queryFn: () => listTasks({ data: id }),
    })),
  });
  const stamp = taskQueries.map((q) => q.dataUpdatedAt).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `stamp` tracks the query data
  const taskById = useMemo(
    () => new Map(taskQueries.flatMap((q) => (q.data ?? []).map((t) => [t.id, t] as const))),
    [stamp],
  );

  const graph = useMemo(
    () => buildGraph(shown, changeById, taskById),
    [shown, changeById, taskById],
  );
  const selection = selectedId ? graph.select.get(selectedId) : undefined;

  const people: FilterOption[] = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of events) {
      const r = e.changeId ? changeById.get(e.changeId)?.requester : undefined;
      if (r) seen.set(r.userId, r.isYou ? "You" : (r.name ?? "Unnamed"));
    }
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [events, changeById]);
  const changeOptions = useMemo(() => {
    if (scopedToChange) return [];
    const ids = [...new Set(events.flatMap((e) => (e.changeId ? [e.changeId] : [])))];
    return ids
      .filter((id) => !filter.person || changeById.get(id)?.requester?.userId === filter.person)
      .map((id) => ({ value: id, label: changeById.get(id)?.goal ?? id }));
  }, [events, changeById, filter.person, scopedToChange]);
  const taskOptions = useMemo(() => {
    const ids = [
      ...new Set(
        events.flatMap((e) =>
          e.taskId && (!filter.changeId || e.changeId === filter.changeId) ? [e.taskId] : [],
        ),
      ),
    ];
    return ids.map((id) => {
      const t = taskById.get(id);
      return { value: id, label: t ? `${t.key} ${t.title}` : id };
    });
  }, [events, filter.changeId, taskById]);

  const onSelect = useCallback(
    (id: string) => setSelectedId((current) => (current === id ? null : id)),
    [],
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(320px,400px)] items-start gap-7 max-[1100px]:grid-cols-1">
      <Section
        label="Graph"
        meta={
          <Mono subtle>
            {formatNumber(shown.length)} of {formatNumber(events.length)} loaded events
          </Mono>
        }
      >
        <div className="grid gap-4">
          <DagFilters
            filter={filter}
            onChange={(next) => {
              setFilter(next);
              setSelectedId(null);
            }}
            people={people}
            changes={changeOptions}
            tasks={taskOptions}
            taskLabel="Task"
            groups
          />
          {events.length === 0 ? (
            <EmptyState
              what="No events recorded yet."
              how="Events appear here as soon as a Change starts and agents act on it."
            />
          ) : shown.length === 0 ? (
            <EmptyState
              what="No loaded events match these filters."
              how="Clear a filter, or load older events below."
            />
          ) : (
            <DagCanvas
              label="Events graph"
              nodes={graph.nodes}
              edges={graph.edges}
              selectedId={selectedId}
              onSelect={onSelect}
              legend={LEGEND}
              caption={
                <>
                  Each lane is one Task, under its Change; events run left to right in sequence
                  order. Events with no Task sit in their Change's lane, events with no Change in
                  the Project lane. The feed does not record which event caused which, so lanes show
                  order, not proven cause. Select a node to keep its ancestors and descendants and
                  dim the rest.
                  {matching.length > shown.length
                    ? ` Only the newest ${formatNumber(MAX_EVENTS)} matching events are drawn; the list view shows all ${formatNumber(matching.length)}.`
                    : ""}
                </>
              }
            />
          )}
          {footer}
        </div>
      </Section>

      <aside className="grid min-w-0 content-start gap-4 bg-kumo-elevated p-4">
        <NodeDetail selection={selection} projectId={projectId} scopedToChange={scopedToChange} />
      </aside>
    </div>
  );
}
EventsGraph.displayName = "EventsGraph";

function NodeDetail({
  selection,
  projectId,
  scopedToChange,
}: {
  selection: Selection | undefined;
  projectId: string;
  scopedToChange: boolean;
}) {
  const link = "inline-flex items-center gap-1.5 text-kumo-accent hover:underline";
  if (!selection) {
    return (
      <EmptyState
        what="No node selected."
        how="Select an event, a Task or a Change in the graph to see its detail."
      />
    );
  }
  if (selection.kind === "event") {
    const e = selection.event;
    return (
      <>
        <header className="grid gap-1.5">
          <p className="type-kicker text-kumo-accent">Event #{e.seq}</p>
          <h3 className={`font-mono text-[14px] font-semibold break-all ${TONE_TEXT[typeTone(e)]}`}>
            {e.eventType}
          </h3>
          <p className="text-[13px] text-pretty">{e.summary}</p>
        </header>
        <EventDetail
          event={e}
          projectId={projectId}
          lag={ingestLagMs(e)}
          scopedToChange={scopedToChange}
        />
      </>
    );
  }
  if (selection.kind === "project") {
    return (
      <header className="grid gap-1.5">
        <p className="type-kicker text-kumo-accent">Project</p>
        <p className="text-[13px]">
          {formatNumber(selection.count)} loaded events belong to no Change: Project creation,
          releases and other Project-wide facts.
        </p>
      </header>
    );
  }
  if (selection.kind === "change") {
    const c = selection.change;
    return (
      <>
        <header className="grid gap-1.5">
          <p className="type-kicker text-kumo-accent">Change</p>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 text-[15px] font-semibold text-pretty">
              {c?.goal ?? selection.changeId}
            </h3>
            {c && <StatusPill status={c.status} />}
          </div>
        </header>
        <KeyValue
          items={[
            { label: "Change", value: selection.changeId, mono: true },
            { label: "Requested by", value: c?.requester?.name ?? null },
            { label: "Created", value: c ? timeAgo(c.createdAt) : null, mono: true },
            { label: "Loaded events", value: formatNumber(selection.count), mono: true },
          ]}
        />
        <Link to="/changes/$changeId" params={{ changeId: selection.changeId }} className={link}>
          Open the Change
          <ArrowRight size={14} aria-hidden />
        </Link>
        {!scopedToChange && (
          <Link
            to="/projects/$projectId/events"
            params={{ projectId }}
            search={{ change: selection.changeId, view: "graph" }}
            className={link}
          >
            Only this Change
            <ArrowRight size={14} aria-hidden />
          </Link>
        )}
      </>
    );
  }
  const t = selection.task;
  return (
    <>
      <header className="grid gap-1.5">
        <p className="type-kicker text-kumo-accent">Task</p>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="min-w-0 text-[15px] font-semibold text-pretty">
            {t ? `${t.key} ${t.title}` : selection.taskId}
          </h3>
          {t && <StatusPill status={t.status} />}
        </div>
      </header>
      <KeyValue
        items={[
          { label: "Task", value: selection.taskId, mono: true },
          { label: "Objective", value: t?.objective ?? null },
          { label: "Agent", value: t?.assignedAgentId ?? null, mono: true },
          { label: "Loaded events", value: formatNumber(selection.count), mono: true },
        ]}
      />
      {selection.changeId && (
        <Link to="/changes/$changeId" params={{ changeId: selection.changeId }} className={link}>
          Open the Change
          <ArrowRight size={14} aria-hidden />
        </Link>
      )}
    </>
  );
}
NodeDetail.displayName = "NodeDetail";
