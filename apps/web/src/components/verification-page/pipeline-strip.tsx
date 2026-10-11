import { cn } from "@cloudflare/kumo";
import { formatNumber } from "../../lib/format";
import type { Stage } from "./model";

export type StageCount = {
  stage: Stage;
  name: string;
  /** Candidates that reached this stage. */
  count: number;
  /** One line of description, for example "2 composing now". */
  description: string;
};

/**
 * Pipeline / stage strip (DESIGN.md 9.4): equal columns under a 2px ink rule with 1px rules
 * between them. Each column shows `01 · Name`, a display number, one line of description and a
 * 6px bar whose width is the share of the first stage. The whole column is a toggle that filters
 * the Candidate table to that stage. No column uses accent: on this page red means a failure.
 */
export function PipelineStrip({
  stages,
  selected,
  onSelect,
}: {
  stages: StageCount[];
  selected: Stage | null;
  onSelect: (stage: Stage | null) => void;
}) {
  const first = stages[0]?.count ?? 0;
  return (
    // `relative` keeps the sr-only share text inside the scroller (it would widen the page).
    <div className="relative min-w-0 overflow-x-auto">
      <ol
        aria-label="Verification pipeline"
        className="grid min-w-[640px] border-t-2 border-kumo-ink"
        style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}
      >
        {stages.map((s, index) => {
          const share = first > 0 ? Math.min(1, s.count / first) : 0;
          const isSelected = selected === s.stage;
          return (
            <li key={s.stage} className="flex min-w-0 border-kumo-rule not-first:border-l">
              <button
                type="button"
                aria-pressed={isSelected}
                title={`${s.name}: ${formatNumber(s.count)} of ${formatNumber(first)} Candidates. ${
                  isSelected ? "Show all Candidates." : "Show only these Candidates."
                }`}
                onClick={() => onSelect(isSelected ? null : s.stage)}
                className={cn(
                  "grid w-full min-w-0 cursor-pointer content-start gap-2 px-4 py-3 text-left",
                  "transition-colors duration-(--rh-dur-ui) hover:bg-kumo-row-hover",
                  "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-500",
                  isSelected && "bg-kumo-faint shadow-[inset_2px_0_0_var(--color-accent-500)]",
                )}
              >
                <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
                  {String(index + 1).padStart(2, "0")} · {s.name}
                </span>
                <span className="type-display">{formatNumber(s.count)}</span>
                <span className="truncate text-[12px] text-kumo-subtle">{s.description}</span>
                <span aria-hidden className="block h-1.5 bg-kumo-recessed">
                  <span
                    className="block h-full bg-kumo-ink transition-[width] duration-(--rh-dur-bar)"
                    style={{ width: `${Math.round(share * 100)}%` }}
                  />
                </span>
                <span className="sr-only">
                  {formatNumber(Math.round(share * 100))} percent of all Candidates
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
PipelineStrip.displayName = "PipelineStrip";
