import { CommandPalette as Palette } from "@cloudflare/kumo";
import { useMemo, useState } from "react";
import { matchPaths } from "./model";

/** Paths listed at once; the filter narrows the rest. */
const LIMIT = 50;

type FileItem = { path: string };
type Group = { id: string; label: string; items: FileItem[] };

let layer: HTMLDivElement | null = null;

/** A portal layer above the page shell (the same pattern as the Flight command palette). */
function paletteLayer(): HTMLDivElement | null {
  if (typeof document === "undefined") return null;
  if (!layer?.isConnected) {
    layer = document.createElement("div");
    layer.className = "relative z-50";
    document.body.appendChild(layer);
  }
  return layer;
}

/**
 * Quick open (Cmd/Ctrl+P in an edit session): a filter list of the session's files on Kumo's
 * CommandPalette (Base UI Dialog + Autocomplete), so focus trap, Escape, arrows and Enter come
 * from Kumo. Every query word must appear in the path; shorter paths list first.
 */
export function QuickOpen({
  open,
  onOpenChange,
  paths,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paths: string[];
  onPick: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo<Group[]>(() => {
    if (!open) return [];
    const items = matchPaths(paths, query, LIMIT).map((path) => ({ path }));
    return items.length > 0 ? [{ id: "files", label: "Files", items }] : [];
  }, [open, paths, query]);

  const pick = (item: FileItem) => {
    onPick(item.path);
    onOpenChange(false);
    setQuery("");
  };

  return (
    <Palette.Root
      container={paletteLayer()}
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery("");
      }}
      items={groups}
      value={query}
      onValueChange={setQuery}
      itemToStringValue={(group: Group) => group.label}
      getSelectableItems={(gs: Group[]) => gs.flatMap((g) => g.items)}
      onSelect={(item: FileItem) => pick(item)}
    >
      <Palette.Input placeholder="Open a file by path" aria-label="Open a file by path" />
      <Palette.List>
        <Palette.Results>
          {(group: Group) => (
            <Palette.Group key={group.id} items={group.items}>
              <Palette.GroupLabel className="mb-1 pt-2 text-[11px] font-normal tracking-[0.08em] uppercase">
                {group.label}
              </Palette.GroupLabel>
              <Palette.Items>
                {(item: FileItem) => (
                  <Palette.Item
                    key={item.path}
                    value={item}
                    onClick={() => pick(item)}
                    className="min-h-8 rounded-none py-1 font-mono text-[12px] data-[highlighted]:bg-kumo-faint data-[highlighted]:shadow-[inset_2px_0_0_var(--color-accent-500)]"
                  >
                    <span className="min-w-0 flex-1 truncate" title={item.path}>
                      {item.path}
                    </span>
                  </Palette.Item>
                )}
              </Palette.Items>
            </Palette.Group>
          )}
        </Palette.Results>
        <Palette.Empty>No file path matches.</Palette.Empty>
      </Palette.List>
      <Palette.Footer>
        <span className="flex items-center gap-3 font-mono text-[11px]">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>Esc close</span>
        </span>
        <span className="font-mono text-[11px]">⌘P / Ctrl P</span>
      </Palette.Footer>
    </Palette.Root>
  );
}
QuickOpen.displayName = "QuickOpen";
