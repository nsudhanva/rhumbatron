// biome-ignore-all lint/a11y/useFocusableInteractive: listbox options here are aria-activedescendant items of a one-tab-stop composite (use-roving-focus.ts); they are not focusable by design
import { cn } from "@cloudflare/kumo";
import { type CSSProperties, useId, useMemo } from "react";
import { formatDuration, formatNumber, truncate } from "../../../lib/format";
import { CALLS_PER_RUN } from "../../agents/activity-model";
import { FAMILY_FILL, statusView } from "../../ui/status-pill";
import { useFlight } from "../flight-context";
import {
  type FlightState,
  providerName,
  type RunState,
  refKey,
  type TaskState,
} from "../flight-model";
import { type EntityRef, useFlightStore, useIsHighlighted, useSelection } from "../flight-store";
import { EntityHover } from "../hover-preview";
import type { PanelProps } from "../panel-types";
import {
  ROVING_CONTAINER,
  ROVING_ITEM,
  type RovingShow,
  useRovingFocus,
} from "../use-roving-focus";
import { TIER_FILL, TIER_LETTER, useDimmed, useVisibleLanes } from "./lanes/lanes";
import {
  AXIS_H,
  type AxisMark,
  LEFT,
  labelWidth,
  PlotRules,
  relTime,
  TimeAxis,
  TimelineToolbar,
  type TimeScale,
  useClock,
  useFollowLive,
  useLiveInstant,
  useMeasuredScroller,
  useTimeScale,
} from "./lanes/timeline";

/**
 * Agent swimlanes (DESIGN.md 11.1 "working simultaneously", 9.8 trace waterfall): one lane per
 * Task with an agent, on a time axis shared with the workspace lanes. Each attempt is a bar
 * filled by model tier (letter inside: H, S, O); a failed attempt is hatched with its failure
 * kind; an escalation is a step-up glyph. Typed facts of the lane (Ready, Claim, Intent,
 * ChangeSet, Challenge, Done, Fail) are square markers above the bar. An open conflict holds an
 * accent connector between the two lanes. Candidate milestones are full-height rules.
 *
 * Each lane plot is ONE tab stop (use-roving-focus.ts): a listbox whose options are the attempt
 * bars and fact markers in time order. Arrows walk them, Up/Down move to the lane above or below,
 * Enter selects. A pointer anywhere on the lane picks the nearest item (ringed in ink), so the
 * 8px markers are never the pointer target on their own (DESIGN.md 5.2).
 *
 * Every mark is a recorded fact at its recorded time (flight-model.ts). The progress line on a
 * running bar is real model calls over the per-run call budget, not a timer.
 */

const ROW_H = 44;
const MARK = 8;
const MARK_Y = 3;
const BAR_Y = 14;
const BAR_H = 15;
const UNDER_Y = 31;

type MarkKind =
  | "ready"
  | "intent"
  | "claim"
  | "renew"
  | "release"
  | "expired"
  | "changeset"
  | "challenge"
  | "done"
  | "fail";

type Mark = {
  key: string;
  t: number;
  kind: MarkKind;
  label: string;
  ref: EntityRef;
  title: string;
};

const MARK_STYLE: Record<MarkKind, string> = {
  ready: "border border-tone-600 bg-kumo-elevated",
  intent: "bg-kumo-ink",
  claim: "border-2 border-kumo-ink bg-kumo-elevated",
  renew: "border border-kumo-ink bg-kumo-elevated scale-75",
  release: "border border-tone-500 bg-tone-200",
  expired: "bg-kumo-warning",
  changeset: "bg-tone-600",
  challenge: "bg-kumo-danger",
  done: "bg-kumo-success",
  fail: "bg-kumo-danger border border-kumo-ink",
};

const MARK_TEXT: Partial<Record<MarkKind, string>> = {
  challenge: "text-kumo-danger font-semibold",
  fail: "text-kumo-danger",
  expired: "text-kumo-warning",
  done: "text-kumo-success",
};

