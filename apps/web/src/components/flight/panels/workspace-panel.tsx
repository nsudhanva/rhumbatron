// biome-ignore-all lint/a11y/useFocusableInteractive: listbox options here are aria-activedescendant items of a one-tab-stop composite (use-roving-focus.ts); they are not focusable by design
import { cn } from "@cloudflare/kumo";
import { useMemo } from "react";
import type { WorkspaceChangeSet } from "../../../lib/api";
import { formatNumber, generation, truncate } from "../../../lib/format";
import { StatusPill, statusView } from "../../ui/status-pill";
import { useFlight } from "../flight-context";
import type { CandidateState, FlightState, TaskState } from "../flight-model";
import { type EntityRef, useFlightStore, useIsHighlighted, useSelection } from "../flight-store";
import { EntityHover } from "../hover-preview";
import type { PanelProps } from "../panel-types";
import {
  ROVING_CONTAINER,
  ROVING_ITEM,
  type RovingShow,
  useRovingFocus,
} from "../use-roving-focus";
import { useDimmed, useVisibleLanes } from "./lanes/lanes";
import {
  AXIS_H,
  LEFT,
  labelWidth,
  PlotRules,
  TimeAxis,
  TimelineToolbar,
  type TimeScale,
  useClock,
  useEnter,
  useFollowLive,
  useMeasuredScroller,
  useTimeScale,
} from "./lanes/timeline";

/**
 * Workspace lanes (GitButler / GitKraken style, forking and converging): the
 * canonical trunk on top, one branch per Task workspace fork with its ChangeSet commits, and one
 * merge row per Candidate where the composing branches join. A promoted Candidate merges back
 * into the trunk with the new generation; a rejected one greys out with its reason in words.
 *
 * Each fork lane's commits are one tab stop (a listbox, use-roving-focus.ts), like the agent lanes.
 *
 * Same time axis and zoom as the agent swimlanes. Data: Workspace view (`/v1/projects/:id/
 * workspace`: forks, ChangeSets, file stats) folded at the time-machine instant by flight-model.
 */

const ROW_H = 36;
const SQ = 8;

type ForkRow = {
  task: TaskState;
  start: number;
  end: number;
  /** ChangeSets published by the fold instant, with their x. */
  commits: { cs: WorkspaceChangeSet; t: number }[];
};

type CandidateRow = {
  cand: CandidateState;
  start: number | null;
  end: number;
  /** When the Candidate merged into the trunk. */
  promotedAt: number | null;
};

const time = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? null : t;
};

function forkRow(task: TaskState, cursor: number, at: number): ForkRow | null {
  const starts = [task.runs[0]?.startedAt ?? null, time(task.fork?.startedAt)].filter(
    (t): t is number => t !== null && t <= at,
  );
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const commits = task.changeSets
    .map((cs) => ({ cs, t: time(cs.createdAt) }))
    .filter((c): c is { cs: WorkspaceChangeSet; t: number } => c.t !== null);
  const ended = task.runs.map((r) => r.endedAt).filter((t): t is number => t !== null);
  const end = task.running ? cursor : Math.max(start, ...ended, ...commits.map((c) => c.t));
  return { task, start, end, commits };
}

function candidateRow(state: FlightState, cand: CandidateState, cursor: number): CandidateRow {
  let promotedAt: number | null = null;
  let settledAt: number | null = null;
  for (const e of state.events) {
    if (!("candidateId" in e) || e.candidateId !== cand.id) continue;
    if (e.kind === "promoted") promotedAt = e.at;
    if (e.kind === "candidate.status" && (e.status === "rejected" || e.status === "stale"))
      settledAt = e.at;
  }
  return {
    cand,
    start: cand.forkedAt,
    end:
      promotedAt ??
      (cand.status === "rejected" || cand.status === "stale" ? settledAt : null) ??
      cursor,
    promotedAt,
  };
}

