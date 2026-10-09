import { cn } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { type EntityRef, useFlightStore, useIsHighlighted } from "../../flight-store";
import { EntityHover } from "../../hover-preview";

/**
 * A button that stands for one entity: click selects it (panels toggle, inspectors navigate),
 * hover previews it, and the selection shows as faint ink with a 2px accent left bar
 * (DESIGN.md 10). 24px minimum target, 44px on coarse pointers.
 *
 * The accessible name is the visible text, then `context` for screen readers only, so the name
 * always starts with what is on screen (WCAG 2.5.3 label in name). `title` is the tooltip.
 */
export function RefButton({
  entity,
  mode = "toggle",
  context,
  title,
  className,
  children,
}: {
  entity: EntityRef;
  /** `toggle` in panels (click again clears); `select` in inspectors (always navigates). */
  mode?: "toggle" | "select";
  /** Screen-reader-only words after the visible text, when the visible text is not enough. */
  context?: string;
  /** Tooltip. */
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const { selected, hovered } = useIsHighlighted(entity);
  return (
    <EntityHover entity={entity}>
      <button
        type="button"
        aria-pressed={selected}
        title={title}
        onClick={() => {
          const store = useFlightStore.getState();
          if (mode === "toggle") store.toggle(entity);
          else store.select(entity);
        }}
        className={cn(
          "min-h-6 min-w-6 text-left hover:bg-kumo-faint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 pointer-coarse:min-h-11",
          (selected || hovered) && "bg-kumo-faint",
          selected && "shadow-[inset_2px_0_0_var(--color-accent-500)]",
          className,
        )}
      >
        {children}
        {context && <span className="sr-only">, {context}</span>}
      </button>
    </EntityHover>
  );
}
RefButton.displayName = "RefButton";
