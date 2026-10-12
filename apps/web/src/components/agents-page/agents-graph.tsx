import { ArrowRight } from "@phosphor-icons/react";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import {
  type AgentView,
  type ChangeSummary,
  type FeedEvent,
  getConflicts,
  listChangeEvents,
  listTasks,
  type TaskDetail,
} from "../../lib/api";
import { changeLabel, formatNumber, formatUsd, timeAgo } from "../../lib/format";
import { DagCanvas, edgeSwatch, type LegendItem, nodeSwatch } from "../dag/dag-canvas";
import { DagFilters, type FilterOption } from "../dag/dag-filters";
import {
  type DagEdgeSpec,
  type DagFilter,
  type DagNodeSpec,
  EMPTY_FILTER,
  inTimeRange,
  lineage,
} from "../dag/model";
import { SectionError } from "../project/feedback";
import { ReplayBar } from "../replay/replay-bar";
import { useReplay } from "../replay/use-replay";
import { EmptyState } from "../ui/empty-state";
import { KeyValue } from "../ui/key-value";
import { Mono } from "../ui/mono";
import { Section } from "../ui/page";
import { StatusPill } from "../ui/status-pill";
import { AgentInspector } from "./agent-inspector";
import {
  AGENTS_REPLAY_LEGEND,
  type AgentsTiming,
  agentAt,
  buildTiming,
  type ChangeData,
  conflictAt,
  conflictKind,
} from "./agents-replay";
import { AgentsReplayStrip } from "./agents-replay-strip";

/**
 * Agents graph (AGENTS.md 38.6; DESIGN.md 9.13): Changes, their Tasks with the Work Graph
 * dependency edges, the agent of each Task with its model tiers and status, and the semantic
 * conflicts between Tasks as dashed edges coloured by state. Left to right by dependency depth.
 * Data: the agents list, one Task list and one conflict list per Change in scope (at most
 * MAX_CHANGES, so the D1 reads stay small), and the opening events of each such Change (one
 * page, read once) for the replay.
 *
 * Replay (components/replay, agents-replay.ts): the replay bar plays the recorded facts again.
 * Change and Task nodes appear when they were created; an agent appears when its first attempt
 * starts, shows its model tier (H, S, O) and a progress line while an attempt runs, and turns
 * done or failed at the recorded end; retries and escalations show in its meta line. Conflict
 * edges appear (dashed) when detected and take their recorded state. Nodes keep their places,
 * so nothing moves but the state. Live (the default) shows the newest state and follows it.
 */

const MAX_CHANGES = 4;
const COLUMN = 280;
const ROW = 118;
const GROUP_GAP = 56;

const ACTIVE_TASK = new Set(["assigned", "running"]);
const TIER_LABEL: Record<string, string> = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" };

/**
 * Changes in scope: the chosen Change, else Changes with listed agents active in the range, else
 * the newest Change. Person narrows every choice. At most MAX_CHANGES. The route loader reads
 * the Task and conflict lists of the same Changes on the server (`EMPTY_FILTER`).
 */
export function changesInScope(
  changes: ChangeSummary[],
  agents: AgentView[],
  filter: DagFilter = EMPTY_FILTER,
): ChangeSummary[] {
  const byPerson = changes.filter(
    (c) => filter.person === null || c.requester?.userId === filter.person,
  );
  if (filter.changeId) return byPerson.filter((c) => c.id === filter.changeId);
  const withAgents = new Set(
    agents.filter((a) => inTimeRange(a.lastActiveAt, filter.range)).map((a) => a.task.changeId),
  );
  const active = byPerson.filter((c) => withAgents.has(c.id));
  const inRange = byPerson.filter((c) => inTimeRange(c.createdAt, filter.range));
  return (active.length > 0 ? active : inRange.slice(0, 1)).slice(0, MAX_CHANGES);
}

type Selection =
  | { kind: "change"; change: ChangeSummary }
  | { kind: "task"; change: ChangeSummary; task: TaskDetail }
  | { kind: "agent"; change: ChangeSummary; task: TaskDetail; agent: AgentView | undefined };

const changeNode = (id: string) => `change:${id}`;
const taskNode = (id: string) => `task:${id}`;
const agentNode = (taskId: string) => `agent:${taskId}`;

