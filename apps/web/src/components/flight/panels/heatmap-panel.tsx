import { cn } from "@cloudflare/kumo";
import { memo, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatNumber } from "../../../lib/format";
import { usePrefersReducedMotion } from "../../../lib/motion";
import { StatusPill } from "../../ui/status-pill";
import { Tag } from "../../ui/tag";
import { AddsDels } from "../../workspace-page/fork-tree";
import { useFlight } from "../flight-context";
import { type FileTouch, type FlightState, relatedRefs, taskOfAgent } from "../flight-model";
import {
  type EntityRef,
  useFlightFilters,
  useFlightStore,
  useIsHighlighted,
  useSelection,
} from "../flight-store";
import { PanelSkeleton } from "../panel-frame";
import type { PanelProps } from "../panel-types";
import { tokenMs } from "./arena/check-view";
import { RefButton } from "./arena/ref-button";
import {
  type Axis,
  animationOf,
  axisOf,
  bucketStart,
  clockOf,
  type FileCell,
  type FileGroup,
  type FileRow,
  type FileSort,
  fileGroups,
  type ResourceCell,
  type ResourceRow,
  resourceRows,
} from "./heatmap/heat-model";

/**
 * Codebase heatmap (DESIGN.md 9.5 heat grid). Two layers over one time axis, from the first
 * recorded fact to the fold instant:
 *
 *   Files      rows = files the Change's Intents expected or its ChangeSets changed, grouped by
 *              area; a cell counts touches in its bucket (outlined = expected, filled = changed).
 *   Resources  rows = semantic resources; a cell counts Claim facts in its bucket, an accent
 *              square marks the bucket where a conflict on the resource was detected.
 *
 * Every cell is a recorded fact (FlightState.files / resources / claims / events). A cell whose
 * ChangeSet fact newly played fills over `--rh-dur-heat`; nothing else moves.
 */

type Layer = "files" | "resources";

const MIN_BUCKETS = 24;
const MAX_BUCKETS = 48;
/** Fill per intensity step (1..5 touches in a bucket): neutral-500 up the ramp to ink (9.5). */
const FILL = ["", "bg-tone-500", "bg-tone-600", "bg-tone-700", "bg-tone-800", "bg-kumo-ink"];
const OUTLINE = [
  "",
  "border-tone-500",
  "border-tone-600",
  "border-tone-700",
  "border-tone-800",
  "border-kumo-ink",
];

const SORTS: Record<Layer, { value: FileSort; label: string }[]> = {
  files: [
    { value: "activity", label: "Activity" },
    { value: "path", label: "Path" },
    { value: "churn", label: "Churn" },
  ],
  resources: [
    { value: "activity", label: "Activity" },
    { value: "path", label: "Name" },
    { value: "churn", label: "Tasks" },
  ],
};

/* --------------------------------------------------------------------------------------------
 * Small parts
 * ------------------------------------------------------------------------------------------ */

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="inline-flex min-w-0 border border-kumo-rule">
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "min-h-6 px-2 text-[12px] whitespace-nowrap transition-colors duration-(--rh-dur-ui) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 pointer-coarse:min-h-11",
            value === o.value ? "bg-kumo-ink text-kumo-inverse" : "hover:bg-kumo-faint",
          )}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}
Segmented.displayName = "Segmented";

/** A path cut from the left so the file name stays visible; the full path is in `title`. */
function LeftTruncated({ text, className }: { text: string; className?: string }) {
  return (
    <span
      dir="rtl"
      title={text}
      className={cn("block min-w-0 truncate text-left font-mono text-[12px]", className)}
    >
      <span dir="ltr">{text}</span>
    </span>
  );
}
LeftTruncated.displayName = "LeftTruncated";

/** Faint empty squares behind the cells (DESIGN.md 9.5 "faint = none"). Static per size. */
const Track = memo(function Track({ count, pitch }: { count: number; pitch: number }) {
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center">
      {Array.from({ length: count }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed bucket positions
          key={i}
          className="shrink-0 bg-kumo-faint"
          style={{ width: pitch - 2, height: pitch - 2, marginRight: 2 }}
        />
      ))}
    </span>
  );
});
Track.displayName = "Track";

