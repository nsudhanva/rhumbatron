import { cn } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { formatNumber } from "../../lib/format";

/**
 * Sparkline (DESIGN.md 9.3): 16-20 square bars, `flex: 1`, 2px gaps, 20px tall, neutral-400, the
 * latest bar in ink. No axes: it shows shape only, so the exact figure sits next to it. Each bar
 * has a `title` with its own value.
 *
 *   <Sparkline points={days.map((d) => ({ label: d.day, value: d.count }))} unit="calls" />
 */
export function Sparkline({
  points,
  unit,
  label,
  className,
}: {
  points: { label: string; value: number }[];
  unit: string;
  /** Accessible summary, for example "Agent model calls per day, last 16 days". */
  label: string;
  className?: string;
}) {
  const peak = Math.max(0, ...points.map((p) => p.value));
  return (
    <ol aria-label={label} className={cn("flex h-5 items-end gap-0.5", className)}>
      {points.map((point, index) => {
        const latest = index === points.length - 1;
        const pct = peak > 0 ? (point.value / peak) * 100 : 0;
        return (
          <li
            key={point.label}
            title={`${point.label} · ${formatNumber(point.value)} ${unit}`}
            className="flex h-full min-w-0 flex-1 items-end"
          >
            <span
              aria-hidden
              className={cn(
                "block w-full",
                point.value === 0 ? "h-px bg-kumo-rule" : latest ? "bg-kumo-ink" : "bg-tone-400",
              )}
              style={point.value === 0 ? undefined : { height: `max(2px, ${pct}%)` }}
            />
            <span className="sr-only">
              {point.label}: {formatNumber(point.value)} {unit}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
Sparkline.displayName = "Sparkline";

export type BarItem = { label: ReactNode; value: number; text?: ReactNode; title?: string };

/**
 * Horizontal bar list (DESIGN.md 9.1): `label 90px · bar 1fr · value`, 8px bars, values
 * right-aligned mono. Bars scale to `max` (default: the largest value). Every bar shows its
 * value as text.
 */
export function BarList({
  items,
  max,
  className,
}: {
  items: BarItem[];
  max?: number;
  className?: string;
}) {
  const top = max ?? Math.max(0, ...items.map((i) => i.value));
  return (
    <ul className={cn("grid gap-2", className)}>
      {items.map((item, index) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and labels are nodes
          key={index}
          title={item.title}
          className="grid grid-cols-[90px_minmax(0,1fr)_minmax(54px,auto)] items-center gap-3 text-[13px]"
        >
          <span className="truncate">{item.label}</span>
          <span aria-hidden className="h-2 bg-kumo-recessed">
            <span
              className="block h-full bg-kumo-ink transition-[width] duration-(--rh-dur-bar)"
              style={{ width: `${top > 0 ? Math.min(100, (item.value / top) * 100) : 0}%` }}
            />
          </span>
          <span className="text-right font-mono text-[12px] whitespace-nowrap tabular-nums">
            {item.text ?? formatNumber(item.value)}
          </span>
        </li>
      ))}
    </ul>
  );
}
BarList.displayName = "BarList";

/**
 * Cap meter (DESIGN.md 9.1, linear progress): 4px track, ink fill, `danger` once the cap is
 * reached, because a reached cap stops work. The value sits beside the label as text.
 */
export function CapMeter({
  label,
  value,
  cap,
  format = (n) => formatNumber(n),
  className,
}: {
  label: string;
  value: number;
  cap: number;
  format?: (n: number) => string;
  className?: string;
}) {
  const reached = cap > 0 && value >= cap;
  const pct = cap > 0 ? Math.min(100, (value / cap) * 100) : 0;
  return (
    <div className={cn("grid min-w-0 gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3 text-[12px]">
        <span className="text-kumo-subtle">{label}</span>
        <span className="font-mono tabular-nums">
          {format(value)} / {format(cap)}
          {reached && <span className="ml-2 font-semibold text-accent-700">Cap reached</span>}
        </span>
      </div>
      <meter className="sr-only" min={0} max={cap} value={value}>
        {format(value)}
      </meter>
      <div aria-hidden className="h-1 bg-kumo-recessed">
        <div
          className={cn(
            "h-full transition-[width] duration-(--rh-dur-bar)",
            reached ? "bg-kumo-danger" : "bg-kumo-ink",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
CapMeter.displayName = "CapMeter";
