import { cn } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { formatClock, formatNumber } from "../../../../lib/format";
import { StatusPill } from "../../../ui/status-pill";
import { useFlight } from "../../flight-context";
import type { Cause, DecisionKind, DecisionState, FlightState } from "../../flight-model";
import { type EntityRef, useFlightStore, useIsHighlighted } from "../../flight-store";
import { EntityHover } from "../../hover-preview";

/**
 * Shared pieces of the Decisions panel and the Decision inspector:
 * the kind tag, the "decided by" tag, and the causal trace of one decision drawn as a 1px rule
 * with one square node per recorded cause and the decision itself last, in ink.
 */

export const DECISION_KINDS: DecisionKind[] = ["route", "fork", "gate", "approval", "promotion"];

/** Plural nouns for counts: "14 routes · 1 fork". */
export const KIND_NOUN: Record<DecisionKind, [string, string]> = {
  route: ["route", "routes"],
  fork: ["fork", "forks"],
  gate: ["gate", "gates"],
  approval: ["approval", "approvals"],
  promotion: ["promotion", "promotions"],
};

/** Distinct, token-only styles: neutral fill, accent outline (conflict), ink outline, dashed ink
 * (human gate), solid ink (canonical change). The word is always the label. */
const KIND_STYLE: Record<DecisionKind, string> = {
  route: "bg-tone-100 text-tone-800",
  fork: "border border-accent-500 text-kumo-accent",
  gate: "border border-kumo-ink text-kumo-default",
  approval: "border border-dashed border-kumo-ink text-kumo-default",
  promotion: "bg-kumo-ink text-kumo-inverse",
};

export function KindTag({ kind, className }: { kind: DecisionKind; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex w-fit shrink-0 items-center px-1.5 py-px font-mono text-[11px] leading-tight whitespace-nowrap",
        KIND_STYLE[kind],
        className,
      )}
    >
      {kind}
    </span>
  );
}
KindTag.displayName = "KindTag";

/** Who or what decided: `rules`, `clef`, `sonnet`, `opus`, `human`, `cas`, `policy`. */
export function ByTag({ by }: { by: string }) {
  return (
    <span
      title={`Decided by ${by}`}
      className="inline-flex w-fit shrink-0 items-center border border-kumo-rule px-1.5 py-px font-mono text-[11px] leading-tight whitespace-nowrap text-kumo-subtle"
    >
      {by}
    </span>
  );
}
ByTag.displayName = "ByTag";

export const clockOf = (at: number | null) =>
  at === null ? "—" : formatClock(new Date(at).toISOString());

/**
 * Causes oldest first. A cause without a recorded time keeps its place next to the cause recorded
 * before it (it is context of that step), so the sort never invents an order.
 */
function orderedCauses(causes: Cause[]): Cause[] {
  let carry = Number.NEGATIVE_INFINITY;
  const keyed = causes.map((cause, index) => {
    if (cause.at !== null) carry = cause.at;
    return { cause, key: cause.at ?? carry, index };
  });
  keyed.sort((a, b) => a.key - b.key || a.index - b.index);
  return keyed.map((k) => k.cause);
}

/** Short label for a cause's entity button. */
function refText(state: FlightState, ref: EntityRef): string {
  switch (ref.kind) {
    case "task":
      return state.tasks[ref.id]?.key ?? ref.id;
    case "candidate":
      return state.candidates[ref.id]?.name ?? ref.id;
    case "check":
      return ref.id.split(":").slice(1).join(":") || ref.id;
    case "conflict":
      return "conflict";
    case "decision":
      return state.decisions.find((d) => d.id === ref.id)?.kind ?? "decision";
    case "event":
      return state.events.find((e) => e.id === ref.id)?.type ?? "event";
    default:
      return ref.id;
  }
}