/** The square inside a cell. Fills over `--rh-dur-heat` once when its fact newly played. */
function Square({
  pitch,
  className,
  animateKey,
}: {
  pitch: number;
  className: string;
  animateKey: string | null;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = usePrefersReducedMotion();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!animateKey || !el || reduce || typeof el.animate !== "function") return;
    const duration = tokenMs("--rh-dur-heat", 400);
    if (duration <= 0) return;
    const to = getComputedStyle(el).backgroundColor;
    el.animate([{ backgroundColor: "transparent" }, { backgroundColor: to }], {
      duration,
      easing: "ease",
    });
  }, [animateKey, reduce]);
  return (
    <span
      ref={ref}
      aria-hidden
      className={cn("block", className)}
      style={{ width: pitch - 2, height: pitch - 2 }}
    />
  );
}
Square.displayName = "Square";

function CellButton({
  target,
  label,
  index,
  pitch,
  faded,
  children,
}: {
  target: EntityRef;
  label: string;
  index: number;
  pitch: number;
  faded: boolean;
  children: ReactNode;
}) {
  const { selected } = useIsHighlighted(target);
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      title={label}
      onClick={() => useFlightStore.getState().toggle(target)}
      className={cn(
        "absolute top-0 flex h-full items-center justify-start transition-opacity duration-(--rh-dur-ui) focus-visible:z-[1] focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent-500",
        faded && "opacity-25",
      )}
      style={{ left: index * pitch, width: pitch }}
    >
      {children}
    </button>
  );
}
CellButton.displayName = "CellButton";

/* --------------------------------------------------------------------------------------------
 * Selection helpers
 * ------------------------------------------------------------------------------------------ */

/** Tasks whose touches stay lit when the selection narrows to work of specific Tasks. */
function focusTasks(state: FlightState, selection: EntityRef | null): Set<string> | null {
  if (!selection) return null;
  switch (selection.kind) {
    case "task":
      return new Set([selection.id]);
    case "agent": {
      const t = taskOfAgent(state, selection.id);
      return new Set(t ? [t.id] : []);
    }
    case "candidate":
      return new Set(state.candidates[selection.id]?.taskIds ?? []);
    default:
      return null;
  }
}

function touchLit(touch: FileTouch, selection: EntityRef | null, tasks: Set<string> | null) {
  if (selection?.kind === "changeset") return touch.changeSetId === selection.id;
  if (tasks) return tasks.has(touch.taskId);
  return true;
}

/** Selections whose related Tasks light their files and resources too. */
const BY_TASK = new Set(["candidate", "resource", "conflict", "decision", "dependency"]);

/* --------------------------------------------------------------------------------------------
 * Rows
 * ------------------------------------------------------------------------------------------ */

function FileRowView({
  row,
  pitch,
  count,
  labelWidth,
  dim,
  cellLit,
}: {
  row: FileRow;
  pitch: number;
  count: number;
  labelWidth: number;
  dim: boolean;
  cellLit: (cell: FileCell) => boolean;
}) {
  const { file } = row;
  const label = [
    file.path,
    file.contended ? "contended: changed by more than one Task" : null,
    `${formatNumber(row.touches.length)} touches by ${row.taskKeys.join(", ")}`,
    `+${formatNumber(file.adds)} −${formatNumber(file.dels)}`,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div
      className={cn(
        "flex h-6 border-b border-kumo-rule transition-opacity duration-(--rh-dur-ui) pointer-coarse:h-11",
        dim && "opacity-45",
      )}
    >
      <div className="sticky left-0 z-[1] shrink-0 bg-kumo-elevated" style={{ width: labelWidth }}>
        {file.contended && (
          <span aria-hidden className="absolute inset-y-0 left-0 z-[1] w-0.5 bg-accent-500" />
        )}
        <RefButton
          entity={{ kind: "file", id: file.path }}
          label={label}
          className="flex h-full w-full min-w-0 items-center gap-2 pr-2 pl-3"
        >
          <LeftTruncated text={file.path} className="flex-1" />
          <span className="font-mono text-[11px]">
            <AddsDels adds={file.adds} dels={file.dels} />
          </span>
        </RefButton>
      </div>
      <div className="relative ml-2 shrink-0" style={{ width: count * pitch }}>
        <Track count={count} pitch={pitch} />
        {row.cells.map((cell) => (
          <CellButton
            key={cell.index}
            target={cell.target}
            label={cell.label}
            index={cell.index}
            pitch={pitch}
            faded={!cellLit(cell)}
          >
            <Square
              pitch={pitch}
              animateKey={cell.animateKey}
              className={
                cell.changed > 0 ? (FILL[cell.level] ?? "") : cn("border-2", OUTLINE[cell.level])
              }
            />
          </CellButton>
        ))}
      </div>
    </div>
  );
}
FileRowView.displayName = "FileRowView";

