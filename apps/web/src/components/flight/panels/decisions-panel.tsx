import { Button, cn } from "@cloudflare/kumo";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatNumber } from "../../../lib/format";
import { EmptyState } from "../../ui/empty-state";
import { Tag } from "../../ui/tag";
import { useFlight } from "../flight-context";
import {
  type DecisionKind,
  type DecisionState,
  entityLabel,
  type FlightState,
  providerName,
  refKey,
  relatedRefs,
} from "../flight-model";
import { useFlightFilters, useFlightStore, useSelection } from "../flight-store";
import { EntityHover } from "../hover-preview";
import { PanelSkeleton } from "../panel-frame";
import type { PanelProps } from "../panel-types";
import { RefButton } from "./arena/ref-button";
import {
  ByTag,
  CausalTrace,
  clockOf,
  DECISION_KINDS,
  KIND_NOUN,
  KindTag,
} from "./decisions/decision-view";

/**
 * Decisions (AGENTS.md 23.5 Decision Receipts, 32.3 fork, 34 gate, 36 promotion): every decision
 * recorded for the Change up to the fold instant, oldest first. Selecting a decision expands its
 * causal history in place: the recorded inputs that fed it, oldest first, on a 1px rule that ends
 * at the decision itself (DESIGN.md 9.8 trace waterfall). Facts only: `state.decisions` is
 * derived in flight-model.ts from Task runs, Decision Receipts, conflict, Candidate, Evidence and
 * approval records.
 */

const routeProvider = (d: DecisionState) => {
  if (d.kind !== "route") return null;
  const provider = d.receipt?.provider;
  return providerName(typeof provider === "string" ? provider : null);
};

function matches(d: DecisionState, query: string) {
  if (!query) return true;
  return `${d.title} ${d.verdict} ${d.by}`.toLowerCase().includes(query);
}

/** "14 routes · 1 fork · 2 gates": counts of every kind present, in protocol order. */
function countLine(counts: Record<DecisionKind, number>) {
  return DECISION_KINDS.filter((k) => counts[k] > 0)
    .map((k) => `${formatNumber(counts[k])} ${KIND_NOUN[k][counts[k] === 1 ? 0 : 1]}`)
    .join(" · ");
}

function KindChip({
  kind,
  count,
  pressed,
  onClick,
}: {
  kind: DecisionKind;
  count: number;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-6 items-center gap-1.5 border px-2 py-0.5 text-[12px] whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 pointer-coarse:min-h-11",
        pressed
          ? "border-kumo-ink bg-kumo-ink text-kumo-inverse"
          : "border-kumo-rule hover:bg-kumo-faint",
      )}
    >
      {KIND_NOUN[kind][1]}
      <span className="font-mono text-[11px] tabular-nums opacity-70">{formatNumber(count)}</span>
    </button>
  );
}
KindChip.displayName = "KindChip";

function DecisionRow({
  decision,
  state,
  selected,
  dimmed,
  latest,
  focused,
}: {
  decision: DecisionState;
  state: FlightState;
  selected: boolean;
  dimmed: boolean;
  latest: boolean;
  focused: boolean;
}) {
  const ref = { kind: "decision" as const, id: decision.id };
  const hovered = useFlightStore(
    (s) => s.hover !== null && s.hover.kind === "decision" && s.hover.id === decision.id,
  );
  const subject = entityLabel(state, decision.subject);
  const subjectText =
    decision.subject.kind === "task"
      ? (state.tasks[decision.subject.id]?.key ?? subject.title)
      : subject.title;
  const provider = routeProvider(decision);
  return (
    <li
      data-decision={decision.id}
      className={cn(
        "border-b border-kumo-rule transition-opacity duration-[var(--rh-dur-ui)]",
        dimmed && "opacity-45",
      )}
    >
      <div
        className={cn(
          "grid grid-cols-[minmax(0,1fr)_auto] items-start hover:bg-kumo-row-hover",
          (selected || hovered) && "bg-kumo-faint",
          selected && "shadow-[inset_2px_0_0_var(--color-accent-500)]",
        )}
      >
        <EntityHover entity={ref}>
          <button
            type="button"
            aria-pressed={selected}
            aria-expanded={selected}
            onClick={() => useFlightStore.getState().toggle(ref)}
            className="grid min-h-6 w-full min-w-0 cursor-pointer grid-cols-[56px_76px_minmax(0,1fr)] items-baseline gap-x-2 py-1.5 pl-3 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-500"
          >
            <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
              {clockOf(decision.at)}
            </span>
            <span className="flex min-w-0 items-center gap-1">
              <KindTag kind={decision.kind} />
            </span>
            <span className="grid min-w-0 gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[13px] font-semibold" title={decision.title}>
                  {decision.title}
                </span>
                {provider && <Tag variant="outline">{provider}</Tag>}
                {latest && <Tag variant="accent">Latest</Tag>}
              </span>
              <span
                className={cn("min-w-0 text-[12px] text-kumo-subtle", !focused && "truncate")}
                title={decision.verdict}
              >
                {decision.verdict}
              </span>
            </span>
          </button>
        </EntityHover>
        <div className="flex min-w-0 items-center gap-1.5 py-1.5 pr-2 pl-2">
          <ByTag by={decision.by} />
          <RefButton
            entity={decision.subject}
            mode="select"
            title={`Select ${subject.kicker}: ${subject.title}`}
            context={`select ${subject.kicker}: ${subject.title}`}
            className="max-w-[120px] truncate px-1 font-mono text-[11px]"
          >
            {subjectText}
          </RefButton>
        </div>
      </div>
      {selected && (
        <div className="border-t border-kumo-rule bg-kumo-base py-2.5 pr-3 pl-[71px]">
          <p className="mb-2 text-[11px] tracking-[0.08em] text-kumo-subtle uppercase">
            Causal history · {formatNumber(decision.causes.length)} recorded cause
            {decision.causes.length === 1 ? "" : "s"}
          </p>
          <CausalTrace decision={decision} />
        </div>
      )}
    </li>
  );
}
DecisionRow.displayName = "DecisionRow";