/** Pure: the Changes in scope, laid out as lanes of Change → Tasks by depth → agent. */
function buildGraph(
  data: ChangeData[],
  agentsByTask: Map<string, AgentView>,
  filter: DagFilter,
  /** Replay playhead; null shows the newest state. */
  at: number | null,
  timing: AgentsTiming,
): { nodes: DagNodeSpec[]; edges: DagEdgeSpec[]; select: Map<string, Selection> } {
  const nodes: DagNodeSpec[] = [];
  const edges: DagEdgeSpec[] = [];
  const select = new Map<string, Selection>();
  let top = 0;

  for (const { change, tasks: allTasks, conflicts } of data) {
    // Task filter: the Task, its ancestors and its descendants inside its Change.
    let tasks = allTasks;
    if (filter.taskId && allTasks.some((t) => t.id === filter.taskId)) {
      const deps: DagEdgeSpec[] = allTasks.flatMap((t) =>
        t.dependsOn.map((d) => ({ id: `${d}>${t.id}`, source: d, target: t.id, kind: "flow" })),
      );
      const keep = lineage(deps, filter.taskId);
      tasks = allTasks.filter((t) => keep.has(t.id));
    }
    const byId = new Map(tasks.map((t) => [t.id, t]));

    // Depth in the Work Graph: 0 for a Task with no dependency in view.
    const depth = new Map<string, number>();
    const depthOf = (id: string, seen: Set<string>): number => {
      const known = depth.get(id);
      if (known !== undefined) return known;
      if (seen.has(id)) return 0;
      seen.add(id);
      const deps = (byId.get(id)?.dependsOn ?? []).filter((d) => byId.has(d));
      const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => depthOf(d, seen)));
      depth.set(id, value);
      return value;
    };
    const columns = new Map<number, TaskDetail[]>();
    for (const t of tasks) {
      const d = depthOf(t.id, new Set());
      columns.set(d, [...(columns.get(d) ?? []), t]);
    }
    for (const column of columns.values()) column.sort((a, b) => a.key.localeCompare(b.key));
    const rows = Math.max(1, ...[...columns.values()].map((c) => c.length));

    // Replay: the recorded status once the playhead passes the Change's last fact.
    const settled = at === null || at >= (timing.changeEnd.get(change.id) ?? 0);
    const started = (t: TaskDetail) =>
      at !== null && t.runs.some((r) => Date.parse(r.startedAt) <= at);
    const taskHidden = (t: TaskDetail) => at !== null && at < (timing.taskAt.get(t.id) ?? 0);

    // Change node, centred on its lane.
    const cId = changeNode(change.id);
    nodes.push({
      id: cId,
      position: { x: 0, y: top + ((rows - 1) * ROW) / 2 },
      kicker: "Change",
      title: changeLabel(change),
      meta: [change.requester?.name ?? null, `${formatNumber(change.taskCount)} Tasks`]
        .filter(Boolean)
        .join(" · "),
      status: settled ? change.status : allTasks.some(started) ? "running" : "compiling",
      border: "ink",
      width: 240,
      hidden: at !== null && at < (timing.changeAt.get(change.id) ?? 0),
    });
    select.set(cId, { kind: "change", change });

    for (const [d, column] of columns) {
      column.forEach((task, row) => {
        const y = top + row * ROW;
        const tId = taskNode(task.id);
        const x = COLUMN + d * 2 * COLUMN;
        const now = at === null || settled ? null : agentAt(task, at);
        const hidden = taskHidden(task);
        nodes.push({
          id: tId,
          position: { x, y },
          kicker: `Task · ${task.kind}`,
          title: `${task.key} ${task.title}`,
          meta: `${task.riskTier} risk · ${task.complexity}`,
          status: now ? (now.status ?? "pending") : task.status,
          border: (now ? now.status === "running" : ACTIVE_TASK.has(task.status))
            ? "accent"
            : (now ? now.runs.length : task.runs.length) > 0
              ? "ink"
              : "divider",
          hidden,
        });
        select.set(tId, { kind: "task", change, task });
        const deps = task.dependsOn.filter((dep) => byId.has(dep));
        if (deps.length === 0) {
          edges.push({ id: `${cId}>${tId}`, source: cId, target: tId, kind: "flow", hidden });
        }
        for (const dep of deps) {
          edges.push({
            id: `${dep}>${task.id}`,
            source: taskNode(dep),
            target: tId,
            kind: "flow",
            hidden,
          });
        }

        // The agent of the Task, once it has woken.
        const agent = agentsByTask.get(task.id);
        if (task.runs.length === 0 && !agent) return;
        // At the playhead: the attempts started by then, else every attempt.
        const runs = now ? now.runs : task.runs;
        const tiers = runs.map((r) => TIER_LABEL[r.tier] ?? r.tier);
        const chain = tiers.filter((t, i) => t !== tiers[i - 1]).join(" → ");
        const last = runs.at(-1);
        const previous = runs.at(-2);
        const cost = runs.reduce((s, r) => s + (r.endedAt ? r.costUsd : 0), 0);
        const aId = agentNode(task.id);
        const running = now ? now.status === "running" : last?.status === "running";
        const step =
          previous && last ? (previous.tier === last.tier ? " · retry" : " · escalated") : "";
        nodes.push({
          id: aId,
          position: { x: x + COLUMN, y },
          kicker: agent ? `Agent · ${agent.role}` : "Agent",
          title: chain || (agent?.tier ? (TIER_LABEL[agent.tier] ?? agent.tier) : "Not run"),
          meta: `${formatNumber(runs.length)} ${runs.length === 1 ? "attempt" : "attempts"}${step} · ${formatUsd(cost)}`,
          status: now
            ? (now.status ?? undefined)
            : running
              ? "running"
              : agent?.state === "sleeping"
                ? "asleep"
                : last?.status,
          border: running ? "accent" : "divider",
          width: 180,
          tier: running && last ? last.tier : null,
          working: running,
          progress: now?.progress ?? null,
          hidden: at !== null && runs.length === 0,
        });
        select.set(aId, { kind: "agent", change, task, agent });
        edges.push({
          id: `${tId}>agent`,
          source: tId,
          target: aId,
          kind: "flow",
          hidden: at !== null && runs.length === 0,
        });
      });
    }

    for (const c of conflicts) {
      const [a, b] = c.intents;
      if (!byId.has(a.taskId) || !byId.has(b.taskId) || a.taskId === b.taskId) continue;
      const state = at === null ? conflictKind(c) : conflictAt(c, at);
      const { kind, label } = state ?? conflictKind(c);
      edges.push({
        id: `conflict:${c.id}`,
        source: taskNode(a.taskId),
        target: taskNode(b.taskId),
        kind: state ? kind : "conflict_suspected",
        label: `${state ? label : "suspected"} · ${c.resource}`,
        hidden: state === null,
      });
    }

    top += rows * ROW + GROUP_GAP;
  }
  return { nodes, edges, select };
}