function ResourceRowView({
  row,
  state,
  pitch,
  count,
  labelWidth,
  dim,
  cellLit,
}: {
  row: ResourceRow;
  state: FlightState;
  pitch: number;
  count: number;
  labelWidth: number;
  dim: boolean;
  cellLit: (cell: ResourceCell) => boolean;
}) {
  const r = row.resource;
  const holders = row.holders.map(
    (h) => (h.taskId ? state.tasks[h.taskId]?.key : null) ?? h.agentId,
  );
  const label = [
    r.resource,
    r.protectedResource ? "protected" : null,
    r.conflictIds.length > 0 ? `${formatNumber(r.conflictIds.length)} conflict` : null,
    row.taskKeys.length > 0 ? `Tasks ${row.taskKeys.join(", ")}` : "no Tasks",
    holders.length > 0 ? `held by ${holders.join(", ")}` : "no active Claim",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div
      className={cn(
        "flex min-h-6 border-b border-kumo-rule transition-opacity duration-(--rh-dur-ui)",
        dim && "opacity-45",
      )}
    >
      <div className="sticky left-0 z-[1] shrink-0 bg-kumo-elevated" style={{ width: labelWidth }}>
        {r.conflictIds.length > 0 && (
          <span aria-hidden className="absolute inset-y-0 left-0 z-[1] w-0.5 bg-accent-500" />
        )}
        <RefButton
          entity={{ kind: "resource", id: r.resource }}
          label={label}
          className="grid h-full w-full min-w-0 content-center gap-0.5 py-1 pr-2 pl-3"
        >
          <LeftTruncated text={r.resource} />
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-kumo-subtle">
            {r.protectedResource && (
              <Tag variant="outline" className="px-1.5 py-0">
                protected
              </Tag>
            )}
            <span className="truncate font-mono">
              {row.taskKeys.length > 0 ? row.taskKeys.join(" ") : "no Tasks"}
            </span>
            {holders.length > 0 && (
              <span className="shrink-0 truncate text-kumo-default">held {holders.join(", ")}</span>
            )}
          </span>
        </RefButton>
      </div>
      <div className="relative ml-2 shrink-0" style={{ width: count * pitch }}>
        <Track count={count} pitch={pitch} />
        {row.cells.map((cell) => (
          <CellButton
            key={cell.index}
            target={cell.target}
            label={cell.label}
            index={cell.index}
            pitch={pitch}
            faded={!cellLit(cell)}
          >
            <Square
              pitch={pitch}
              animateKey={null}
              className={cell.conflictIds.length > 0 ? "bg-accent-500" : (FILL[cell.level] ?? "")}
            />
          </CellButton>
        ))}
      </div>
    </div>
  );
}
ResourceRowView.displayName = "ResourceRowView";

function GroupHeader({ group, labelWidth }: { group: FileGroup; labelWidth: number }) {
  return (
    <div className="sticky top-[22px] z-[2] flex h-6 items-center border-b border-kumo-divider bg-kumo-elevated">
      <div
        className="sticky left-0 flex min-w-0 items-baseline justify-between gap-2 bg-kumo-elevated pr-2 pl-3"
        style={{ width: labelWidth }}
      >
        <span className="type-label truncate">{group.area}</span>
        <span className="shrink-0 font-mono text-[11px] text-kumo-subtle tabular-nums">
          {formatNumber(group.rows.length)} · <AddsDels adds={group.adds} dels={group.dels} />
        </span>
      </div>
    </div>
  );
}
GroupHeader.displayName = "GroupHeader";