const str = (data: Record<string, unknown>, key: string) =>
  typeof data[key] === "string" ? (data[key] as string) : null;

/** Lane facts, one pass over the folded events (plus published ChangeSets of the Workspace). */
function laneMarks(state: FlightState, clockOf: (ms: number) => string): Map<string, Mark[]> {
  const out = new Map<string, Mark[]>();
  const push = (laneId: string | null, mark: Mark) => {
    if (!laneId || !state.tasks[laneId]) return;
    const list = out.get(laneId) ?? [];
    list.push(mark);
    out.set(laneId, list);
  };
  for (const e of state.events) {
    const base = { t: e.at, title: `${e.detail} · ${clockOf(e.at)}` };
    switch (e.kind) {
      case "intent":
        push(e.laneId, {
          ...base,
          key: e.id,
          kind: "intent",
          label: "Intent",
          ref: { kind: "event", id: e.id },
        });
        break;
      case "run.end":
        push(e.laneId, {
          ...base,
          key: e.id,
          kind: e.status === "completed" ? "done" : "fail",
          label: e.status === "completed" ? "Done" : "Fail",
          ref: { kind: "event", id: e.id },
        });
        break;
      case "claim": {
        const kind: MarkKind =
          e.action === "acquired"
            ? "claim"
            : e.action === "renewed"
              ? "renew"
              : e.action === "released"
                ? "release"
                : "expired";
        push(e.laneId, {
          ...base,
          key: e.id,
          kind,
          label:
            kind === "claim"
              ? "Claim"
              : kind === "release"
                ? "Release"
                : kind === "expired"
                  ? "Expired"
                  : "",
          ref: { kind: "event", id: e.id },
        });
        break;
      }
      case "challenge":
        for (const laneId of [e.fromLaneId, e.toLaneId]) {
          push(laneId, {
            ...base,
            key: `${e.id}:${laneId}`,
            kind: "challenge",
            label: e.challenged ? "Challenge" : "Suspected",
            ref: { kind: "conflict", id: e.conflictId },
          });
        }
        break;
      case "fact": {
        if (!e.laneId) break;
        if (e.eventType === "task.ready") {
          push(e.laneId, {
            ...base,
            key: e.id,
            kind: "ready",
            label: "Ready",
            ref: { kind: "event", id: e.id },
          });
        } else if (e.eventType === "task.completed" || e.eventType === "task.failed") {
          const done = e.eventType === "task.completed";
          push(e.laneId, {
            ...base,
            key: e.id,
            kind: done ? "done" : "fail",
            label: done ? "Done" : "Fail",
            ref: { kind: "event", id: e.id },
          });
        } else if (e.eventType === "changeset.proposed") {
          const csId = str(e.data, "changeSetId");
          const published = csId
            ? state.tasks[e.laneId]?.changeSets.some((cs) => cs.id === csId)
            : false;
          // A ChangeSet the Workspace lists is drawn from its record below, not twice.
          if (!published) {
            push(e.laneId, {
              ...base,
              key: e.id,
              kind: "changeset",
              label: "ChangeSet",
              ref: csId ? { kind: "changeset", id: csId } : { kind: "event", id: e.id },
            });
          }
        }
        break;
      }
      default:
        break;
    }
  }
  for (const t of Object.values(state.tasks)) {
    for (const cs of t.changeSets) {
      const at = Date.parse(cs.createdAt);
      if (Number.isNaN(at)) continue;
      push(t.id, {
        key: `cs:${cs.id}`,
        t: at,
        kind: "changeset",
        label: "ChangeSet",
        ref: { kind: "changeset", id: cs.id },
        title: `ChangeSet ${cs.id} · ${cs.commit.slice(0, 7)} · +${cs.insertions} −${cs.deletions} · ${clockOf(at)}`,
      });
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.t - b.t);
  return out;
}

/** Candidate milestones: forks, verdicts, approvals and promotions, as axis marks. */
function milestones(state: FlightState): AxisMark[] {
  const marks: AxisMark[] = [];
  for (const e of state.events) {
    const name =
      "candidateId" in e && e.candidateId
        ? (state.candidates[e.candidateId]?.name ?? e.actor)
        : e.actor;
    switch (e.kind) {
      case "candidate.fork":
        marks.push({
          key: e.id,
          t: e.at,
          label: `${name} forked`,
          ref: { kind: "candidate", id: e.candidateId },
          tone: "ink",
        });
        break;
      case "candidate.status":
        if (e.status === "verified" || e.status === "rejected" || e.status === "stale") {
          marks.push({
            key: e.id,
            t: e.at,
            label: `${name} ${e.status}`,
            ref: { kind: "candidate", id: e.candidateId },
            tone: e.status === "verified" ? "ok" : "danger",
          });
        }
        break;
      case "approval":
        marks.push({
          key: e.id,
          t: e.at,
          label: `${name} ${e.decision === "granted" ? "approved" : "not approved"}`,
          ref: { kind: "candidate", id: e.candidateId },
          tone: e.decision === "granted" ? "ink" : "danger",
        });
        break;
      case "promoted":
        marks.push({
          key: e.id,
          t: e.at,
          label: `${name} promoted → S${e.generation}`,
          ref: { kind: "candidate", id: e.candidateId },
          tone: "accent",
        });
        break;
      default:
        break;
    }
  }
  return marks;
}

/** "shares wishlist:membership with T03" notes for the header tooltip. */
function overlapNotes(state: FlightState, ids: string[]): Map<string, string[]> {
  const notes = new Map<string, string[]>();
  const visible = new Set(ids);
  const add = (id: string, note: string) => notes.set(id, [...(notes.get(id) ?? []), note]);
  for (const a of ids) {
    const ta = state.tasks[a];
    if (!ta) continue;
    for (const b of ids) {
      if (a === b) continue;
      const tb = state.tasks[b];
      if (!tb) continue;
      for (const r of ta.semanticResources) {
        if (tb.semanticResources.includes(r)) add(a, `shares ${r} with ${tb.key}`);
      }
    }
  }
  for (const f of state.files) {
    if (!f.contended) continue;
    const owners = f.taskIds.filter((id) => visible.has(id));
    for (const a of owners) {
      const others = owners.filter((b) => b !== a).map((b) => state.tasks[b]?.key ?? b);
      if (others.length > 0) add(a, `shares ${f.path} with ${others.join(", ")}`);
    }
  }
  return notes;
}

export function SwimlanesPanel({ focused }: PanelProps) {
  const { state, model, ready } = useFlight();
  const scroller = useMeasuredScroller();
  const scale = useTimeScale(scroller.width);
  const { ids, hidden, filtered } = useVisibleLanes();
  const dimmed = useDimmed();
  const { follow, setFollow, onScroll } = useFollowLive(scroller.el, state.live, scale.width);
  const hatchId = `hatch${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  const clockOf = useClock();
  const marks = useMemo(() => laneMarks(state, clockOf), [state, clockOf]);
  const axisMarks = useMemo(() => milestones(state), [state]);
  const notes = useMemo(() => overlapNotes(state, ids), [state, ids]);
  const row = useMemo(() => new Map(ids.map((id, i) => [id, i])), [ids]);

  if (!ready) return <LanesSkeleton focused={focused} />;

  const open = state.conflicts.filter((c) => c.open).length;
  const height = ids.length * ROW_H;
  const summary = (
    <>
      {formatNumber(state.counts.running)} running · {formatNumber(ids.length)}{" "}
      {ids.length === 1 ? "lane" : "lanes"} · {formatNumber(open)} open{" "}
      {open === 1 ? "conflict" : "conflicts"}
      {hidden > 0 && ` · ${formatNumber(hidden)} Tasks not woken`}
      {filtered > 0 && ` · ${formatNumber(filtered)} filtered out`}
    </>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <TimelineToolbar
        summary={summary}
        live={state.live}
        follow={follow}
        onFollow={() => setFollow(!follow)}
      />
      <svg aria-hidden width="0" height="0" className="absolute">
        <defs>
          <pattern
            id={hatchId}
            width="5"
            height="5"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="5" strokeWidth="2" className="stroke-kumo-danger" />
          </pattern>
        </defs>
      </svg>
      <LanesTable ids={ids} start={model.bounds.start} />
      <div ref={scroller.ref} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-auto">
        {ids.length === 0 ? (
          <p className="px-3 py-3 text-[13px]">
            <span className="font-semibold">
              {filtered > 0 ? "No lane matches the filters." : "No agent has woken yet."}
            </span>{" "}
            <span className="text-kumo-subtle">
              {filtered > 0
                ? "Clear the filters to see every lane."
                : "A lane appears when the scheduler assigns a Task to an agent."}
            </span>
          </p>
        ) : (
          <div className="relative" style={{ width: LEFT + scale.width, minHeight: "100%" }}>
            <TimeAxis
              scale={scale}
              live={state.live}
              marks={axisMarks}
              corner={<span className="type-label">Agent lanes</span>}
            />
            <div className="relative">
              {ids.map((id) => {
                const task = state.tasks[id];
                if (!task) return null;
                return (
                  <Lane
                    key={id}
                    task={task}
                    marks={marks.get(id) ?? []}
                    scale={scale}
                    hatchId={hatchId}
                    note={notes.get(id) ?? []}
                    dim={dimmed({ kind: "task", id })}
                    live={state.live}
                  />
                );
              })}
            </div>
            <PlotRules scale={scale} height={height} milestones={axisMarks.map((m) => m.t)} />
            <Connectors scale={scale} row={row} />
          </div>
        )}
      </div>
    </div>
  );
}
SwimlanesPanel.displayName = "SwimlanesPanel";

function LanesSkeleton({ focused }: { focused: boolean }) {
  return (
    <div aria-hidden className="grid content-start">
      <div className="h-9 border-b border-kumo-rule" />
      <div className="border-b border-kumo-rule" style={{ height: AXIS_H }} />
      {Array.from({ length: focused ? 12 : 6 }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
          key={i}
          className="flex items-center gap-3 border-b border-kumo-rule px-3"
          style={{ height: ROW_H }}
        >
          <span className="h-3 w-[180px] shrink-0 animate-pulse bg-kumo-faint motion-reduce:animate-none" />
          <span
            className="h-3.5 animate-pulse bg-kumo-faint motion-reduce:animate-none"
            style={{ marginLeft: `${(i * 37) % 30}%`, width: `${25 + ((i * 23) % 40)}%` }}
          />
        </div>
      ))}
    </div>
  );
}
LanesSkeleton.displayName = "LanesSkeleton";

function Lane({
  task,
  marks,
  scale,
  hatchId,
  note,
  dim,
  live,
}: {
  task: TaskState;
  marks: Mark[];
  scale: TimeScale;
  hatchId: string;
  note: string[];
  dim: boolean;
  live: boolean;
}) {
  // Marker placement: same-instant facts sit side by side (2px apart). A label shows only when
  // it ends before the next marker starts, so labels never run under another square.
  const placed = useMemo(() => {
    let lastX = Number.NEGATIVE_INFINITY;
    const xs = marks.map((m) => {
      lastX = Math.max(scale.x(m.t) - MARK / 2, lastX + MARK + 2);
      return lastX;
    });
    return marks.map((m, i) => {
      const x = xs[i] ?? 0;
      const next = xs[i + 1] ?? Number.POSITIVE_INFINITY;
      const showLabel = m.label !== "" && x + MARK + 3 + labelWidth(m.label) < next - 2;
      return { ...m, x, showLabel };
    });
  }, [marks, scale]);

  // Lane items in time order: attempt bars (by start) and fact markers, one composite.
  const items = useMemo(
    () =>
      [
        ...task.runs.map((run) => ({
          key: `run:${run.attempt}`,
          x: scale.x(run.startedAt),
          ref: { kind: "decision", id: `route:${task.id}:${run.attempt}` } as EntityRef,
        })),
        ...placed.map((m) => ({ key: m.key, x: m.x, ref: m.ref })),
      ].sort((a, b) => a.x - b.x),
    [task, placed, scale],
  );
  const rows = useMemo(() => [items.map((i) => i.key)], [items]);
  const selection = useSelection();
  const initial = selection
    ? (items.find((i) => refKey(i.ref) === refKey(selection))?.key ?? null)
    : null;
  const roving = useRovingFocus({
    rows,
    initial,
    group: "agent-lanes",
    onActivate: (key) => {
      const ref = items.find((i) => i.key === key)?.ref;
      if (ref) useFlightStore.getState().toggle(ref);
    },
  });

  const content = (
    <>
      {task.runs.map((run, i) => (
        <AttemptBar
          key={run.attempt}
          task={task}
          run={run}
          next={task.runs[i + 1] ?? null}
          scale={scale}
          hatchId={hatchId}
          item={roving.itemProps(`run:${run.attempt}`)}
          show={roving.show(`run:${run.attempt}`)}
        />
      ))}
      {placed.map((m) => (
        <Marker
          key={m.key}
          mark={m}
          x={m.x}
          showLabel={m.showLabel}
          item={roving.itemProps(m.key)}
          show={roving.show(m.key)}
        />
      ))}
    </>
  );

  return (
    <div
      className={cn(
        "relative flex border-b border-kumo-rule transition-opacity duration-(--rh-dur-ui)",
        dim && "opacity-45",
      )}
      style={{ height: ROW_H }}
    >
      <LaneHeader task={task} note={note} live={live} />
      {items.length > 0 ? (
        <div
          role="listbox"
          aria-orientation="horizontal"
          aria-label={`${task.key} attempts and facts`}
          {...roving.containerProps}
          className={cn("relative shrink-0 overflow-hidden", ROVING_CONTAINER)}
          style={{ width: scale.width }}
        >
          {content}
        </div>
      ) : (
        <div className="relative shrink-0 overflow-hidden" style={{ width: scale.width }}>
          {content}
        </div>
      )}
    </div>
  );
}
Lane.displayName = "Lane";

/** Props a lane hands each of its items (use-roving-focus `itemProps`). */
type ItemProps = ReturnType<ReturnType<typeof useRovingFocus>["itemProps"]>;

function LaneHeader({ task, note, live }: { task: TaskState; note: string[]; live: boolean }) {
  const instant = useLiveInstant();
  const ref: EntityRef = { kind: "task", id: task.id };
  const { selected, hovered } = useIsHighlighted(ref);
  const view = statusView(task.status);
  const running = task.running;
  const last = running ?? task.runs[task.runs.length - 1] ?? null;
  const tier = running?.tier ?? task.lane.tier;
  const provider = providerName(last?.provider ?? null);
  const elapsed = running ? formatDuration(Math.max(0, instant - running.startedAt) / 1000) : null;
  const calls = running
    ? `${live ? formatNumber(running.modelCalls) : "—"} / ${CALLS_PER_RUN[running.tier]} calls`
    : null;
  const step = task.lane.step;
  const title = [
    `${task.key} · ${task.title}`,
    `${view.label}${tier ? ` · ${tier}` : ""}${provider ? ` · ${provider}` : ""}`,
    task.agentId ? `Agent ${task.agentId}` : "No agent assigned",
    ...note,
  ].join("\n");
  return (
    <EntityHover entity={ref}>
      <button
        type="button"
        aria-pressed={selected}
        title={title}
        onClick={() => useFlightStore.getState().toggle(ref)}
        className={cn(
          "sticky left-0 z-10 grid shrink-0 content-center gap-px self-start border-r border-b border-kumo-rule bg-kumo-elevated px-3 text-left text-[12px] leading-[13px] transition-colors duration-(--rh-dur-ui)",
          "hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-500",
          selected && "shadow-[inset_2px_0_0_var(--color-accent-500)]",
          (selected || hovered) && "bg-kumo-faint",
        )}
        style={{ width: LEFT, height: ROW_H }}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className={cn("size-2 shrink-0", FAMILY_FILL[view.family])} />
          <span className="font-mono text-[12px] font-semibold">{task.key}</span>
          <span className={cn(view.family === "danger" && "text-kumo-danger")}>{view.label}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {tier && <span className="font-mono text-[12px] text-kumo-subtle">{tier}</span>}
            {provider && (
              <span className="bg-tone-200 px-1 text-[12px] text-tone-800">{provider}</span>
            )}
            {task.source === "fixture" && (
              <span className="border border-tone-500 px-1 text-[12px] text-kumo-subtle">
                fixture
              </span>
            )}
            {note.length > 0 && (
              <span className="font-mono text-[12px] text-kumo-subtle" aria-hidden>
                ⇄
              </span>
            )}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-kumo-subtle">
          <span className="min-w-0 truncate font-mono text-[12px]">
            {task.agentId ?? "no agent"}
          </span>
          <span className="shrink-0">· {task.kind}</span>
          {calls && <span className="ml-auto shrink-0 font-mono tabular-nums">{calls}</span>}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-kumo-subtle">
          <span className="min-w-0 truncate">{step}</span>
          {elapsed && (
            <span className="ml-auto shrink-0 font-mono text-kumo-default tabular-nums">
              {elapsed}
            </span>
          )}
        </span>
        <span className="sr-only">, {task.title}</span>
      </button>
    </EntityHover>
  );
}
LaneHeader.displayName = "LaneHeader";

function AttemptBar({
  task,
  run,
  next,
  scale,
  hatchId,
  item,
  show,
}: {
  task: TaskState;
  run: RunState;
  next: RunState | null;
  scale: TimeScale;
  hatchId: string;
  item: ItemProps;
  show: RovingShow;
}) {
  const clockOf = useClock();
  const x0 = scale.x(run.startedAt);
  const x1 = scale.x(run.endedAt ?? scale.cursor);
  const width = Math.max(3, x1 - x0);
  const failed = run.status === "failed";
  const running = run.status === "running";
  const progress = running ? Math.min(1, run.modelCalls / CALLS_PER_RUN[run.tier]) : 0;
  const label = `${task.key} attempt ${run.attempt} on ${run.tier}, ${statusView(run.status).label}${
    run.failureKind ? ` (${run.failureKind})` : ""
  }, ${formatNumber(run.modelCalls)} calls`;
  const inner =
    width >= 90
      ? `${TIER_LETTER[run.tier]} · ${failed && run.failureKind ? run.failureKind : `attempt ${run.attempt}`}`
      : width >= 14
        ? TIER_LETTER[run.tier]
        : "";
  // The failure kind goes under the bar when it does not fit inside and the next bar is not there.
  const room = (next ? scale.x(next.startedAt) : scale.width) - x0;
  const under = failed && run.failureKind && width < 90 ? run.failureKind : null;
  const ref: EntityRef = { kind: "decision", id: `route:${task.id}:${run.attempt}` };
  const { selected } = useIsHighlighted(ref);
  return (
    <>
      <EntityHover entity={ref} show={show}>
        <div
          role="option"
          aria-selected={selected}
          {...item}
          title={`${label}\n${clockOf(run.startedAt)} → ${run.endedAt ? clockOf(run.endedAt) : "running"}${
            run.failureReason ? `\n${run.failureReason}` : ""
          }`}
          className={cn(
            "absolute flex origin-left items-center overflow-hidden px-1 font-mono text-[12px] leading-none font-semibold whitespace-nowrap",
            ROVING_ITEM,
            TIER_FILL[run.tier],
            failed && "border border-kumo-danger",
          )}
          style={{ left: x0, top: BAR_Y, width, height: BAR_H, scrollMarginLeft: LEFT + 8 }}
        >
          {failed && (
            <svg aria-hidden className="pointer-events-none absolute inset-0 size-full">
              <rect width="100%" height="100%" fill={`url(#${hatchId})`} opacity="0.55" />
            </svg>
          )}
          <span className="relative">{inner}</span>
          <span className="sr-only">
            {inner ? ", " : ""}
            {label}. Shows the route decision.
          </span>
        </div>
      </EntityHover>
      {running && (
        <div
          aria-hidden
          className="pointer-events-none absolute h-0.5 bg-kumo-ink"
          style={{ left: x0, top: BAR_Y + BAR_H + 1, width: width * progress }}
        />
      )}
      {run.escalatedFrom && (
        <span
          aria-hidden
          title={`Escalated ${run.escalatedFrom} → ${run.tier}`}
          className="pointer-events-none absolute flex items-center gap-0.5 font-mono text-[12px] leading-none text-kumo-default"
          style={{ left: x0 - 1, top: UNDER_Y + 2 }}
        >
          <svg
            aria-hidden
            width="9"
            height="9"
            viewBox="0 0 9 9"
            className="stroke-kumo-ink"
            fill="none"
          >
            <polyline points="0.5,8.5 4.5,8.5 4.5,1.5 8.5,1.5" strokeWidth="1.5" />
          </svg>
          {TIER_LETTER[run.escalatedFrom]}→{TIER_LETTER[run.tier]}
        </span>
      )}
      {under && room > 24 && (
        <span
          aria-hidden
          className="pointer-events-none absolute truncate font-mono text-[12px] leading-none text-kumo-danger"
          style={{
            left: x0 + (run.escalatedFrom ? 34 : 0),
            top: UNDER_Y + 3,
            maxWidth: Math.max(24, room - 6),
          }}
        >
          {under}
        </span>
      )}
    </>
  );
}
AttemptBar.displayName = "AttemptBar";