const LEGEND: LegendItem[] = [
  { key: "active", label: "Working now", swatch: nodeSwatch("accent") },
  { key: "run", label: "Has run", swatch: nodeSwatch("ink") },
  { key: "idle", label: "Not run yet or asleep", swatch: nodeSwatch("divider") },
  { key: "flow", label: "Depends on (left to right)", swatch: edgeSwatch("flow") },
  { key: "confirmed", label: "Conflict confirmed", swatch: edgeSwatch("conflict_confirmed") },
  { key: "fork", label: "Conflict forked", swatch: edgeSwatch("conflict_fork") },
  { key: "suspected", label: "Conflict suspected", swatch: edgeSwatch("conflict_suspected") },
  { key: "dismissed", label: "Conflict dismissed", swatch: edgeSwatch("conflict_dismissed") },
];

export function AgentsGraph({
  agents,
  changes,
  feedAvailable,
  live,
  pollMs,
}: {
  /** Listed agents (active and recently active). */
  agents: AgentView[];
  /** Changes of the Project, newest first. */
  changes: ChangeSummary[];
  feedAvailable: boolean;
  /** True while an agent is active: the Task and conflict lists then refresh. */
  live: boolean;
  pollMs: number;
}) {
  const [filter, setFilter] = useState<DagFilter>(EMPTY_FILTER);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const agentsByTask = useMemo(() => new Map(agents.map((a) => [a.task.id, a])), [agents]);

  const scoped = useMemo(() => changesInScope(changes, agents, filter), [changes, agents, filter]);
  const hiddenChanges = filter.changeId
    ? 0
    : Math.max(
        0,
        new Set(
          agents
            .filter((a) => inTimeRange(a.lastActiveAt, filter.range))
            .map((a) => a.task.changeId),
        ).size - scoped.length,
      );

  const refetchInterval = live ? pollMs : false;
  const taskQueries = useQueries({
    queries: scoped.map((c) => ({
      queryKey: ["tasks", c.id],
      queryFn: () => listTasks({ data: c.id }),
      refetchInterval,
    })),
  });
  const conflictQueries = useQueries({
    queries: scoped.map((c) => ({
      queryKey: ["conflicts", c.id],
      queryFn: () => getConflicts({ data: c.id }),
      refetchInterval,
    })),
  });
  const pending = taskQueries.some((q) => q.isPending);
  const failed = [...taskQueries, ...conflictQueries].find((q) => q.isError);

  // useQueries returns a new array each render; the update stamps say when any data changed.
  const stamp = [...taskQueries, ...conflictQueries].map((q) => q.dataUpdatedAt).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `stamp` tracks the query data
  const data: ChangeData[] = useMemo(
    () =>
      scoped.map((change, i) => ({
        change,
        tasks: taskQueries[i]?.data ?? [],
        conflicts: conflictQueries[i]?.data ?? [],
      })),
    [scoped, stamp],
  );

  // The opening events of each Change (creation, plan, Tasks): one page, read once.
  const openingQueries = useQueries({
    queries: scoped.map((c) => ({
      queryKey: ["change-opening-events", c.id],
      queryFn: () => listChangeEvents({ data: { changeId: c.id, after: 0, limit: 100 } }),
      staleTime: Number.POSITIVE_INFINITY,
    })),
  });
  const openStamp = openingQueries.map((q) => q.dataUpdatedAt).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `openStamp` tracks the query data
  const openings = useMemo(
    () =>
      new Map<string, FeedEvent[]>(
        scoped.map((c, i) => [c.id, openingQueries[i]?.data?.events ?? []]),
      ),
    [scoped, openStamp],
  );
  const timing = useMemo(() => buildTiming(data, openings), [data, openings]);
  const replay = useReplay(timing.times, { live, tickMs: 200 });
  const at = replay.mode === "replay" ? replay.at : null;

  const graph = useMemo(
    () => buildGraph(data, agentsByTask, filter, at, timing),
    [data, agentsByTask, filter, at, timing],
  );
  const selection = selectedId ? graph.select.get(selectedId) : undefined;

  const people: FilterOption[] = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of changes) {
      if (c.requester) {
        seen.set(c.requester.userId, c.requester.isYou ? "You" : (c.requester.name ?? "Unnamed"));
      }
    }
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [changes]);
  const changeOptions = useMemo(
    () =>
      changes
        .filter((c) => filter.person === null || c.requester?.userId === filter.person)
        .map((c) => ({ value: c.id, label: changeLabel(c) })),
    [changes, filter.person],
  );
  const taskOptions = useMemo(
    () =>
      data.flatMap(({ tasks }) =>
        tasks.map((t) => {
          const agent = agentsByTask.get(t.id);
          return { value: t.id, label: `${t.key} ${t.title}${agent ? ` · ${agent.agentId}` : ""}` };
        }),
      ),
    [data, agentsByTask],
  );

  const onSelect = useCallback(
    (id: string) => setSelectedId((current) => (current === id ? null : id)),
    [],
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(320px,400px)] items-start gap-7 max-[1100px]:grid-cols-1">
      <Section
        label="Agent graph"
        meta={
          <Mono subtle>
            {formatNumber(scoped.length)} {scoped.length === 1 ? "Change" : "Changes"} ·{" "}
            {formatNumber(graph.nodes.length)} nodes
          </Mono>
        }
      >
        <div className="grid gap-4">
          <DagFilters
            filter={filter}
            onChange={(next) => {
              setFilter(next);
              setSelectedId(next.taskId ? taskNode(next.taskId) : null);
            }}
            people={people}
            changes={changeOptions}
            tasks={taskOptions}
          />
          {failed && (
            <SectionError
              message={`Part of the graph could not load. ${failed.error?.message ?? ""}`}
              onRetry={() => {
                for (const q of [...taskQueries, ...conflictQueries])
                  if (q.isError) void q.refetch();
              }}
            />
          )}
          {pending ? (
            <span aria-hidden className="skeleton block h-[clamp(380px,52vw,600px)] w-full" />
          ) : graph.nodes.length === 0 ? (
            <EmptyState
              what="No Change matches these filters."
              how="Clear a filter, or pick a wider time range."
            />
          ) : (
            <>
              <ReplayBar
                replay={replay}
                ticks={timing.ticks}
                legend={AGENTS_REPLAY_LEGEND}
                label="Agent replay"
              />
              <DagCanvas
                label="Agent graph"
                nodes={graph.nodes}
                edges={graph.edges}
                selectedId={selectedId}
                onSelect={onSelect}
                legend={LEGEND}
                caption={
                  <>
                    Each lane is one Change: its Tasks by Work Graph depth, each Task's agent to its
                    right with the model tiers it used, and semantic conflicts between Tasks as
                    dashed edges. Select a node to keep its ancestors and descendants and dim the
                    rest.
                    {filter.changeId
                      ? ""
                      : ` Without a Change filter the graph shows up to ${MAX_CHANGES} Changes with recently active agents${hiddenChanges > 0 ? `; ${formatNumber(hiddenChanges)} more are hidden` : ""}.`}{" "}
                    Agents asleep longer than the recent window show from their Task's runs. The
                    replay bar plays the recorded facts again: nodes appear when they were recorded,
                    agents show their tier (H, S, O) while they work, and conflict edges take their
                    recorded state.
                  </>
                }
              />
              <AgentsReplayStrip data={data} timing={timing} replay={replay} />
            </>
          )}
        </div>
      </Section>

      <NodeDetail selection={selection} feedAvailable={feedAvailable} />
    </div>
  );
}
AgentsGraph.displayName = "AgentsGraph";