export function WorkspacePanel({ focused }: PanelProps) {
  const { state, model, ready } = useFlight();
  const scroller = useMeasuredScroller();
  const scale = useTimeScale(scroller.width);
  const { ids } = useVisibleLanes();
  const dimmed = useDimmed();
  const { follow, setFollow, onScroll } = useFollowLive(scroller.el, state.live, scale.width);

  const forks = useMemo(
    () =>
      ids
        .map((id) => state.tasks[id])
        .filter((t): t is TaskState => !!t)
        .map((t) => forkRow(t, scale.cursor, state.at))
        .filter((r): r is ForkRow => r !== null),
    [ids, state, scale.cursor],
  );
  const candidates = useMemo(
    () =>
      state.candidateOrder
        .map((id) => state.candidates[id])
        .filter((c): c is CandidateState => !!c)
        .map((c) => candidateRow(state, c, scale.cursor)),
    [state, scale.cursor],
  );
  const proposed = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of state.events) {
      if (e.kind === "fact" && e.eventType === "changeset.proposed") {
        const id = e.data.changeSetId;
        if (typeof id === "string") map.set(id, e.id);
      }
    }
    return map;
  }, [state.events]);

  if (!ready) return <WorkspaceSkeleton focused={focused} />;

  const workspace = model.input.workspace;
  if (!workspace) {
    return (
      <div className="grid content-start gap-2 px-3 py-3 text-[13px]">
        <p className="flex items-center gap-2">
          <StatusPill status="gap" label="Not loaded" family="attention" />
          <span className="font-semibold">Workspace view not loaded.</span>
        </p>
        <p className="text-kumo-subtle">
          The project workspace endpoint did not answer, so forks, commits and Candidate merges are
          not drawn. The agent lanes still show every recorded attempt.
        </p>
      </div>
    );
  }

  const commits = forks.reduce((n, f) => n + f.commits.length, 0);
  const summary = (
    <>
      Canonical {generation(state.generation)} · {formatNumber(forks.length)}{" "}
      {forks.length === 1 ? "fork" : "forks"} · {formatNumber(commits)}{" "}
      {commits === 1 ? "ChangeSet" : "ChangeSets"} · {formatNumber(candidates.length)}{" "}
      {candidates.length === 1 ? "Candidate" : "Candidates"}
    </>
  );
  const rows = 1 + forks.length + candidates.length;
  const forkIndex = new Map(forks.map((f, i) => [f.task.id, 1 + i]));
  const candIndex = (i: number) => 1 + forks.length + i;
  const mid = (i: number) => i * ROW_H + ROW_H / 2;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <TimelineToolbar
        summary={summary}
        live={state.live}
        follow={follow}
        onFollow={() => setFollow(!follow)}
      />
      <WorkspaceTable forks={forks} candidates={candidates} />
      <div ref={scroller.ref} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-auto">
        <div className="relative" style={{ width: LEFT + scale.width, minHeight: "100%" }}>
          <TimeAxis
            scale={scale}
            live={state.live}
            corner={<span className="type-label">Workspaces</span>}
          />
          <div>
            <TrunkRow scale={scale} baseGeneration={model.input.change.baseGeneration} />
            {forks.map((f) => (
              <ForkLane
                key={f.task.id}
                row={f}
                scale={scale}
                proposed={proposed}
                dim={dimmed({ kind: "task", id: f.task.id })}
                dimmed={dimmed}
              />
            ))}
            {candidates.map((c) => (
              <CandidateLane
                key={c.cand.id}
                row={c}
                scale={scale}
                dim={dimmed({ kind: "candidate", id: c.cand.id })}
              />
            ))}
          </div>
          <PlotRules scale={scale} height={rows * ROW_H} milestones={[]} />
          <Graph
            scale={scale}
            rows={rows}
            forks={forks}
            candidates={candidates}
            forkIndex={forkIndex}
            candIndex={candIndex}
            mid={mid}
          />
        </div>
      </div>
    </div>
  );
}
WorkspacePanel.displayName = "WorkspacePanel";

function WorkspaceSkeleton({ focused }: { focused: boolean }) {
  return (
    <div aria-hidden className="grid content-start">
      <div className="h-9 border-b border-kumo-rule" />
      <div className="border-b-2 border-kumo-divider" style={{ height: AXIS_H }} />
      {Array.from({ length: focused ? 14 : 7 }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
          key={i}
          className="flex items-center gap-3 border-b border-kumo-rule px-3"
          style={{ height: ROW_H }}
        >
          <span className="h-3 w-[160px] shrink-0 animate-pulse bg-kumo-faint motion-reduce:animate-none" />
          <span
            className="h-px animate-pulse bg-kumo-faint motion-reduce:animate-none"
            style={{ marginLeft: `${(i * 31) % 25}%`, width: `${30 + ((i * 17) % 40)}%` }}
          />
        </div>
      ))}
    </div>
  );
}
WorkspaceSkeleton.displayName = "WorkspaceSkeleton";