function Marker({
  mark,
  x,
  showLabel,
  item,
  show,
}: {
  mark: Mark;
  x: number;
  showLabel: boolean;
  item: ItemProps;
  show: RovingShow;
}) {
  const { selected } = useIsHighlighted(mark.ref);
  const style: CSSProperties = {
    left: x,
    top: 0,
    height: MARK_Y * 2 + MARK,
    scrollMarginLeft: LEFT + 8,
  };
  return (
    <EntityHover entity={mark.ref} show={show}>
      <div
        role="option"
        aria-selected={selected}
        {...item}
        title={mark.title}
        className={cn("absolute z-[6] flex items-center gap-[3px]", ROVING_ITEM)}
        style={style}
      >
        <span
          aria-hidden
          className={cn(
            "block shrink-0",
            MARK_STYLE[mark.kind],
            selected && "outline-2 outline-offset-1 outline-accent-500",
          )}
          style={{ width: MARK, height: MARK }}
        />
        {showLabel && (
          <span
            className={cn(
              "font-mono text-[12px] leading-none whitespace-nowrap text-kumo-default",
              MARK_TEXT[mark.kind],
            )}
          >
            {mark.label}
          </span>
        )}
        <span className="sr-only">
          {showLabel ? ": " : ""}
          {mark.title}
        </span>
      </div>
    </EntityHover>
  );
}
Marker.displayName = "Marker";

