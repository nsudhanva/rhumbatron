import { cn } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { FAMILY_FILL, statusView } from "./status-pill";

const HEIGHT = { inline: "h-1", feature: "h-1.5", hero: "h-2.5" } as const;

/**
 * Linear progress and threshold meter (DESIGN.md 9.1). Every bar shows its value as text.
 *
 * - Without `threshold`: ink fill on a recessed track; `success` when complete, `danger` over max.
 * - With `threshold`: a 2px ink marker at the limit (4px above and below the track), fill in
 *   `success` under the limit and accent over it, and a mono scale row `0 · threshold N · max`.
 * - `alert` adds a soft-limit marker in `warning`, labelled in the scale row.
 *
 *   <ThresholdMeter label="p95" value={164} max={300} threshold={200} format={(n) => `${n} ms`} />
 *   <ThresholdMeter label="Budget" value={1.42} max={3} size="hero" format={formatUsd} />
 */
export function ThresholdMeter({
  value,
  max,
  threshold,
  alert,
  label,
  valueText,
  format = (n) => String(n),
  size = "feature",
  className,
}: {
  value: number;
  max: number;
  threshold?: number;
  alert?: number;
  label: ReactNode;
  /** Replaces the formatted value next to the label, for example `$1.42 / $3.00`. */
  valueText?: ReactNode;
  format?: (n: number) => string;
  size?: keyof typeof HEIGHT;
  className?: string;
}) {
  const pct = (n: number) => `${Math.min(100, Math.max(0, (n / max) * 100))}%`;
  const fill =
    threshold !== undefined
      ? value > threshold
        ? "bg-accent-500"
        : "bg-kumo-success"
      : value > max
        ? "bg-kumo-danger"
        : value >= max
          ? "bg-kumo-success"
          : "bg-kumo-ink";
  const text = format(value);
  return (
    <div className={cn("grid min-w-0 gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3 text-[12px]">
        <span className="text-kumo-subtle">{label}</span>
        <span className="font-mono tabular-nums">{valueText ?? text}</span>
      </div>
      {/* The native meter carries the semantics; the drawn bar below is decoration. */}
      <meter className="sr-only" min={0} max={max} value={value}>
        {text}
      </meter>
      <div aria-hidden className={cn("relative bg-kumo-recessed", HEIGHT[size])}>
        <div
          className={cn("h-full transition-[width] duration-(--rh-dur-bar)", fill)}
          style={{ width: pct(value) }}
        />
        {alert !== undefined && (
          <span
            aria-hidden
            className="absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 bg-kumo-warning"
            style={{ left: pct(alert) }}
          />
        )}
        {threshold !== undefined && (
          <span
            aria-hidden
            className="absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 bg-kumo-ink"
            style={{ left: pct(threshold) }}
          />
        )}
      </div>
      {threshold !== undefined && (
        <div className="flex justify-between gap-2 font-mono text-[10px] whitespace-nowrap text-kumo-subtle tabular-nums">
          <span>0</span>
          <span className="min-w-0 truncate">
            {alert !== undefined && `alert ${format(alert)} · `}threshold {format(threshold)}
          </span>
          <span>{format(max)}</span>
        </div>
      )}
    </div>
  );
}
ThresholdMeter.displayName = "ThresholdMeter";

export type Step = { label: string; status: string };

/**
 * Segmented step bar (DESIGN.md 9.1): N equal 8px segments with 2px gaps, each colored by the
 * family of its step status and titled with its label and status word. The mono count of done
 * steps sits on the left.
 *
 *   <SegmentedSteps steps={checks.map((c) => ({ label: c.checkId, status: c.status }))} />
 */
export function SegmentedSteps({
  steps,
  label = "Steps",
  className,
}: {
  steps: Step[];
  label?: string;
  className?: string;
}) {
  const views = steps.map((step) => ({ ...step, view: statusView(step.status) }));
  const done = views.filter((s) => s.view.family === "ok").length;
  return (
    <div className={cn("flex min-w-0 items-center gap-3", className)}>
      <span className="shrink-0 font-mono text-[12px] tabular-nums">
        {done} / {steps.length}
      </span>
      <ol aria-label={label} className="flex min-w-0 grow gap-0.5">
        {views.map((step, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional and labels may repeat
            key={index}
            title={`${step.label}: ${step.view.label}`}
            className={cn("h-2 min-w-1 flex-1", FAMILY_FILL[step.view.family])}
          >
            <span className="sr-only">
              {step.label}: {step.view.label}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
SegmentedSteps.displayName = "SegmentedSteps";
