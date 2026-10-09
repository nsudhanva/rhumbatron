import { cn } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { type EntityRef, useFlightStore, useIsHighlighted } from "../../flight-store";
import { EntityHover } from "../../hover-preview";

/**
 * A button that stands for one entity: click selects it (panels toggle, inspectors navigate),
 * hover previews it, and the selection shows as faint ink with a 2px accent left bar
 * (DESIGN.md 10). 24px minimum target, 44px on coarse pointers.
 */
export function RefButton({
  entity,
  mode = "toggle",
  label,
  className,
  children,
}: {
  entity: EntityRef;
  /** `toggle` in panels (click again clears); `select` in inspectors (always navigates). */
  mode?: "toggle" | "select";
  /** Accessible name when the visible text is not enough. */
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  const { selected, hovered } = useIsHighlighted(entity);
  return (
    <EntityHover entity={entity}>
      <button
        type="button"
        aria-pressed={selected}
        aria-label={label}
        title={label}
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
      </button>
    </EntityHover>
  );
}
RefButton.displayName = "RefButton";
