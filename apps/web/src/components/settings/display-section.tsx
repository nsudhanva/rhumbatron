import { cn } from "@cloudflare/kumo";
import { setViewMode, useViewMode, type ViewMode } from "../../lib/view-mode";
import { Section } from "../ui/page";

const VIEWS: { value: ViewMode; label: string; description: string }[] = [
  { value: "product", label: "Product", description: "Outcomes: what changed for the user." },
  {
    value: "systems",
    label: "Systems",
    description: "Adds queues, Durable Objects, model routes, Sandboxes and cost details.",
  },
];

/**
 * Display: the default Product View / Systems View (AGENTS.md 38.7), stored in this browser.
 * The header toggle on pages with a Systems view writes the same value.
 */
export function DisplaySection() {
  const view = useViewMode();
  const selected = VIEWS.find((v) => v.value === view) ?? VIEWS[0];
  return (
    <Section label="Display">
      <div className="grid gap-2">
        <fieldset className="grid gap-[5px]">
          <legend className="mb-[5px] text-[12px] text-kumo-default">Default view</legend>
          <div className="flex w-fit border border-kumo-divider">
            {VIEWS.map(({ value, label }, index) => {
              const on = view === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setViewMode(value)}
                  className={cn(
                    "flex h-7 items-center px-3 text-[13px] transition-colors duration-(--rh-dur-ui) focus-visible:outline-offset-[-2px] pointer-coarse:h-11",
                    index > 0 && "border-l border-kumo-divider",
                    on ? "bg-kumo-ink text-kumo-inverse" : "hover:bg-kumo-tint",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </fieldset>
        <p className="text-[12px] text-kumo-subtle">
          {selected?.description} Stored in this browser for every project. Pages with a Systems
          view (Events) also show the toggle in the header.
        </p>
      </div>
    </Section>
  );
}
DisplaySection.displayName = "DisplaySection";
