import { cn } from "@cloudflare/kumo";
import { type ReactNode, useMemo, useState } from "react";
import { formatNumber } from "../../../lib/format";
import { FAMILY_TEXT, StatusPill } from "../../ui/status-pill";
import { useFlight } from "../flight-context";
import {
  type CandidateState,
  type CheckState,
  type FlightState,
  relatedRefs,
} from "../flight-model";
import { useFlightFilters, useSelection } from "../flight-store";
import { PanelSkeleton } from "../panel-frame";
import type { PanelProps } from "../panel-types";
import {
  checkEventIds,
  checkView,
  gateGaps,
  isSettled,
  metricBits,
  standing,
} from "./arena/check-view";
import { RefButton } from "./arena/ref-button";
import { CheckDetail, parseCheckRef } from "./evidence/check-detail";

/**
 * Evidence explorer (AGENTS.md 34.3, 34.4.1; DESIGN.md 9.11 tree list, 9.7 log viewer). Left: each
 * Candidate's checks in plan order, required first, with status and coverage in words. Right: the
 * selected check's Evidence record, plan and stored stdout (fetched for that one check only).
 * A check without a supported pass is a gap, never green; a check fact that newly played flashes
 * its row once.
 */

type Bucket = "pass" | "fail" | "gap" | "pending";
type Chip = "all" | Bucket;

const CHIPS: { value: Chip; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pass", label: "Pass" },
  { value: "fail", label: "Fail" },
  { value: "gap", label: "Gap" },
  { value: "pending", label: "Pending" },
];

function bucketOf(check: CheckState, settled: boolean): Bucket {
  if (check.status === "fail" || check.status === "error") return "fail";
  if (check.status === "pending" && !settled) return "pending";
  return checkView(check, settled).satisfied ? "pass" : "gap";
}

/** Required checks first, plan order kept inside each half. */
const ordered = (checks: CheckState[]) => [
  ...checks.filter((c) => c.required),
  ...checks.filter((c) => !c.required),
];

type Group = {
  candidate: CandidateState;
  checks: { check: CheckState; bucket: Bucket }[];
};

function matches(state: FlightState, candidate: CandidateState, check: CheckState, q: string) {
  if (!q) return true;
  return [
    candidate.id,
    candidate.name,
    check.checkId,
    check.kind,
    check.status,
    ...candidate.taskIds.map((id) => state.tasks[id]?.key ?? ""),
  ].some((s) => s.toLowerCase().includes(q));
}

function ChipButton({
  pressed,
  count,
  onClick,
  children,
}: {
  pressed: boolean;
  count: number;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-6 items-center gap-1 border px-1.5 py-0.5 text-[12px] whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 pointer-coarse:min-h-11",
        pressed
          ? "border-kumo-ink bg-kumo-ink text-kumo-inverse"
          : "border-kumo-rule hover:bg-kumo-faint",
      )}
    >
      {children}
      <span className="font-mono text-[11px] tabular-nums opacity-70">{formatNumber(count)}</span>
    </button>
  );
}
ChipButton.displayName = "ChipButton";