/**
 * "Agents arguing": an accent connector between the two lanes of each conflict at the time it
 * was raised. It holds steady while the conflict is open; a resolved conflict leaves a dashed
 * rule. The label names the disputed resource and selects the conflict.
 */
function Connectors({ scale, row }: { scale: TimeScale; row: Map<string, number> }) {
  const { state } = useFlight();
  const items = useMemo(
    () =>
      state.conflicts.flatMap((c) => {
        const a = row.get(c.taskIds[0]);
        const b = row.get(c.taskIds[1]);
        const event = state.events.find((e) => e.id === c.eventId);
        if (a === undefined || b === undefined || !event) return [];
        const y1 = Math.min(a, b) * ROW_H + MARK_Y + MARK / 2;
        const y2 = Math.max(a, b) * ROW_H + MARK_Y + MARK / 2;
        return [{ c, x: scale.x(event.at), y1, y2 }];
      }),
    [state, row, scale],
  );
  if (items.length === 0) return null;
  return (
    <div
      className="pointer-events-none absolute z-[5]"
      style={{ left: LEFT, top: AXIS_H, width: scale.width, height: row.size * ROW_H }}
    >
      <svg aria-hidden className="absolute inset-0 size-full overflow-visible">
        {items.map(({ c, x, y1, y2 }) => (
          <path
            key={c.id}
            d={`M ${x} ${y1} L ${x} ${y2}`}
            pathLength={1}
            className={c.open ? "stroke-kumo-danger" : "stroke-kumo-divider"}
            strokeWidth={c.open ? 2 : 1}
            strokeDasharray={c.open ? undefined : "0.02 0.02"}
            fill="none"
          />
        ))}
      </svg>
      {items.map(({ c, x, y1, y2 }) => {
        const ref: EntityRef = { kind: "conflict", id: c.id };
        const text = `${c.open ? "" : "resolved · "}${truncate(c.resource.split(":").slice(-2).join(":"), 28)}`;
        return (
          <EntityHover key={c.id} entity={ref}>
            <button
              type="button"
              onClick={() => useFlightStore.getState().toggle(ref)}
              title={`Conflict on ${c.resource}\n“${c.statements[0]}”\nvs “${c.statements[1]}”`}
              // 24px tall target around the 16px chip (DESIGN.md 5.2).
              className="pointer-events-auto absolute flex h-6 items-center font-mono text-[12px] leading-[14px] whitespace-nowrap focus-visible:outline-2 focus-visible:outline-accent-500"
              style={{ left: x + 4, top: (y1 + y2) / 2 - 12 }}
            >
              <span
                className={cn(
                  "border bg-kumo-elevated px-1",
                  c.open
                    ? "border-kumo-danger text-kumo-danger"
                    : "border-kumo-rule text-kumo-subtle",
                )}
              >
                {c.open && <span aria-hidden>⇄ </span>}
                {text}
              </span>
              <span className="sr-only">
                , conflict on {c.resource}, {c.open ? "open" : "resolved"}
              </span>
            </button>
          </EntityHover>
        );
      })}
    </div>
  );
}
Connectors.displayName = "Connectors";

/** Text equivalent of the lanes (DESIGN.md 14). */
function LanesTable({ ids, start }: { ids: string[]; start: number }) {
  const { state } = useFlight();
  const clockOf = useClock();
  return (
    <div className="sr-only">
      <table>
        <caption>Agent lanes at {clockOf(state.at)}</caption>
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col">Agent</th>
            <th scope="col">Status</th>
            <th scope="col">Attempts</th>
            <th scope="col">Claims</th>
          </tr>
        </thead>
        <tbody>
          {ids.map((id) => {
            const t = state.tasks[id];
            if (!t) return null;
            return (
              <tr key={id}>
                <td>
                  {t.key} {t.title}
                </td>
                <td>{t.agentId ?? "none"}</td>
                <td>{statusView(t.status).label}</td>
                <td>
                  {t.runs
                    .map(
                      (r) =>
                        `attempt ${r.attempt} ${r.tier} ${statusView(r.status).label} from ${relTime(r.startedAt - start)}${r.failureKind ? ` (${r.failureKind})` : ""}`,
                    )
                    .join("; ") || "none"}
                </td>
                <td>{t.claims.join(", ") || "none"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
LanesTable.displayName = "LanesTable";
