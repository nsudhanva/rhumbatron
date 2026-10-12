import { cn } from "@cloudflare/kumo";
import { setViewMode, useViewMode, type ViewMode } from "../../lib/view-mode";

const VIEWS: { value: ViewMode; label: string; title: string }[] = [
  { value: "product", label: "Product", title: "Product View: user outcomes" },
  {
    value: "systems",
    label: "Systems",
    title:
      "Systems View: K2 and Queue flow, Durable Object ownership, model routes, Sandboxes, cost",
  },
];

export const VIEW_MODE_HINT =
  "Product shows outcomes; Systems adds queues, Durable Objects, model routes.";

/**
 * "Product | Systems" segmented control of the Events page: 1px
 * divider frame, selected in ink. It writes the per-browser choice that Settings > Display sets
 * as the Events page default view.
 */
export function ViewModeToggle() {
  const view = useViewMode();
  return (
    <fieldset className="flex w-fit border border-kumo-divider" title={VIEW_MODE_HINT}>
      <legend className="sr-only">Events detail. {VIEW_MODE_HINT}</legend>
      {VIEWS.map(({ value, label, title }, index) => {
        const selected = view === value;
        return (
          <button
            key={value}
            type="button"
            title={title}
            aria-pressed={selected}
            onClick={() => setViewMode(value)}
            className={cn(
              "flex h-8 items-center px-3 text-[13px] transition-colors duration-(--rh-dur-ui) focus-visible:outline-offset-[-2px] pointer-coarse:h-11",
              index > 0 && "border-l border-kumo-divider",
              selected ? "bg-kumo-ink text-kumo-inverse" : "hover:bg-kumo-tint",
            )}
          >
            {label}
          </button>
        );
      })}
    </fieldset>
  );
}
ViewModeToggle.displayName = "ViewModeToggle";