const leftCell =
  "sticky left-0 z-10 grid shrink-0 content-center gap-px self-start border-r border-b border-kumo-rule bg-kumo-elevated px-3 text-left text-[11px] leading-[13px]";

function TrunkRow({ scale, baseGeneration }: { scale: TimeScale; baseGeneration: number }) {
  const { state, model } = useFlight();
  const canonical = model.input.workspace?.canonical;
  return (
    <div className="relative flex border-b border-kumo-rule" style={{ height: ROW_H }}>
      <div className={leftCell} style={{ width: LEFT, height: ROW_H }}>
        <span className="flex items-center gap-1.5">
          <span className="font-semibold">Canonical</span>
          <span className="font-mono text-[12px] font-semibold">
            {generation(state.generation)}
          </span>
        </span>
        <span
          className="truncate font-mono text-kumo-subtle"
          title={canonical?.artifactRef ?? undefined}
        >
          {canonical?.artifactRef ?? "artifact not recorded"}
        </span>
      </div>
      <div className="relative shrink-0 overflow-hidden" style={{ width: scale.width }}>
        <span
          className="absolute bg-kumo-ink px-1 font-mono text-[10px] leading-[14px] text-kumo-inverse"
          style={{ left: Math.max(0, scale.x(scale.start) - 2), top: 2 }}
        >
          {generation(baseGeneration)}
        </span>
      </div>
    </div>
  );
}
TrunkRow.displayName = "TrunkRow";

function ForkLane({
  row,
  scale,
  proposed,
  dim,
  dimmed,
}: {
  row: ForkRow;
  scale: TimeScale;
  proposed: Map<string, string>;
  dim: boolean;
  dimmed: (ref: EntityRef) => boolean;
}) {
  const { task } = row;
  const ref: EntityRef = { kind: "task", id: task.id };
  const { selected, hovered } = useIsHighlighted(ref);
  const view = statusView(task.status);
  const forkName = task.fork?.fork ?? null;
  const files = new Set(task.files.changed.map((f) => f.path)).size;
  // Commit labels: greedy, so a retry's second commit never overprints the first.
  let labelEnd = Number.NEGATIVE_INFINITY;
  const commits = row.commits.map((c) => {
    const x = scale.x(c.t);
    const text = `${c.cs.commit.slice(0, 7)} +${c.cs.insertions} −${c.cs.deletions}`;
    const show = x + SQ > labelEnd + 4;
    if (show) labelEnd = x + SQ / 2 + 4 + labelWidth(text);
    return { ...c, x, show };
  });
  const rows = [commits.map((c) => c.cs.id)];
  const selection = useSelection();
  const roving = useRovingFocus({
    rows,
    initial: selection?.kind === "changeset" ? selection.id : null,
    group: "workspace-lanes",
    onActivate: (id) => useFlightStore.getState().toggle({ kind: "changeset", id }),
  });
  const commitMarks = commits.map((c) => (
    <Commit
      key={c.cs.id}
      cs={c.cs}
      x={c.x}
      showLabel={c.show}
      eventId={proposed.get(c.cs.id) ?? null}
      dim={!dim && dimmed({ kind: "changeset", id: c.cs.id })}
      item={roving.itemProps(c.cs.id)}
      show={roving.show(c.cs.id)}
    />
  ));
  return (
    <div
      className={cn(
        "relative flex border-b border-kumo-rule transition-opacity duration-(--rh-dur-ui)",
        dim && "opacity-45",
      )}
      style={{ height: ROW_H }}
    >
      <EntityHover entity={ref}>
        <button
          type="button"
          aria-pressed={selected}
          title={forkName ?? "The Workspace view does not list a fork for this Task."}
          onClick={() => useFlightStore.getState().toggle(ref)}
          className={cn(
            leftCell,
            "transition-colors duration-(--rh-dur-ui) hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-500",
            selected && "shadow-[inset_2px_0_0_var(--color-accent-500)]",
            (selected || hovered) && "bg-kumo-faint",
          )}
          style={{ width: LEFT, height: ROW_H }}
        >
          <span className={cn("truncate font-mono text-[11px]", !forkName && "text-kumo-subtle")}>
            {forkName ?? "fork not listed"}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-kumo-subtle">
            <span className="font-mono font-semibold text-kumo-default">{task.key}</span>
            <span className={cn(view.family === "danger" && "text-kumo-danger")}>{view.label}</span>
            <span className="ml-auto shrink-0 font-mono tabular-nums">
              {formatNumber(files)} {files === 1 ? "file" : "files"}
            </span>
          </span>
          <span className="sr-only">, workspace fork of {task.key}</span>
        </button>
      </EntityHover>
      {commits.length > 0 ? (
        <div
          role="listbox"
          aria-orientation="horizontal"
          aria-label={`${task.key} ChangeSets`}
          {...roving.containerProps}
          className={cn("relative shrink-0 overflow-hidden", ROVING_CONTAINER)}
          style={{ width: scale.width }}
        >
          {commitMarks}
        </div>
      ) : (
        <div className="relative shrink-0 overflow-hidden" style={{ width: scale.width }} />
      )}
    </div>
  );
}
ForkLane.displayName = "ForkLane";