function AxisRow({
  axis,
  pitch,
  labelWidth,
  title,
}: {
  axis: Axis;
  pitch: number;
  labelWidth: number;
  title: string;
}) {
  const width = axis.count * pitch;
  const step = Math.max(1, Math.ceil(64 / pitch));
  const ticks: number[] = [];
  for (let i = 0; i < axis.count; i += step) if (i * pitch + 112 < width) ticks.push(i);
  return (
    <div
      aria-hidden
      className="sticky top-0 z-[3] flex h-[22px] items-end border-b border-kumo-divider bg-kumo-elevated"
    >
      <div
        className="sticky left-0 z-[1] shrink-0 bg-kumo-elevated pb-1 pl-3 type-label text-kumo-subtle"
        style={{ width: labelWidth }}
      >
        {title}
      </div>
      <div className="relative ml-2 h-full shrink-0" style={{ width }}>
        {ticks.map((i) => (
          <span
            key={i}
            className="absolute bottom-1 border-l border-kumo-rule pl-1 font-mono text-[10px] leading-none whitespace-nowrap text-kumo-subtle"
            style={{ left: i * pitch }}
          >
            {clockOf(bucketStart(axis, i))}
          </span>
        ))}
        <span className="absolute right-0 bottom-1 font-mono text-[10px] leading-none whitespace-nowrap text-kumo-subtle">
          {clockOf(axis.end)}
        </span>
      </div>
    </div>
  );
}
AxisRow.displayName = "AxisRow";

function Legend({ layer }: { layer: Layer }) {
  const swatch = "inline-block size-2.5 shrink-0";
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-kumo-rule px-3 py-1 text-[11px] text-kumo-subtle">
      {layer === "files" ? (
        <>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className={cn(swatch, "border-2 border-tone-500")} /> expected
            (Intent)
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className={cn(swatch, "bg-tone-500")} /> changed (ChangeSet)
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="inline-block h-2.5 w-0.5 bg-accent-500" /> contended
          </span>
        </>
      ) : (
        <>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className={cn(swatch, "bg-tone-500")} /> Claim facts
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className={cn(swatch, "bg-accent-500")} /> conflict detected
          </span>
        </>
      )}
      <span className="inline-flex items-center gap-1">
        <span aria-hidden className="inline-flex gap-px">
          {FILL.slice(1).map((c) => (
            <span key={c} className={cn("inline-block size-2", c)} />
          ))}
        </span>
        1 → 5+ per bucket
      </span>
    </div>
  );
}
Legend.displayName = "Legend";

/* --------------------------------------------------------------------------------------------
 * Panel
 * ------------------------------------------------------------------------------------------ */

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