/** The cause's entity as it stands at the fold instant, in words (inspector only). */
function causeNow(state: FlightState, ref: EntityRef): ReactNode {
  switch (ref.kind) {
    case "task": {
      const t = state.tasks[ref.id];
      return t ? <StatusPill status={t.status} /> : null;
    }
    case "candidate": {
      const c = state.candidates[ref.id];
      return c ? <StatusPill status={c.status} /> : null;
    }
    case "check": {
      const [candidateId = "", ...rest] = ref.id.split(":");
      const check = state.candidates[candidateId]?.checks.find((c) => c.checkId === rest.join(":"));
      if (!check) return null;
      return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <StatusPill status={check.status} />
          <span className="text-[11px] text-kumo-subtle">
            {check.coverage ? check.coverage.replace(/_/g, " ") : "no Evidence yet"}
          </span>
        </span>
      );
    }
    case "conflict": {
      const c = state.conflicts.find((x) => x.id === ref.id);
      return c ? <StatusPill status={c.state} /> : null;
    }
    case "decision": {
      const d = state.decisions.find((x) => x.id === ref.id);
      return d ? (
        <span className="text-[11px] text-kumo-subtle">{`${d.kind} by ${d.by}`}</span>
      ) : (
        <span className="text-[11px] text-kumo-subtle">Not recorded at this instant</span>
      );
    }
    case "event":
      return state.events.some((e) => e.id === ref.id) ? null : (
        <span className="text-[11px] text-kumo-subtle">Not in the fold at this instant</span>
      );
    case "resource": {
      const r = state.resources.find((x) => x.resource === ref.id);
      if (!r) return null;
      return (
        <span className="text-[11px] text-kumo-subtle">
          {r.claimedBy.length === 0
            ? "No active Claim"
            : `${formatNumber(r.claimedBy.length)} active Claim${r.claimedBy.length === 1 ? "" : "s"}`}
        </span>
      );
    }
    default:
      return null;
  }
}

function CauseButton({
  entity,
  className,
  children,
}: {
  entity: EntityRef;
  className?: string;
  children: ReactNode;
}) {
  const { selected, hovered } = useIsHighlighted(entity);
  return (
    <EntityHover entity={entity}>
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => useFlightStore.getState().select(entity)}
        className={cn(
          "min-h-6 max-w-full cursor-pointer truncate border border-kumo-rule px-1.5 font-mono text-[11px] hover:bg-kumo-faint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 pointer-coarse:min-h-11",
          (selected || hovered) && "bg-kumo-faint",
          className,
        )}
      >
        {children}
      </button>
    </EntityHover>
  );
}
CauseButton.displayName = "CauseButton";

/**
 * The causal history of one decision: its recorded causes, oldest first, then the decision.
 * `roomy` (inspector) adds each cause's entity name and its state at the fold instant.
 */
export function CausalTrace({
  decision,
  roomy = false,
  className,
}: {
  decision: DecisionState;
  roomy?: boolean;
  className?: string;
}) {
  const { state } = useFlight();
  const causes = orderedCauses(decision.causes);
  return (
    <ol
      aria-label={`Causal history of ${decision.title}`}
      className={cn("relative grid", roomy ? "gap-3" : "gap-1.5", className)}
    >
      {/* The 1px rule that connects the causes to the decision. */}
      <span aria-hidden className="absolute top-2 bottom-2 left-[3px] w-px bg-kumo-divider" />
      {causes.map((cause, index) => (
        <li
          // Causes have no id; a decision's causes never reorder within one fold.
          // biome-ignore lint/suspicious/noArrayIndexKey: positional causes of one decision
          key={index}
          className={cn(
            "relative grid grid-cols-[7px_minmax(0,1fr)] gap-x-2.5",
            roomy ? "items-start" : "items-center",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "z-[1] size-[7px] border border-kumo-divider bg-kumo-base",
              roomy && "mt-1",
            )}
          />
          <div
            className={cn(
              "grid min-w-0 gap-x-2 gap-y-1",
              roomy
                ? "grid-cols-[64px_minmax(0,1fr)]"
                : "grid-cols-[56px_minmax(0,1fr)_auto] items-center",
            )}
          >
            <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
              {clockOf(cause.at)}
            </span>
            <span className={cn("min-w-0 text-[12px]", !roomy && "truncate")} title={cause.label}>
              {cause.label}
            </span>
            {roomy ? (
              <span className="col-start-2 flex min-w-0 flex-wrap items-center gap-2">
                <CauseButton entity={cause.ref}>
                  {cause.ref.kind} · {refText(state, cause.ref)}
                </CauseButton>
                {causeNow(state, cause.ref)}
              </span>
            ) : (
              <CauseButton entity={cause.ref} className="max-w-[140px]">
                {refText(state, cause.ref)}
              </CauseButton>
            )}
          </div>
        </li>
      ))}
      <li className="relative grid grid-cols-[7px_minmax(0,1fr)] items-start gap-x-2.5">
        <span aria-hidden className="z-[1] mt-1 size-[7px] bg-kumo-ink" />
        <div
          className={cn(
            "grid min-w-0 gap-x-2",
            roomy ? "grid-cols-[64px_minmax(0,1fr)]" : "grid-cols-[56px_minmax(0,1fr)]",
          )}
        >
          <span className="font-mono text-[11px] tabular-nums">{clockOf(decision.at)}</span>
          <span className="min-w-0 text-[12px] font-semibold">
            {decision.kind === "route" ? "Routed" : "Decided"}: {decision.verdict}
          </span>
        </div>
      </li>
    </ol>
  );
}
CausalTrace.displayName = "CausalTrace";