function Commit({
  cs,
  x,
  showLabel,
  eventId,
  dim,
  item,
  show,
}: {
  cs: WorkspaceChangeSet;
  x: number;
  showLabel: boolean;
  eventId: string | null;
  dim: boolean;
  item: ReturnType<ReturnType<typeof useRovingFocus>["itemProps"]>;
  show: RovingShow;
}) {
  const { animated } = useFlight();
  const clockOf = useClock();
  const ref: EntityRef = { kind: "changeset", id: cs.id };
  const { selected } = useIsHighlighted(ref);
  const enterRef = useEnter<HTMLSpanElement>(eventId !== null && animated.has(eventId));
  const title = `ChangeSet ${cs.id}\ncommit ${cs.commit} · ${cs.files.length} files · +${cs.insertions} −${cs.deletions}\n${clockOf(Date.parse(cs.createdAt))}`;
  return (
    <EntityHover entity={ref} show={show}>
      <div
        role="option"
        aria-selected={selected}
        {...item}
        title={title}
        className={cn(
          "absolute z-[6] flex h-6 items-center gap-1 pr-1 transition-opacity duration-(--rh-dur-ui)",
          ROVING_ITEM,
          dim && "opacity-45",
        )}
        style={{ left: x - SQ / 2, top: ROW_H / 2 - 12, scrollMarginLeft: LEFT + 8 }}
      >
        <span
          ref={enterRef}
          aria-hidden
          className={cn(
            "block shrink-0 bg-kumo-ink",
            selected && "outline-2 outline-offset-1 outline-accent-500",
          )}
          style={{ width: SQ, height: SQ }}
        />
        {showLabel && (
          <span className="bg-kumo-elevated font-mono text-[10px] leading-none whitespace-nowrap tabular-nums">
            {cs.commit.slice(0, 7)} <span className="text-kumo-success">+{cs.insertions}</span>{" "}
            <span className="text-kumo-danger">−{cs.deletions}</span>
          </span>
        )}
        <span className="sr-only">
          {showLabel ? ", " : `${cs.commit.slice(0, 7)}, `}ChangeSet {cs.id}, {cs.insertions}{" "}
          insertions, {cs.deletions} deletions
        </span>
      </div>
    </EntityHover>
  );
}
Commit.displayName = "Commit";

