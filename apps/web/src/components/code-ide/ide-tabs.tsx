import { cn } from "@cloudflare/kumo";
import { X } from "@phosphor-icons/react";
import { type IdeTab, isDirty } from "./model";

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;

/**
 * Open-file tabs of an edit session: the file name in mono, a square dot while the tab has
 * unsaved edits (and "unsaved" for screen readers), and a close button. A middle click on a tab
 * closes it too. The row scrolls sideways when the tabs do not fit; the page never does.
 */
export function IdeTabs({
  tabs,
  active,
  onSelect,
  onClose,
}: {
  tabs: IdeTab[];
  active: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  if (tabs.length === 0) return null;
  return (
    <div
      role="tablist"
      aria-label="Open files"
      className="flex min-h-9 shrink-0 overflow-x-auto overflow-y-hidden border-b border-kumo-rule"
    >
      {tabs.map((tab) => {
        const selected = tab.path === active;
        const dirty = isDirty(tab);
        return (
          <div
            key={tab.path}
            className={cn(
              "flex shrink-0 items-stretch border-r border-kumo-rule",
              selected
                ? "bg-kumo-base shadow-[inset_0_2px_0_var(--color-accent-500)]"
                : "hover:bg-kumo-row-hover",
            )}
          >
            <button
              type="button"
              role="tab"
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                onClose(tab.path);
              }}
              onMouseDown={(event) => {
                // A middle click must not start the browser's autoscroll.
                if (event.button === 1) event.preventDefault();
              }}
              aria-selected={selected}
              title={tab.path}
              onClick={() => onSelect(tab.path)}
              className={cn(
                "flex max-w-56 min-w-0 cursor-pointer items-center gap-1.5 pr-1 pl-3 font-mono text-[12px] focus-visible:outline-offset-[-2px] pointer-coarse:min-h-11",
                selected && "font-semibold",
              )}
            >
              <span className="min-w-0 truncate">{nameOf(tab.path)}</span>
              {dirty && (
                <>
                  <span aria-hidden className="size-1.5 shrink-0 bg-kumo-ink" />
                  <span className="sr-only">(unsaved)</span>
                </>
              )}
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.path}`}
              title={dirty ? `Close ${tab.path} (unsaved edits are dropped)` : `Close ${tab.path}`}
              onClick={() => onClose(tab.path)}
              className="flex min-w-6 cursor-pointer items-center justify-center px-1 text-kumo-subtle hover:text-kumo-default focus-visible:outline-offset-[-2px] pointer-coarse:min-w-11"
            >
              <X size={12} aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
IdeTabs.displayName = "IdeTabs";
