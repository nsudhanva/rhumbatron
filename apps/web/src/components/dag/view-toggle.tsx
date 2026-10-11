import { cn } from "@cloudflare/kumo";

export type DagMode = "list" | "graph";

/**
 * "List | Graph" segmented control (DESIGN.md 8.2): 1px divider frame, selected in ink with
 * inverse text. Both options are always available.
 */
export function ViewToggle({
  mode,
  onChange,
  label = "View",
}: {
  mode: DagMode;
  onChange: (mode: DagMode) => void;
  label?: string;
}) {
  const options: { value: DagMode; text: string }[] = [
    { value: "list", text: "List" },
    { value: "graph", text: "Graph" },
  ];
  return (
    <fieldset className="flex w-fit border border-kumo-divider">
      <legend className="sr-only">{label}</legend>
      {options.map(({ value, text }, index) => {
        const selected = mode === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(value)}
            className={cn(
              "flex h-8 items-center px-3 text-[13px] transition-colors duration-(--rh-dur-ui) focus-visible:outline-offset-[-2px] pointer-coarse:h-11",
              index > 0 && "border-l border-kumo-divider",
              selected ? "bg-kumo-ink text-kumo-inverse" : "hover:bg-kumo-tint",
            )}
          >
            {text}
          </button>
        );
      })}
    </fieldset>
  );
}
ViewToggle.displayName = "ViewToggle";