export function HeatmapPanel({ focused }: PanelProps) {
  const { state, model, ready, animated } = useFlight();
  const selection = useSelection();
  const filters = useFlightFilters();
  const [layer, setLayer] = useState<Layer>("files");
  const [sort, setSort] = useState<FileSort>("activity");
  const { ref, width } = useWidth();

  const labelWidth = focused ? 320 : 216;
  // Focused, the squares grow (up to 22px) so 48 buckets fill the width.
  const pitch = focused
    ? Math.min(22, Math.max(14, Math.floor((width - labelWidth - 16) / MAX_BUCKETS)))
    : 12;
  const count = Math.min(
    MAX_BUCKETS,
    Math.max(MIN_BUCKETS, Math.floor((width - labelWidth - 16) / pitch)),
  );
  const axis = useMemo(
    () => axisOf(model.bounds.start, state.at, count),
    [model.bounds.start, state.at, count],
  );
  const workspaceLoaded = model.input.workspace !== null;
  const animate = useMemo(() => animationOf(state, animated), [state, animated]);
  const groups = useMemo(
    () => fileGroups(state, axis, filters, sort, workspaceLoaded, animate),
    [state, axis, filters, sort, workspaceLoaded, animate],
  );
  const resources = useMemo(
    () => resourceRows(state, axis, filters, sort),
    [state, axis, filters, sort],
  );
  const related = useMemo(() => relatedRefs(state, selection), [state, selection]);
  const tasksInFocus = useMemo(() => focusTasks(state, selection), [state, selection]);

  if (!ready) return <PanelSkeleton />;

  const byTask = selection !== null && BY_TASK.has(selection.kind);
  const taskRelated = (ids: string[]) => byTask && ids.some((id) => related.has(`task:${id}`));
  const fileDim = (row: FileRow) =>
    selection !== null && !related.has(`file:${row.file.path}`) && !taskRelated(row.file.taskIds);
  const resourceDim = (row: ResourceRow) =>
    selection !== null &&
    !related.has(`resource:${row.resource.resource}`) &&
    !taskRelated(row.resource.taskIds);
  const fileCellLit = (cell: FileCell) =>
    cell.touches.some((t) => touchLit(t, selection, tasksInFocus));
  const resourceCellLit = (cell: ResourceCell) =>
    !tasksInFocus ||
    cell.conflictIds.some((id) => related.has(`conflict:${id}`)) ||
    cell.claims.some((c) => c.laneId !== null && tasksInFocus.has(c.laneId));

  const rows = groups.reduce((n, g) => n + g.rows.length, 0);
  const minWidth = labelWidth + 8 + count * pitch + 8;
  const fileCount = state.files.filter((f) =>
    f.touches.some((t) => workspaceLoaded || t.kind === "expected"),
  ).length;

  const summary =
    layer === "files"
      ? (() => {
          const all = groups.flatMap((g) => g.rows);
          const tasks = new Set(all.flatMap((r) => r.touches.map((t) => t.taskId)));
          const contended = all.filter((r) => r.file.contended).map((r) => r.file.path);
          return `${formatNumber(all.length)} files touched by ${formatNumber(tasks.size)} Tasks; ${formatNumber(contended.length)} contended${contended.length > 0 ? `: ${contended.join(", ")}` : ""}.`;
        })()
      : (() => {
          const conflicted = resources.filter((r) => r.resource.conflictIds.length > 0);
          const guarded = resources.filter((r) => r.resource.protectedResource);
          return `${formatNumber(resources.length)} semantic resources; ${formatNumber(conflicted.length)} with a conflict${conflicted.length > 0 ? `: ${conflicted.map((r) => r.resource.resource).join(", ")}` : ""}; protected: ${guarded.length > 0 ? guarded.map((r) => r.resource.resource).join(", ") : "none"}.`;
        })();

  let body: ReactNode;
  if (layer === "files") {
    if (fileCount === 0) {
      body = <Empty>No files declared or changed yet.</Empty>;
    } else if (rows === 0) {
      body = <Empty>No file matches the filters.</Empty>;
    } else {
      body = (
        <div style={{ minWidth }}>
          <AxisRow axis={axis} pitch={pitch} labelWidth={labelWidth} title="Path" />
          {groups.map((g) => (
            <div key={g.area}>
              <GroupHeader group={g} labelWidth={labelWidth} />
              {g.rows.map((row) => (
                <FileRowView
                  key={row.file.path}
                  row={row}
                  pitch={pitch}
                  count={count}
                  labelWidth={labelWidth}
                  dim={fileDim(row)}
                  cellLit={fileCellLit}
                />
              ))}
            </div>
          ))}
        </div>
      );
    }
  } else if (state.resources.length === 0) {
    body = <Empty>No semantic resources declared yet.</Empty>;
  } else if (resources.length === 0) {
    body = <Empty>No semantic resource matches the filters.</Empty>;
  } else {
    body = (
      <div style={{ minWidth }}>
        <AxisRow axis={axis} pitch={pitch} labelWidth={labelWidth} title="Resource" />
        {resources.map((row) => (
          <ResourceRowView
            key={row.resource.resource}
            row={row}
            state={state}
            pitch={pitch}
            count={count}
            labelWidth={labelWidth}
            dim={resourceDim(row)}
            cellLit={resourceCellLit}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-kumo-rule px-3 py-1.5">
        <Segmented
          label="Heatmap layer"
          options={[
            { value: "files", label: "Files" },
            { value: "resources", label: "Resources" },
          ]}
          value={layer}
          onChange={setLayer}
        />
        <Segmented label="Sort rows" options={SORTS[layer]} value={sort} onChange={setSort} />
        {layer === "files" && !workspaceLoaded && (
          <StatusPill status="stale" family="attention" label="Workspace view not loaded" />
        )}
        <span className="ml-auto font-mono text-[11px] text-kumo-subtle tabular-nums">
          {formatNumber(count)} × {formatDurationShort(axis.span)}
        </span>
      </div>
      <p className="sr-only">{summary}</p>
      <div ref={ref} className="min-h-0 flex-1 overflow-auto">
        {body}
      </div>
      <Legend layer={layer} />
    </div>
  );
}
HeatmapPanel.displayName = "HeatmapPanel";

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-3 text-[13px] text-kumo-subtle">{children}</p>;
}
Empty.displayName = "Empty";

/** Bucket width for the axis caption: `6s`, `2m`, `1 h`. */
function formatDurationShort(ms: number) {
  const s = ms / 1000;
  if (s < 60) return `${Math.max(1, Math.round(s))}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)} h`;
}