export function DecisionsPanel({ focused }: PanelProps) {
  const { state, ready } = useFlight();
  const filters = useFlightFilters();
  const selection = useSelection();
  const [kinds, setKinds] = useState<DecisionKind[]>([]);
  const listRef = useRef<HTMLOListElement>(null);

  const counts = useMemo(() => {
    const out: Record<DecisionKind, number> = {
      route: 0,
      fork: 0,
      gate: 0,
      approval: 0,
      promotion: 0,
    };
    for (const d of state.decisions) out[d.kind] += 1;
    return out;
  }, [state.decisions]);

  const query = filters.query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      state.decisions.filter(
        (d) => (kinds.length === 0 || kinds.includes(d.kind)) && matches(d, query),
      ),
    [state.decisions, kinds, query],
  );

  const related = useMemo(() => relatedRefs(state, selection), [state, selection]);
  const latestId = state.live ? (state.decisions.at(-1)?.id ?? null) : null;
  const selectedId = selection?.kind === "decision" ? selection.id : null;

  // A decision selected elsewhere (inspector, palette) scrolls into view here.
  useEffect(() => {
    if (!selectedId) return;
    listRef.current
      ?.querySelector(`[data-decision="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  if (!ready) return <PanelSkeleton />;

  const toggleKind = (kind: DecisionKind) =>
    setKinds((current) =>
      current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind],
    );
  const summary = countLine(counts);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-kumo-rule px-3 py-1.5">
        <fieldset className="flex flex-wrap items-center gap-1">
          <legend className="sr-only">Decision kinds</legend>
          {DECISION_KINDS.filter((k) => counts[k] > 0).map((kind) => (
            <KindChip
              key={kind}
              kind={kind}
              count={counts[kind]}
              pressed={kinds.includes(kind)}
              onClick={() => toggleKind(kind)}
            />
          ))}
        </fieldset>
        {summary && (
          <p className="ml-auto truncate font-mono text-[11px] text-kumo-subtle">{summary}</p>
        )}
      </div>

      {state.decisions.length === 0 ? (
        <div className="px-3">
          <EmptyState
            what="No decisions recorded yet."
            how="A route appears when an attempt starts; forks, gates, approvals and promotions follow their records."
          />
        </div>
      ) : shown.length === 0 ? (
        <div className="px-3">
          <EmptyState
            what="No decision matches the filters."
            how={`${formatNumber(state.decisions.length)} decisions are recorded at this instant.`}
            action={
              kinds.length > 0 ? (
                <Button size="sm" variant="secondary" onClick={() => setKinds([])}>
                  Show every kind
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <ol
          ref={listRef}
          aria-label={`Decisions, oldest first${summary ? `: ${summary}` : ""}`}
          className="min-h-0 flex-1 overflow-auto"
        >
          {shown.map((d) => (
            <DecisionRow
              key={d.id}
              decision={d}
              state={state}
              selected={d.id === selectedId}
              dimmed={
                selection !== null &&
                !related.has(refKey({ kind: "decision", id: d.id })) &&
                !related.has(refKey(d.subject))
              }
              latest={d.id === latestId}
              focused={focused}
            />
          ))}
        </ol>
      )}
    </div>
  );
}
DecisionsPanel.displayName = "DecisionsPanel";
