import { cn } from "@cloudflare/kumo";
import { formatNumber } from "../../lib/format";
import type { Stage } from "./model";

export type StageCount = {
  stage: Stage;
  name: string;
  /** Versions that reached this stage. */
  count: number;
  /** One line of description, for example "2 composing now". */
  description: string;
};

/**
 * Stage strip (Advanced, spec B.2): equal columns separated by 1px rules. Each column shows the
 * stage name, a count, one line of description and a bar whose width is the share of the first
 * stage. The whole column is a toggle that filters the versions table to that stage.
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
    <div className="min-w-0 overflow-x-auto">
      <ol
        aria-label="Stages"
        className="grid min-w-[640px] overflow-hidden rounded-lg border border-kumo-rule bg-kumo-elevated"
        style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}
      >
        {stages.map((s) => {
          const share = first > 0 ? Math.min(1, s.count / first) : 0;
          const isSelected = selected === s.stage;
          return (
            <li key={s.stage} className="flex min-w-0 border-kumo-rule not-first:border-l">
              <button
                type="button"
                aria-pressed={isSelected}
                title={`${s.name}: ${formatNumber(s.count)} of ${formatNumber(first)} versions. ${
                  isSelected ? "Show all versions." : "Show only these versions."
                }`}
                onClick={() => onSelect(isSelected ? null : s.stage)}
                className={cn(
                  "grid w-full min-w-0 cursor-pointer content-start gap-2 px-4 py-3 text-left",
                  "transition-colors duration-(--rh-dur-ui) hover:bg-kumo-row-hover",
                  "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-500",
                  isSelected && "bg-kumo-faint shadow-[inset_2px_0_0_var(--color-accent-500)]",
                )}
              >
                <span className="text-[13px] font-semibold">{s.name}</span>
                <span className="text-[24px] leading-none font-semibold tabular-nums">
                  {formatNumber(s.count)}
                </span>
                <span className="truncate text-[12px] text-kumo-subtle">{s.description}</span>
                <span aria-hidden className="block h-1 rounded-full bg-kumo-recessed">
                  <span
                    className="block h-full rounded-full bg-kumo-info"
                    style={{ width: `${Math.round(share * 100)}%` }}
                  />
                </span>
                <span className="sr-only">
                  {formatNumber(Math.round(share * 100))} percent of all versions
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
