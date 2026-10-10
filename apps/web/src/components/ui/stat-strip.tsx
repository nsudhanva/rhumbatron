import { cn } from "@cloudflare/kumo";
import type { ReactNode } from "react";

/**
 * Stat strip: 3-5 equal cells in one card (1px rule border, 8px radius, raised fill) with 1px
 * rule-colored gaps between cells. Cells wrap on narrow widths and every row stays full, so the
 * gap always draws a clean grid line.
 *
 *   <StatStrip>
 *     <StatCell label="Live release" value="Release 1841" />
 *     <StatCell label="Active changes" value={3} />
 *     <StatCell label="Response time (p95)" value={164} unit="ms" pill={<StatusPill status="pass" />} />
 *   </StatStrip>
 */
export function StatStrip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-wrap gap-px overflow-hidden rounded-lg border border-kumo-rule bg-kumo-rule",
        className,
      )}
    >
      {children}
    </div>
  );
}
StatStrip.displayName = "StatStrip";

/**
 * One stat: label, value (28px/600, or 20px mono for system values with `mono`), inline unit,
 * optional pill on the right, optional meter (`children`) and a 12px footnote.
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
  return (
    <div
      className={cn(
        "grid min-w-0 flex-[1_1_180px] content-start gap-2 bg-kumo-elevated px-4 py-3",
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
            mono ? "font-mono text-[20px] leading-7 tabular-nums" : "type-display",
          )}
        >
          {value}
        </span>
        {unit && <span className="text-[13px] text-kumo-subtle">{unit}</span>}
      </p>
      {children}
      {footnote && <p className="type-meta truncate text-kumo-subtle tabular-nums">{footnote}</p>}
    </div>
  );
}
StatCell.displayName = "StatCell";
