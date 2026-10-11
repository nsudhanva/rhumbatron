import { Button, cn } from "@cloudflare/kumo";
import { ArrowsIn, ArrowsOut } from "@phosphor-icons/react";
import { type ReactNode, Suspense, useId } from "react";
import { type PanelId, useFlightStore } from "./flight-store";

/**
 * Fixed-height frame around one Flight Control panel (DESIGN.md 6.2.3, 6.3): an h6 label row
 * (label, count or meta, expand button) above a 2px divider, then the panel body. The height is
 * fixed so a lazy panel or a loading panel never shifts the layout; wide content scrolls inside.
 * Focused, the frame fills the page below the Flight chrome and the other panels are hidden.
 */
export function PanelFrame({
  id,
  label,
  meta,
  focused,
  size = "default",
  className,
  children,
}: {
  id: PanelId;
  label: string;
  meta?: ReactNode;
  focused: boolean;
  /** `tall`: the Execution DAG. `hero`: the agent swimlanes, the main time view. */
  size?: "default" | "tall" | "hero";
  className?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  const setFocus = useFlightStore((s) => s.setFocus);
  return (
    <section
      aria-labelledby={headingId}
      data-panel={id}
      className={cn(
        "flex min-w-0 scroll-mt-[calc(var(--rh-flight-sticky,0px)+16px)] flex-col bg-kumo-elevated",
        focused
          ? "h-[max(480px,calc(100dvh-var(--rh-flight-chrome,220px)))] rule-ink"
          : size === "hero"
            ? "h-[clamp(480px,62vh,640px)]"
            : size === "tall"
              ? "h-[420px]"
              : "h-[360px]",
        className,
      )}
    >
      <div className="flex min-h-10 shrink-0 items-center justify-between gap-3 border-b-2 border-kumo-divider py-1 pr-1.5 pl-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h2 id={headingId} className="type-h6 truncate">
            {label}
          </h2>
          {meta && (
            <div className="flex min-w-0 items-center gap-2 truncate text-[12px] text-kumo-subtle">
              {meta}
            </div>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={focused ? <ArrowsIn size={16} aria-hidden /> : <ArrowsOut size={16} aria-hidden />}
          aria-label={focused ? `Collapse ${label}` : `Expand ${label}`}
          aria-pressed={focused}
          title={focused ? `Collapse ${label}` : `Expand ${label}`}
          onClick={() => setFocus(focused ? null : id)}
        />
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto">
        <Suspense fallback={<PanelSkeleton />}>{children}</Suspense>
      </div>
    </section>
  );
}
PanelFrame.displayName = "PanelFrame";

/** Same-height placeholder while a panel's code or first data loads: rows under real rules. */
export function PanelSkeleton({ rows = 7 }: { rows?: number }) {
  return (
    <div aria-hidden className="grid content-start gap-0 px-3 py-2">
      {Array.from({ length: rows }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
          key={i}
          className="flex items-center gap-3 border-b border-kumo-rule py-2.5"
        >
          <span className="size-2 shrink-0 animate-pulse bg-kumo-faint motion-reduce:animate-none" />
          <span
            className="h-[13px] animate-pulse bg-kumo-faint motion-reduce:animate-none"
            style={{ width: `${40 + ((i * 23) % 45)}%` }}
          />
        </div>
      ))}
    </div>
  );
}
PanelSkeleton.displayName = "PanelSkeleton";