/** Inspector beside the graph: the agent inspector for an agent, a short card otherwise. */
function NodeDetail({
  selection,
  feedAvailable,
}: {
  selection: Selection | undefined;
  feedAvailable: boolean;
}) {
  if (selection?.kind === "agent" && selection.agent) {
    return <AgentInspector agent={selection.agent} feedAvailable={feedAvailable} />;
  }
  const link = "inline-flex items-center gap-1.5 text-kumo-accent hover:underline";
  return (
    <aside className="grid min-w-0 content-start gap-4 bg-kumo-elevated p-4">
      {!selection ? (
        <EmptyState
          what="No node selected."
          how="Select a Change, a Task or an agent in the graph to see its detail."
        />
      ) : (
        <>
          <header className="grid gap-1.5">
            <p className="type-kicker text-kumo-accent">
              {selection.kind === "change"
                ? "Change"
                : selection.kind === "task"
                  ? "Task"
                  : "Agent"}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <h3
                className="min-w-0 text-[15px] font-semibold text-pretty"
                title={selection.kind === "change" ? selection.change.goal : undefined}
              >
                {selection.kind === "change"
                  ? changeLabel(selection.change)
                  : `${selection.task.key} ${selection.task.title}`}
              </h3>
              <StatusPill
                status={
                  selection.kind === "change" ? selection.change.status : selection.task.status
                }
              />
            </div>
          </header>
          {selection.kind === "change" ? (
            <KeyValue
              items={[
                { label: "Change", value: selection.change.id, mono: true },
                { label: "Requested by", value: selection.change.requester?.name ?? null },
                {
                  label: "Tasks",
                  value: `${formatNumber(selection.change.completedCount)} of ${formatNumber(selection.change.taskCount)} done`,
                },
                { label: "Created", value: timeAgo(selection.change.createdAt), mono: true },
              ]}
            />
          ) : (
            <KeyValue
              items={[
                { label: "Task", value: selection.task.id, mono: true },
                { label: "Objective", value: selection.task.objective },
                {
                  label: "Kind",
                  value: `${selection.task.kind} · ${selection.task.complexity} · risk ${selection.task.riskTier}`,
                },
                {
                  label: "Resources",
                  value: selection.task.semanticResources.join(", ") || null,
                  mono: true,
                },
                { label: "Agent", value: selection.task.assignedAgentId, mono: true },
                {
                  label: "Attempts",
                  value:
                    selection.task.runs.length > 0
                      ? selection.task.runs
                          .map((r) => `${TIER_LABEL[r.tier] ?? r.tier} ${r.status}`)
                          .join(" → ")
                      : null,
                },
              ]}
            />
          )}
          {selection.kind === "agent" && (
            <p className="text-[12px] text-kumo-subtle">
              This agent is not in the recently active list, so only its Task's runs show here.
            </p>
          )}
          <Link to="/changes/$changeId" params={{ changeId: selection.change.id }} className={link}>
            Open the Change
            <ArrowRight size={14} aria-hidden />
          </Link>
        </>
      )}
    </aside>
  );
}
NodeDetail.displayName = "NodeDetail";