function CandidateHeader({ state, candidate }: { state: FlightState; candidate: CandidateState }) {
  const line = standing(state, candidate);
  const gaps = gateGaps(state, candidate);
  return (
    <div className="grid gap-0.5 border-b-2 border-kumo-divider px-3 pt-2 pb-1.5">
      <div className="flex items-center justify-between gap-2">
        <RefButton
          entity={{ kind: "candidate", id: candidate.id }}
          className="min-w-0 truncate px-1 text-[13px] font-semibold"
        >
          {candidate.name}
        </RefButton>
        <StatusPill status={candidate.status} />
      </div>
      {line && <p className="px-1 text-[12px] text-kumo-subtle">{line}</p>}
      {gaps.length > 0 && (
        <ul className="grid gap-0.5 px-1 text-[12px] text-kumo-warning">
          {gaps.map((g) => (
            <li key={g.checkId}>
              Gate gap: <span className="font-mono">{g.checkId}</span> {g.words}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
CandidateHeader.displayName = "CandidateHeader";

function CheckRow({
  state,
  candidate,
  check,
  last,
  dim,
  flash,
}: {
  state: FlightState;
  candidate: CandidateState;
  check: CheckState;
  last: boolean;
  dim: boolean;
  flash: boolean;
}) {
  const view = checkView(check, isSettled(candidate));
  const bits = metricBits(state, candidate, check);
  const gap = check.coverage !== "checked_supported";
  return (
    <li
      className={cn(
        "border-b border-kumo-rule transition-opacity duration-(--rh-dur-ui)",
        dim && "opacity-45",
        flash && "rh-arrive",
      )}
    >
      <RefButton
        entity={{ kind: "check", id: `${candidate.id}:${check.checkId}` }}
        label={`${candidate.name} ${check.checkId}: ${view.word}, ${view.coverage}${check.required ? ", required" : ", optional"}`}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-2 px-3 py-1"
      >
        <span aria-hidden className="font-mono text-[12px] whitespace-pre text-kumo-subtle">
          {last ? "└─ " : "├─ "}
        </span>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-mono text-[12px]">{check.checkId}</span>
          <span className="shrink-0 text-[11px] text-kumo-subtle">
            {check.kind !== check.checkId ? check.kind : ""}
            {check.required ? "" : " optional"}
          </span>
        </span>
        <span className={cn("text-[12px] font-semibold", FAMILY_TEXT[view.family])}>
          {view.word}
        </span>
        <span />
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[11px]">
          <span className={gap ? "text-kumo-warning" : "text-kumo-subtle"}>{view.coverage}</span>
          {bits.map((b) => (
            <span key={b} className="font-mono text-kumo-subtle tabular-nums">
              {b}
            </span>
          ))}
        </span>
        <span />
      </RefButton>
    </li>
  );
}
CheckRow.displayName = "CheckRow";

export function EvidencePanel({ focused }: PanelProps) {
  const { state, ready, animated } = useFlight();
  const selection = useSelection();
  const { query } = useFlightFilters();
  const [chip, setChip] = useState<Chip>("all");
  const q = query.trim().toLowerCase();

  const groups = useMemo<Group[]>(
    () =>
      state.candidateOrder
        .map((id) => state.candidates[id])
        .filter((c): c is CandidateState => !!c)
        .map((candidate) => {
          const settled = isSettled(candidate);
          return {
            candidate,
            checks: ordered(candidate.checks)
              .filter((check) => matches(state, candidate, check, q))
              .map((check) => ({ check, bucket: bucketOf(check, settled) })),
          };
        }),
    [state, q],
  );
  const counts = useMemo(() => {
    const out: Record<Chip, number> = { all: 0, pass: 0, fail: 0, gap: 0, pending: 0 };
    for (const g of groups) {
      for (const c of g.checks) {
        out.all += 1;
        out[c.bucket] += 1;
      }
    }
    return out;
  }, [groups]);
  const related = useMemo(() => relatedRefs(state, selection), [state, selection]);
  const eventIds = useMemo(() => checkEventIds(state), [state]);

  if (!ready) return <PanelSkeleton />;

  if (groups.length === 0) {
    return (
      <div className="px-3 py-3 text-[13px]">
        <p className="font-semibold">No Candidates yet.</p>
        <p className="text-kumo-subtle">
          Evidence appears here when a Candidate is composed and its verification plan runs.
        </p>
      </div>
    );
  }

  const visible = groups
    .map((g) => ({
      ...g,
      checks: chip === "all" ? g.checks : g.checks.filter((c) => c.bucket === chip),
    }))
    .filter((g) => g.checks.length > 0 || (chip === "all" && !q));
  const selected = selection?.kind === "check" ? parseCheckRef(selection.id) : null;
  const summary = groups
    .map(
      (g) =>
        `${g.candidate.name}: ${g.checks.filter((c) => c.bucket === "pass").length} pass, ${g.checks.filter((c) => c.bucket === "fail").length} fail, ${g.checks.filter((c) => c.bucket === "gap").length} gap, ${g.checks.filter((c) => c.bucket === "pending").length} pending`,
    )
    .join(". ");

  return (
    <div className="@container h-full min-h-0">
      <div
        className={cn(
          "grid h-full min-h-0 content-start overflow-auto @min-[640px]:grid-rows-[minmax(0,1fr)] @min-[640px]:content-stretch @min-[640px]:overflow-hidden",
          focused
            ? "@min-[640px]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
            : "@min-[640px]:grid-cols-2",
        )}
      >
        <div className="@min-[640px]:overflow-auto @min-[640px]:border-r @min-[640px]:border-kumo-rule">
          <fieldset className="sticky top-0 z-[2] flex min-w-0 flex-wrap gap-1 border-b border-kumo-rule bg-kumo-elevated px-3 py-1.5">
            <legend className="sr-only">Filter checks by result</legend>
            {CHIPS.map((c) => (
              <ChipButton
                key={c.value}
                pressed={chip === c.value}
                count={counts[c.value]}
                onClick={() => setChip(c.value)}
              >
                {c.label}
              </ChipButton>
            ))}
          </fieldset>
          <p className="sr-only">{summary}.</p>
          {visible.length === 0 ? (
            <p className="px-3 py-3 text-[13px] text-kumo-subtle">
              No check matches {q ? `“${query.trim()}”` : "this filter"}.
            </p>
          ) : (
            visible.map((g) => {
              const settled = isSettled(g.candidate);
              return (
                <section key={g.candidate.id} aria-label={g.candidate.name}>
                  <CandidateHeader state={state} candidate={g.candidate} />
                  {g.checks.length === 0 ? (
                    <p className="px-3 py-2 text-[12px] text-kumo-subtle">
                      {g.candidate.detail.plan
                        ? "No checks in the verification plan."
                        : settled
                          ? "No verification plan was recorded."
                          : "Verification plan not built yet."}
                    </p>
                  ) : (
                    <ul>
                      {g.checks.map(({ check }, i) => {
                        const key = `${g.candidate.id}:${check.checkId}`;
                        const eventId = eventIds.get(key);
                        return (
                          <CheckRow
                            key={check.checkId}
                            state={state}
                            candidate={g.candidate}
                            check={check}
                            last={i === g.checks.length - 1}
                            dim={
                              selection !== null &&
                              !related.has(`check:${key}`) &&
                              !related.has(`candidate:${g.candidate.id}`)
                            }
                            flash={eventId !== undefined && animated.has(eventId)}
                          />
                        );
                      })}
                    </ul>
                  )}
                </section>
              );
            })
          )}
        </div>
        <div className="border-t-2 border-kumo-divider px-3 py-2 @min-[640px]:overflow-auto @min-[640px]:border-t-0">
          {selected ? (
            <div className="grid gap-3">
              <div className="grid gap-0.5">
                <p className="type-kicker text-kumo-subtle">
                  {state.candidates[selected.candidateId]?.name ?? selected.candidateId}
                </p>
                <h3 className="font-mono text-[13px] font-semibold">{selected.checkId}</h3>
              </div>
              <CheckDetail candidateId={selected.candidateId} checkId={selected.checkId} />
            </div>
          ) : (
            <p className="py-1 text-[12px] text-kumo-subtle">
              Select a check to see its Evidence record, plan and stored output.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
EvidencePanel.displayName = "EvidencePanel";
