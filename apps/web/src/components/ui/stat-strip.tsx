import { cn } from "@cloudflare/kumo";
import { createContext, type ReactNode, useContext } from "react";

/**
 * Stat strip: 3-5 equal cells with 1px rule-colored gaps and a 2px
 * divider above and below. Cells wrap on narrow widths and every row stays full, so the gap
 * always draws a clean grid line.
 *
 *   <StatStrip>
 *     <StatCell label="Canonical generation" value="S1841" mono footnote="tree 3f9c2a1b" />
 *     <StatCell label="Active changes" value={3} />
 *     <StatCell label="p95" value={164} unit="ms" pill={<StatusPill status="pass" />} />
 *   </StatStrip>
 *
 * `density="compact"` sets each cell on one line (label, value, unit, footnote) with 20px
 * numerals, for a page where the strip is context and another block is the focus. A footnote
 * that does not fit beside the value wraps to a second small line.
 */
type Density = "default" | "compact";
const DensityContext = createContext<Density>("default");

export function StatStrip({
  children,
  className,
  density = "default",
}: {
  children: ReactNode;
  className?: string;
  density?: Density;
}) {
  return (
    <DensityContext.Provider value={density}>
      <div
        className={cn(
          "flex flex-wrap gap-px border-y-2 border-kumo-divider bg-kumo-rule",
          className,
        )}
      >
        {children}
      </div>
    </DensityContext.Provider>
  );
}
StatStrip.displayName = "StatStrip";

/**
 * One stat: label, value (display 34-40px Archivo 800, or mono 24px for system values with
 * `mono`), inline unit, optional pill on the right, optional sparkline/meter (`children`) and a
 * mono footnote.
 */
export function StatCell({
  label,
  value,
  unit,
  mono,
  pill,
  footnote,
  children,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  mono?: boolean;
  pill?: ReactNode;
  footnote?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const density = useContext(DensityContext);
  if (density === "compact") {
    return (
      <div
        className={cn(
          "flex min-w-0 flex-[1_1_200px] flex-wrap items-baseline gap-x-2 gap-y-0.5 bg-kumo-base px-3 py-2",
          className,
        )}
      >
        <p className="type-label shrink-0 text-kumo-subtle">{label}</p>
        <p className="flex min-w-0 shrink-0 items-baseline gap-1">
          <span
            className={cn(
              "truncate leading-none tabular-nums",
              mono ? "font-mono text-[16px] font-semibold" : "text-[20px] font-extrabold",
            )}
          >
            {value}
          </span>
          {unit && <span className="text-[12px] text-kumo-subtle">{unit}</span>}
        </p>
        {pill}
        {children}
        {footnote && (
          <p
            className="min-w-0 truncate font-mono text-[11px] text-kumo-subtle tabular-nums"
            title={typeof footnote === "string" ? footnote : undefined}
          >
            {footnote}
          </p>
        )}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "grid min-w-0 flex-[1_1_180px] content-start gap-2 bg-kumo-base px-4 py-3",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="type-label text-kumo-subtle">{label}</p>
        {pill}
      </div>
      <p className="flex min-w-0 items-baseline gap-1.5">
        <span
          className={cn(
            "truncate",
            mono ? "font-mono text-[24px] leading-none tabular-nums" : "type-display",
          )}
        >
          {value}
        </span>
        {unit && <span className="text-[13px] text-kumo-subtle">{unit}</span>}
      </p>
      {children}
      {footnote && (
        <p className="truncate font-mono text-[11px] text-kumo-subtle tabular-nums">{footnote}</p>
      )}
    </div>
  );
}
StatCell.displayName = "StatCell";