function CandidateLane({ row, scale, dim }: { row: CandidateRow; scale: TimeScale; dim: boolean }) {
  const { cand } = row;
  const ref: EntityRef = { kind: "candidate", id: cand.id };
  const { selected, hovered } = useIsHighlighted(ref);
  const view = statusView(cand.status);
  const rejected = cand.status === "rejected" || cand.status === "stale";
  const promoted = cand.promotedGeneration !== null;
  const reason = rejected ? (cand.reason ?? "no reason recorded") : null;
  const endX = scale.x(row.end);
  const meta = promoted
    ? `${generation(cand.detail.baseGeneration)} → ${generation(cand.promotedGeneration ?? 0)}`
    : `${formatNumber(cand.changeSetIds.length)} ChangeSets · from ${generation(cand.detail.baseGeneration)}`;
  return (
    <div
      data-state={rejected ? "rejected" : undefined}
      className={cn("rh-greyout relative flex border-b border-kumo-rule", dim && "opacity-45")}
      style={{ height: ROW_H }}
    >
      <EntityHover entity={ref}>
        <button
          type="button"
          aria-pressed={selected}
          title={reason ? `${cand.name} rejected: ${reason}` : cand.name}
          onClick={() => useFlightStore.getState().toggle(ref)}
          className={cn(
            leftCell,
            "transition-colors duration-(--rh-dur-ui) hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-500",
            selected && "shadow-[inset_2px_0_0_var(--color-accent-500)]",
            (selected || hovered) && "bg-kumo-faint",
          )}
          style={{ width: LEFT, height: ROW_H }}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden
              className={cn(
                "grid size-3.5 shrink-0 place-items-center font-mono text-[9px] font-bold",
                promoted ? "bg-accent-500 text-kumo-inverse" : "bg-kumo-ink text-kumo-inverse",
              )}
            >
              {cand.letter}
            </span>
            <span className="truncate font-semibold">{cand.name}</span>
            <span
              className={cn(
                "ml-auto shrink-0",
                view.family === "danger" && "text-kumo-danger",
                view.family === "ok" && "text-kumo-success",
              )}
            >
              {view.label}
            </span>
          </span>
          <span className={cn("truncate", reason ? "text-kumo-danger" : "text-kumo-subtle")}>
            {reason ?? meta}
          </span>
        </button>
      </EntityHover>
      <div className="relative shrink-0 overflow-hidden" style={{ width: scale.width }}>
        {row.start !== null && (
          <span
            className={cn(
              "absolute truncate font-mono text-[10px] leading-none whitespace-nowrap",
              reason ? "text-kumo-danger" : "text-kumo-subtle",
            )}
            style={{
              left: endX + 6,
              top: ROW_H / 2 - 5,
              maxWidth: Math.max(0, scale.width - endX - 8),
            }}
            title={reason ?? undefined}
          >
            {reason
              ? truncate(reason, 80)
              : promoted
                ? `merged → ${generation(cand.promotedGeneration ?? 0)}`
                : view.label}
          </span>
        )}
      </div>
    </div>
  );
}
CandidateLane.displayName = "CandidateLane";

/**
 * The branch graph: trunk (2px ink), fork branches (1px ink, drawn once when the fork is a newly
 * played fact), ChangeSet connectors into Candidates, Candidate lines, and the winner's merge
 * back into the trunk (accent: the winning path).
 */
