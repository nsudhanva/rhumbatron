import { ShieldCheck } from "@phosphor-icons/react";
import type { CandidateDetail, ConflictDetail, TaskDetail } from "../../lib/api";
import { formatFraction, formatNumber, formatUsd, latestRun } from "../../lib/format";
import { SegmentedSteps } from "../ui/meter";
import { StatCell, StatStrip } from "../ui/stat-strip";
import { StatusPill } from "../ui/status-pill";

/** Recorded model spend and calls across every run of the Change. Null before the first run. */
export function changeSpend(tasks: TaskDetail[]) {
  const runs = tasks.flatMap((t) => t.runs);
  if (runs.length === 0) return null;
  return {
    calls: runs.reduce((sum, r) => sum + r.modelCalls, 0),
    costUsd: runs.reduce((sum, r) => sum + r.costUsd, 0),
  };
}

/** Stat strip for one Change. Real data only; a cell without data is omitted. */
export function ChangeStats({
  tasks,
  conflicts,
  candidates,
  budgetUsd,
}: {
  tasks: TaskDetail[];
  conflicts: ConflictDetail[];
  candidates: CandidateDetail[];
  /** The request budget; null when the Change draws on a monthly pool (Project or personal). */
  budgetUsd: number | null;
}) {
  const done = tasks.filter((t) => t.status === "completed").length;
  const running = tasks.filter((t) => latestRun(t)?.status === "running").length;
  const woken = tasks.filter((t) => t.runs.length > 0).length;
  const open = conflicts.filter((c) => c.state !== "resolved");
  const verified = candidates.filter((c) => c.status === "verified" || c.status === "promoted");
  const rejected = candidates.filter((c) => c.status === "rejected").length;
  const spend = changeSpend(tasks);
  return (
    <StatStrip>
      <StatCell
        label="Tasks done"
        value={formatNumber(done)}
        unit={`/ ${formatNumber(tasks.length)}`}
      >
        {tasks.length > 0 && (
          <SegmentedSteps
            label="Tasks"
            steps={tasks.map((t) => ({ label: `${t.key} ${t.title}`, status: t.status }))}
          />
        )}
      </StatCell>
      <StatCell
        label="Active agents"
        value={formatNumber(running)}
        footnote={`${formatNumber(woken)} woken · ${formatNumber(tasks.length - woken)} asleep`}
      />
      <StatCell
        label="Conflicts"
        value={formatNumber(open.length)}
        unit="open"
        pill={
          open.some((c) => c.state === "confirmed" || c.state === "fork_required") ? (
            <StatusPill status="confirmed" />
          ) : undefined
        }
        footnote={`${formatNumber(conflicts.length - open.length)} resolved`}
      />
      <StatCell
        label="Candidates verified"
        value={formatNumber(verified.length)}
        unit={`/ ${formatNumber(candidates.length)}`}
        footnote={`${formatNumber(rejected)} rejected`}
      />
      {spend && (
        <StatCell
          label="Model calls"
          value={formatNumber(spend.calls)}
          footnote={
            budgetUsd === null
              ? `${formatUsd(spend.costUsd)} spent`
              : `${formatFraction(formatUsd(spend.costUsd), formatUsd(budgetUsd))} spent`
          }
        />
      )}
    </StatStrip>
  );
}

/**
 * Acceptance criteria as a checklist before a Candidate is judged: every item
 * shows the pending square. A judged Candidate shows met or not met (candidate/acceptance-list).
 */
export function CriteriaList({ items }: { items: string[] }) {
  if (items.length === 0) {
    return (
      <p className="text-[13px] text-kumo-subtle">The Root Planner has not set criteria yet.</p>
    );
  }
  return (
    <ul className="grid">
      {items.map((item) => (
        <li
          key={item}
          className="grid grid-cols-[14px_minmax(0,1fr)] items-start gap-2.5 border-b border-kumo-rule py-2 text-[13px]"
        >
          <span aria-hidden className="mt-0.5 size-3.5 border border-kumo-divider" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Small product details the Root Planner decided because the request left them open. Plain text:
 * the requester changes one with a follow-up request.
 */
export function AssumptionList({ items }: { items: string[] }) {
  return (
    <div className="grid gap-2">
      <ul className="grid">
        {items.map((item) => (
          <li
            key={item}
            className="grid grid-cols-[14px_minmax(0,1fr)] items-start gap-2.5 border-b border-kumo-rule py-2 text-[13px]"
          >
            <span aria-hidden className="mt-[7px] size-1.5 bg-kumo-divider" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-kumo-subtle">
        The request left these details open, so the planner decided them. To change one, send a
        follow-up request.
      </p>
    </div>
  );
}

export function InvariantList({ items }: { items: string[] }) {
  if (items.length === 0) {
    return <p className="text-[13px] text-kumo-subtle">No protected invariants for this Change.</p>;
  }
  return (
    <ul className="grid">
      {items.map((item) => (
        <li
          key={item}
          className="grid grid-cols-[14px_minmax(0,1fr)] items-start gap-2.5 border-b border-kumo-rule py-2 text-[13px]"
        >
          <ShieldCheck aria-hidden size={14} className="mt-0.5" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
