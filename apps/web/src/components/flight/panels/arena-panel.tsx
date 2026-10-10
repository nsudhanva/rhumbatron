import { cn } from "@cloudflare/kumo";
import { type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import { formatClock, formatNumber, generation } from "../../../lib/format";
import { usePrefersReducedMotion } from "../../../lib/motion";
import { criterion, formatP95, p95Budget } from "../../candidate/model";
import { ThresholdMeter } from "../../ui/meter";
import { FAMILY_FILL, FAMILY_TEXT, StatusPill } from "../../ui/status-pill";
import { useFlight } from "../flight-context";
import {
  type CandidateState,
  type CheckState,
  type ConflictState,
  type FlightModel,
  type FlightState,
  refKey,
  relatedRefs,
} from "../flight-model";
import { useFlightFilters, useIsHighlighted, useSelection } from "../flight-store";
import type { PanelProps } from "../panel-types";
import {
  type CandidateSummary,
  checkEventIds,
  checkView,
  composedChangeSets,
  formatCost,
  isLoser,
  iso,
  isSettled,
  isWinner,
  metricBits,
  p95OfCheck,
  standing,
  summarize,
  tokenMs,
} from "./arena/check-view";
import { RefButton } from "./arena/ref-button";

/**
 * Candidate arena (DESIGN.md 9.12 comparison matrix, 11.1 "converging"). Candidates run across,
 * criteria down: summary rows, then one row per check (union over Candidates), then the conflicts
 * whose two sides became these Candidates. Every cell is a recorded fact at the fold instant:
 * status word plus coverage, never model confidence (AGENTS.md 34.4.1, 38.4). The winner carries
 * the accent bar; a rejected column greys out with its reason in words. A check fact that newly
 * played fills its square over `--rh-dur-heat`; nothing else moves.
 */

const LABEL_COL = 176;
const CANDIDATE_COL = 232;

type Column = {
  candidate: CandidateState;
  summary: CandidateSummary;
  keys: { id: string; taskKey: string; commit: string | null }[];
};

type Row = { checkId: string; kind: string; title: string; detail: string; required: string };

function requiredWord(columns: Column[], checkId: string) {
  const planned = columns
    .map((c) => ({ c, check: c.candidate.checks.find((x) => x.checkId === checkId) }))
    .filter((x) => x.check);
  const req = planned.filter((x) => x.check?.required);
  if (req.length === 0) return "optional";
  if (req.length === planned.length) return "required";
  return `required in ${req.map((x) => x.c.candidate.letter).join(", ")}`;
}

function matchesQuery(state: FlightState, model: FlightModel, c: CandidateState, q: string) {
  if (!q) return true;
  const hay = [
    c.id,
    c.name,
    c.letter,
    c.status,
    ...c.checks.map((x) => x.checkId),
    ...c.taskIds.flatMap((id) => [state.tasks[id]?.key ?? "", state.tasks[id]?.title ?? ""]),
    ...composedChangeSets(state, model, c).flatMap((cs) => [cs.id, ...(cs.record?.files ?? [])]),
    ...state.conflicts.filter((x) => x.candidateIds.includes(c.id)).map((x) => x.resource),
  ];
  return hay.some((s) => s.toLowerCase().includes(q));
}

export function ArenaPanel({ focused }: PanelProps) {
  const { state, model, ready, animated } = useFlight();
  const selection = useSelection();
  const { query } = useFlightFilters();
  const q = query.trim().toLowerCase();

  const allColumns = useMemo<Column[]>(
    () =>
      state.candidateOrder
        .map((id) => state.candidates[id])
        .filter((c): c is CandidateState => !!c)
        .map((candidate) => ({
          candidate,
          summary: summarize(state, model, candidate),
          keys: composedChangeSets(state, model, candidate).map((cs) => ({
            id: cs.id,
            taskKey: cs.taskKey,
            commit: cs.record?.commit ?? null,
          })),
        })),
    [state, model],
  );
  const columns = useMemo(
    () => allColumns.filter((c) => matchesQuery(state, model, c.candidate, q)),
    [allColumns, state, model, q],
  );
  const rows = useMemo<Row[]>(() => {
    const seen = new Map<string, Row>();
    for (const col of columns) {
      const budget = p95Budget(col.candidate.detail);
      for (const check of col.candidate.checks) {
        if (seen.has(check.checkId)) continue;
        const c = criterion(
          {
            checkId: check.checkId,
            kind: check.kind,
            check: col.candidate.detail.plan?.checks.find((p) => p.checkId === check.checkId),
          },
          budget,
        );
        seen.set(check.checkId, {
          checkId: check.checkId,
          kind: check.kind,
          title: c.title,
          detail: c.detail,
          required: requiredWord(columns, check.checkId),
        });
      }
    }
    const all = [...seen.values()];
    const narrowed = q ? all.filter((r) => r.checkId.toLowerCase().includes(q)) : [];
    return narrowed.length > 0 ? narrowed : all;
  }, [columns, q]);
  const related = useMemo(() => relatedRefs(state, selection), [state, selection]);
  const eventIds = useMemo(() => checkEventIds(state), [state]);
  const conflicts = useMemo(
    () =>
      state.conflicts.filter((c) =>
        c.candidateIds.some((id) => id && columns.some((col) => col.candidate.id === id)),
      ),
    [state.conflicts, columns],
  );

  if (!ready) return <ArenaSkeleton focused={focused} />;

  if (allColumns.length === 0) {
    const proposed = Object.values(state.tasks).reduce((n, t) => n + t.changeSets.length, 0);
    return (
      <div className="px-3 py-3 text-[13px]">
        <p className="font-semibold">No Candidates composed yet.</p>
        <p className="text-kumo-subtle">
          {formatNumber(proposed)} {proposed === 1 ? "ChangeSet" : "ChangeSets"} proposed so far. A
          Candidate appears when verified ChangeSets are composed into one possible future.
        </p>
      </div>
    );
  }
  if (columns.length === 0) {
    return (
      <p className="px-3 py-3 text-[13px] text-kumo-subtle">
        No Candidate matches “{query.trim()}”.
      </p>
    );
  }

  const dimmed = (id: string) => selection !== null && !related.has(`candidate:${id}`);
  const minWidth = LABEL_COL + columns.length * CANDIDATE_COL;
  const summaryText = columns
    .map(
      (c) =>
        `${c.candidate.name}: ${c.candidate.status}, ${c.summary.required.met} of ${c.summary.required.total} required checks met`,
    )
    .join(". ");

  return (
    <div className="h-full min-h-0 overflow-auto" data-focused={focused || undefined}>
      <table
        className="w-full border-collapse text-left text-[12px]"
        style={{ minWidth, tableLayout: "fixed" }}
      >
        <caption className="sr-only">
          Candidates compared by executable Evidence. {summaryText}.
        </caption>
        <colgroup>
          <col style={{ width: LABEL_COL }} />
          {columns.map((c) => (
            <col key={c.candidate.id} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-[2] bg-kumo-base">
          <tr>
            <th
              scope="col"
              className="sticky left-0 z-[3] border-b-2 border-kumo-divider bg-kumo-base px-2 py-1.5 align-bottom font-normal"
            >
              <span className="type-label text-kumo-subtle">Criterion</span>
            </th>
            {columns.map((col) => (
              <ColumnHeader
                key={col.candidate.id}
                column={col}
                state={state}
                focused={focused}
                dim={dimmed(col.candidate.id)}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          <SummaryRow label="Requirements met" detail="Required checks with a supported pass">
            {columns.map((col) => (
              <SummaryCell key={col.candidate.id} column={col} dim={dimmed(col.candidate.id)}>
                <span className="flex items-center gap-2">
                  <span className="font-mono tabular-nums">
                    {col.summary.required.met} / {col.summary.required.total}
                  </span>
                  <RatioSquares met={col.summary.required.met} total={col.summary.required.total} />
                </span>
              </SummaryCell>
            ))}
          </SummaryRow>
          <SummaryRow label="Failed checks" detail="Checks that failed or errored">
            {columns.map((col) => (
              <SummaryCell key={col.candidate.id} column={col} dim={dimmed(col.candidate.id)}>
                {col.summary.failed.length === 0 ? (
                  <span className="text-kumo-subtle">none</span>
                ) : (
                  <span className="font-mono text-kumo-danger">
                    {col.summary.failed.length} · {col.summary.failed.join(", ")}
                  </span>
                )}
              </SummaryCell>
            ))}
          </SummaryRow>
          <SummaryRow label="Evidence" detail="Records stored at this instant">
            {columns.map((col) => (
              <SummaryCell key={col.candidate.id} column={col} dim={dimmed(col.candidate.id)}>
                <span className="font-mono tabular-nums">{formatNumber(col.summary.evidence)}</span>
              </SummaryCell>
            ))}
          </SummaryRow>
          <SummaryRow label="Files changed" detail="Distinct paths over composed ChangeSets">
            {columns.map((col) => (
              <SummaryCell key={col.candidate.id} column={col} dim={dimmed(col.candidate.id)}>
                {col.summary.files.recorded ? (
                  <span className="font-mono tabular-nums">
                    {formatNumber(col.summary.files.count)} ·{" "}
                    <span className="text-kumo-success">
                      +{formatNumber(col.summary.files.adds)}
                    </span>{" "}
                    <span className="text-kumo-danger">
                      −{formatNumber(col.summary.files.dels)}
                    </span>
                  </span>
                ) : (
                  <span className="text-kumo-subtle">not recorded</span>
                )}
              </SummaryCell>
            ))}
          </SummaryRow>
          <SummaryRow label="Model cost" detail="Composing Tasks' recorded runs">
            {columns.map((col) => (
              <SummaryCell key={col.candidate.id} column={col} dim={dimmed(col.candidate.id)}>
                <span
                  className={cn(
                    "font-mono tabular-nums",
                    col.summary.costUsd === null && "text-kumo-subtle",
                  )}
                >
                  {formatCost(col.summary.costUsd)}
                </span>
              </SummaryCell>
            ))}
          </SummaryRow>
          <SummaryRow label="ChangeSets" detail="Composed into this Candidate" last>
            {columns.map((col) => (
              <SummaryCell key={col.candidate.id} column={col} dim={dimmed(col.candidate.id)} last>
                <span className="font-mono tabular-nums">
                  {formatNumber(col.summary.changeSets)}
                </span>
              </SummaryCell>
            ))}
          </SummaryRow>

          {rows.map((row) => (
            <tr key={row.checkId}>
              <th
                scope="row"
                className="sticky left-0 z-[1] border-b border-kumo-rule bg-kumo-base px-2 py-1 align-top font-normal"
              >
                <span className="block truncate text-[12px] font-semibold" title={row.detail}>
                  {row.title}
                </span>
                <span className="block truncate font-mono text-[10px] text-kumo-subtle">
                  {row.checkId} · {row.required}
                </span>
              </th>
              {columns.map((col) => {
                const check = col.candidate.checks.find((c) => c.checkId === row.checkId);
                const key = `${col.candidate.id}:${row.checkId}`;
                const eventId = eventIds.get(key) ?? null;
                return (
                  <CheckCell
                    key={col.candidate.id}
                    state={state}
                    candidate={col.candidate}
                    check={check}
                    dim={
                      selection !== null && !related.has(`check:${key}`) && dimmed(col.candidate.id)
                    }
                    animateEvent={eventId && animated.has(eventId) ? eventId : null}
                  />
                );
              })}
            </tr>
          ))}

          {conflicts.map((conflict) => (
            <ConflictRow
              key={conflict.id}
              conflict={conflict}
              columns={columns}
              dim={
                selection !== null && !related.has(refKey({ kind: "conflict", id: conflict.id }))
              }
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
ArenaPanel.displayName = "ArenaPanel";

/* --------------------------------------------------------------------------------------------
 * Header
 * ------------------------------------------------------------------------------------------ */

function columnClass(candidate: CandidateState, dim: boolean) {
  return cn(
    "rh-greyout border-l border-kumo-rule transition-opacity duration-(--rh-dur-ui)",
    isWinner(candidate) && "shadow-[inset_2px_0_0_var(--color-accent-500)]",
    dim && "opacity-45",
  );
}

function ColumnHeader({
  column,
  state,
  focused,
  dim,
}: {
  column: Column;
  state: FlightState;
  focused: boolean;
  dim: boolean;
}) {
  const { candidate } = column;
  const ref = { kind: "candidate" as const, id: candidate.id };
  const { selected } = useIsHighlighted(ref);
  const line = standing(state, candidate);
  const approval = candidate.approval;
  return (
    <th
      scope="col"
      data-state={isLoser(candidate) ? "rejected" : undefined}
      className={cn(
        columnClass(candidate, dim),
        "border-b-2 border-b-kumo-divider px-2 py-1.5 align-top font-normal",
        selected && "bg-kumo-faint",
      )}
    >
      <div className="grid min-w-0 gap-1">
        <RefButton
          entity={ref}
          title={`${candidate.name}, ${candidate.status}`}
          className="-mx-1 px-1"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className={cn(
                "grid size-5 shrink-0 place-items-center text-[11px] font-extrabold",
                isWinner(candidate)
                  ? "bg-accent-500 text-kumo-inverse"
                  : "bg-kumo-ink text-kumo-inverse",
              )}
            >
              {candidate.letter}
            </span>
            <span className="min-w-0 truncate text-[13px] font-semibold">{candidate.name}</span>
            <StatusPill status={candidate.status} className="ml-auto" />
          </span>
        </RefButton>
        {line && (
          <p
            className={cn(
              "text-[11px] leading-snug",
              focused ? "line-clamp-3" : "line-clamp-2",
              candidate.status === "rejected"
                ? "text-kumo-danger"
                : candidate.status === "stale"
                  ? "text-kumo-warning"
                  : isWinner(candidate)
                    ? "text-kumo-default"
                    : "text-kumo-subtle",
            )}
            title={line}
          >
            {line}
          </p>
        )}
        <p className="truncate font-mono text-[10px] text-kumo-subtle tabular-nums">
          {candidate.promotedGeneration !== null
            ? `${generation(candidate.detail.baseGeneration)} → ${generation(candidate.promotedGeneration)}`
            : `base ${generation(candidate.detail.baseGeneration)}`}
          {" · forked "}
          {formatClock(iso(candidate.forkedAt))}
          {" · "}
          {approval
            ? `${approval.decision === "granted" ? "approved" : "rejected"} ${formatClock(approval.createdAt)}`
            : candidate.detail.approvalRequired
              ? "approval required"
              : "no approval needed"}
        </p>
        {column.keys.length > 0 && (
          <ul aria-label={`${candidate.name} ChangeSets`} className="flex flex-wrap gap-0.5">
            {column.keys.map((k) => (
              <li key={k.id}>
                <RefButton
                  entity={{ kind: "changeset", id: k.id }}
                  title={`ChangeSet ${k.id} from ${k.taskKey}${k.commit ? ` at ${k.commit.slice(0, 8)}` : ""}`}
                  context={`ChangeSet ${k.id}${k.commit ? ` at ${k.commit.slice(0, 8)}` : ""}`}
                  className="bg-tone-100 px-1 font-mono text-[10px] tabular-nums"
                >
                  {k.taskKey}
                </RefButton>
              </li>
            ))}
          </ul>
        )}
      </div>
    </th>
  );
}
ColumnHeader.displayName = "ColumnHeader";

/* --------------------------------------------------------------------------------------------
 * Summary rows
 * ------------------------------------------------------------------------------------------ */

function SummaryRow({
  label,
  detail,
  last,
  children,
}: {
  label: string;
  detail: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <tr>
      <th
        scope="row"
        title={detail}
        className={cn(
          "sticky left-0 z-[1] border-b border-kumo-rule bg-kumo-base px-2 py-1 align-middle text-[12px] font-normal text-kumo-subtle",
          last && "border-b-2 border-b-kumo-divider",
        )}
      >
        {label}
      </th>
      {children}
    </tr>
  );
}
SummaryRow.displayName = "SummaryRow";

function SummaryCell({
  column,
  dim,
  last,
  children,
}: {
  column: Column;
  dim: boolean;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <td
      data-state={isLoser(column.candidate) ? "rejected" : undefined}
      className={cn(
        columnClass(column.candidate, dim),
        "border-b border-b-kumo-rule px-2 py-1 align-middle",
        last && "border-b-2 border-b-kumo-divider",
      )}
    >
      {children}
    </td>
  );
}
SummaryCell.displayName = "SummaryCell";

/** Ratio squares (DESIGN.md 9.1): ink = met, accent = unmet, N ≤ 10. */
function RatioSquares({ met, total }: { met: number; total: number }) {
  if (total === 0 || total > 10) return null;
  return (
    <span aria-hidden className="flex gap-0.5">
      {Array.from({ length: total }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: squares are positional
        <span key={i} className={cn("size-2", i < met ? "bg-kumo-ink" : "bg-accent-500")} />
      ))}
    </span>
  );
}
RatioSquares.displayName = "RatioSquares";

/* --------------------------------------------------------------------------------------------
 * Check cells
 * ------------------------------------------------------------------------------------------ */

function CheckCell({
  state,
  candidate,
  check,
  dim,
  animateEvent,
}: {
  state: FlightState;
  candidate: CandidateState;
  check: CheckState | undefined;
  dim: boolean;
  animateEvent: string | null;
}) {
  const cellClass = cn(columnClass(candidate, dim), "border-b border-b-kumo-rule p-0 align-top");
  if (!check) {
    return (
      <td data-state={isLoser(candidate) ? "rejected" : undefined} className={cellClass}>
        <span className="block px-2 py-1.5 text-[11px] text-kumo-subtle">Not planned</span>
      </td>
    );
  }
  const settled = isSettled(candidate);
  const view = checkView(check, settled);
  const bits = metricBits(state, candidate, check);
  const p95 = p95OfCheck(state, candidate, check);
  const budget = p95Budget(candidate.detail);
  const id = `${candidate.id}:${check.checkId}`;
  return (
    <td data-state={isLoser(candidate) ? "rejected" : undefined} className={cellClass}>
      <RefButton
        entity={{ kind: "check", id }}
        title={`${candidate.name} ${check.checkId}: ${view.word}, ${view.coverage}${check.required ? ", required" : ""}`}
        context={`${candidate.name} ${check.checkId}${check.required ? ", required" : ""}`}
        className="grid w-full gap-1 px-2 py-1"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Segment family={view.family} hollow={view.hollow} animateEvent={animateEvent} />
          <span className={cn("shrink-0 font-semibold", FAMILY_TEXT[view.family])}>
            {view.word}
          </span>
          <span className="min-w-0 truncate text-[11px] text-kumo-subtle">{view.coverage}</span>
          {check.required && (
            <span className="ml-auto shrink-0 font-mono text-[10px] text-kumo-subtle">req</span>
          )}
        </span>
        {bits.length > 0 && (
          <span className="truncate font-mono text-[11px] text-kumo-subtle tabular-nums">
            {bits.join(" · ")}
          </span>
        )}
      </RefButton>
      {p95 !== null && budget !== null && (
        <div className="px-2 pb-1.5">
          <ThresholdMeter
            label="p95"
            valueText={`${formatP95(p95)} / ${formatP95(budget)}`}
            value={p95}
            max={Math.max(budget * 1.5, p95 * 1.1)}
            threshold={budget}
            size="inline"
            format={(n) => formatP95(n)}
          />
        </div>
      )}
    </td>
  );
}
CheckCell.displayName = "CheckCell";

/** A square status segment. Fills over `--rh-dur-heat` only when its check fact newly played. */
function Segment({
  family,
  hollow,
  animateEvent,
}: {
  family: keyof typeof FAMILY_FILL;
  hollow: boolean;
  animateEvent: string | null;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = usePrefersReducedMotion();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!animateEvent || !el || reduce || typeof el.animate !== "function") return;
    const duration = tokenMs("--rh-dur-heat", 400);
    if (duration <= 0) return;
    const to = getComputedStyle(el).backgroundColor;
    el.animate([{ backgroundColor: "transparent" }, { backgroundColor: to }], {
      duration,
      easing: "ease",
    });
  }, [animateEvent, reduce]);
  return (
    <span
      ref={ref}
      aria-hidden
      className={cn(
        "size-3 shrink-0",
        hollow ? "border-2 border-kumo-warning" : FAMILY_FILL[family],
      )}
    />
  );
}
Segment.displayName = "Segment";

/* --------------------------------------------------------------------------------------------
 * Conflict strip
 * ------------------------------------------------------------------------------------------ */

function ConflictRow({
  conflict,
  columns,
  dim,
}: {
  conflict: ConflictState;
  columns: Column[];
  dim: boolean;
}) {
  const [a, b] = conflict.statements;
  const sideOf = (candidateId: string) =>
    conflict.candidateIds[0] === candidateId
      ? 0
      : conflict.candidateIds[1] === candidateId
        ? 1
        : -1;
  return (
    <tr className={cn("transition-opacity duration-(--rh-dur-ui)", dim && "opacity-45")}>
      <th
        scope="row"
        className="sticky left-0 z-[1] border-b border-kumo-rule bg-kumo-base p-0 align-top font-normal shadow-[inset_2px_0_0_var(--color-accent-500)]"
      >
        <RefButton
          entity={{ kind: "conflict", id: conflict.id }}
          title={`Conflict on ${conflict.resource}: ${a} vs ${b}`}
          context={`${a} vs ${b}`}
          className="grid w-full gap-0.5 py-1 pr-2 pl-3"
        >
          <span className="text-[12px] font-semibold text-kumo-accent">Conflict</span>
          <span
            className="truncate font-mono text-[10px] text-kumo-subtle"
            title={conflict.resource}
          >
            {conflict.resource}
          </span>
          <span className="text-[10px] text-kumo-subtle">
            {conflict.open ? "open" : "resolved"} · {conflict.state.replace(/_/g, " ")}
          </span>
        </RefButton>
      </th>
      {columns.map((col) => {
        const side = sideOf(col.candidate.id);
        return (
          <td
            key={col.candidate.id}
            data-state={isLoser(col.candidate) ? "rejected" : undefined}
            className={cn(
              columnClass(col.candidate, false),
              "border-b border-b-kumo-rule px-2 py-1 align-top text-[12px]",
            )}
          >
            {side === -1 ? (
              <span className="text-kumo-subtle">Not a side</span>
            ) : (
              <span className="grid gap-0.5">
                <span className="font-mono text-[10px] text-kumo-subtle">
                  {side === 0 ? "Side A · challenger" : "Side B"}
                </span>
                <span className="line-clamp-3">{side === 0 ? a : b}</span>
              </span>
            )}
          </td>
        );
      })}
    </tr>
  );
}
ConflictRow.displayName = "ConflictRow";

/* --------------------------------------------------------------------------------------------
 * Skeleton
 * ------------------------------------------------------------------------------------------ */

function ArenaSkeleton({ focused }: { focused: boolean }) {
  const rows = focused ? 12 : 8;
  return (
    <div aria-hidden className="grid h-full content-start gap-0 overflow-hidden">
      <div className="grid grid-cols-[176px_1fr_1fr] gap-2 border-b-2 border-kumo-divider p-2">
        <span className="h-3 w-16 animate-pulse bg-kumo-faint" />
        <span className="h-14 animate-pulse bg-kumo-faint" />
        <span className="h-14 animate-pulse bg-kumo-faint" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton rows are positional
          key={i}
          className="grid grid-cols-[176px_1fr_1fr] gap-2 border-b border-kumo-rule p-2"
        >
          <span className="h-3 w-24 animate-pulse bg-kumo-faint" />
          <span className="h-3 animate-pulse bg-kumo-faint" />
          <span className="h-3 animate-pulse bg-kumo-faint" />
        </div>
      ))}
    </div>
  );
}
ArenaSkeleton.displayName = "ArenaSkeleton";