function Graph({
  scale,
  rows,
  forks,
  candidates,
  forkIndex,
  candIndex,
  mid,
}: {
  scale: TimeScale;
  rows: number;
  forks: ForkRow[];
  candidates: CandidateRow[];
  forkIndex: Map<string, number>;
  candIndex: (i: number) => number;
  mid: (i: number) => number;
}) {
  const { animated } = useFlight();
  const trunkY = mid(0);
  const merge = (x1: number, y1: number, x2: number, y2: number) => {
    const cx = x1 + Math.max(12, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${cx} ${y1} ${x2 - Math.max(12, (x2 - x1) / 2)} ${y2} ${x2} ${y2}`;
  };
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute z-[5] overflow-visible"
      style={{ left: LEFT, top: AXIS_H, width: scale.width, height: rows * ROW_H }}
    >
      <line
        x1={scale.x(scale.start)}
        y1={trunkY}
        x2={scale.x(scale.cursor)}
        y2={trunkY}
        strokeWidth={2}
        className="stroke-kumo-ink"
      />
      {forks.map((f) => {
        const y = mid(forkIndex.get(f.task.id) ?? 0);
        const xs = scale.x(f.start);
        const xe = Math.max(xs, scale.x(f.end));
        const r = 6;
        return (
          <path
            key={f.task.id}
            d={`M ${xs} ${trunkY} L ${xs} ${y - r} Q ${xs} ${y} ${xs + r} ${y} L ${Math.max(xs + r, xe)} ${y}`}
            pathLength={1}
            fill="none"
            strokeWidth={1}
            className={cn("stroke-kumo-ink", animated.has(`${f.task.id}:fork`) && "rh-fork")}
          />
        );
      })}
      {candidates.map((c, i) => {
        if (c.start === null) return null;
        const y = mid(candIndex(i));
        const xf = scale.x(c.start);
        const xe = Math.max(xf, scale.x(c.end));
        const rejected = c.cand.status === "rejected" || c.cand.status === "stale";
        const promoted = c.promotedAt !== null;
        const newly = animated.has(`${c.cand.id}:fork`);
        const feeders = c.cand.changeSetIds.flatMap((csId) => {
          const f = forks.find((fr) => fr.commits.some((cm) => cm.cs.id === csId));
          if (!f) return [];
          const commit = f.commits.find((cm) => cm.cs.id === csId);
          const fy = mid(forkIndex.get(f.task.id) ?? 0);
          return [{ key: csId, x: scale.x(commit?.t ?? c.start ?? 0), y: fy }];
        });
        const stroke = rejected
          ? "stroke-tone-400"
          : promoted
            ? "stroke-accent-500"
            : "stroke-kumo-ink";
        return (
          <g key={c.cand.id}>
            {feeders.map((fd) => (
              <path
                key={fd.key}
                d={merge(fd.x, fd.y, xf, y)}
                pathLength={1}
                fill="none"
                strokeWidth={1}
                className={cn(stroke, newly && "rh-merge")}
              />
            ))}
            <line x1={xf} y1={y} x2={xe} y2={y} strokeWidth={promoted ? 2 : 1} className={stroke} />
            <rect
              x={xf - 4}
              y={y - 4}
              width={8}
              height={8}
              className={
                rejected ? "fill-tone-400" : promoted ? "fill-accent-500" : "fill-kumo-ink"
              }
            />
            {promoted && c.promotedAt !== null && (
              <path
                d={merge(scale.x(c.promotedAt), y, scale.x(c.promotedAt) + 24, trunkY)}
                pathLength={1}
                fill="none"
                strokeWidth={2}
                className={cn(
                  "stroke-accent-500",
                  animated.has(`${c.cand.id}:promoted`) && "rh-merge",
                )}
              />
            )}
          </g>
        );
      })}
      {candidates.map((c) => {
        if (c.promotedAt === null || c.cand.promotedGeneration === null) return null;
        const text = generation(c.cand.promotedGeneration);
        const w = labelWidth(text) + 2;
        const x = Math.min(scale.x(c.promotedAt) + 24, scale.width - w - 2);
        return (
          <g key={`${c.cand.id}:gen`}>
            <rect x={x} y={trunkY - 7} width={w} height={14} className="fill-accent-500" />
            <text x={x + 4} y={trunkY + 3.5} className="fill-kumo-inverse font-mono text-[10px]">
              {text}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
Graph.displayName = "Graph";

/** Text equivalent of the branch graph. */
function WorkspaceTable({ forks, candidates }: { forks: ForkRow[]; candidates: CandidateRow[] }) {
  const clockOf = useClock();
  return (
    <div className="sr-only">
      <table>
        <caption>Workspace forks and Candidates</caption>
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">Status</th>
            <th scope="col">Commits or ChangeSets</th>
          </tr>
        </thead>
        <tbody>
          {forks.map((f) => (
            <tr key={f.task.id}>
              <td>
                {f.task.key} fork {f.task.fork?.fork ?? "not listed"}
              </td>
              <td>{statusView(f.task.status).label}</td>
              <td>
                {f.commits
                  .map(
                    (c) =>
                      `${c.cs.commit.slice(0, 7)} +${c.cs.insertions} −${c.cs.deletions} at ${clockOf(c.t)}`,
                  )
                  .join("; ") || "no ChangeSet"}
              </td>
            </tr>
          ))}
          {candidates.map((c) => (
            <tr key={c.cand.id}>
              <td>{c.cand.name}</td>
              <td>
                {statusView(c.cand.status).label}
                {c.cand.reason ? `: ${c.cand.reason}` : ""}
                {c.cand.promotedGeneration !== null
                  ? `, promoted to ${generation(c.cand.promotedGeneration)}`
                  : ""}
              </td>
              <td>{c.cand.changeSetIds.join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
WorkspaceTable.displayName = "WorkspaceTable";
