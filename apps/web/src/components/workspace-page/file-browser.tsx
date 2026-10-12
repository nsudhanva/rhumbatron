import { cn, Input } from "@cloudflare/kumo";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { type ReactNode, useMemo, useState } from "react";
import type { WorkspaceFileIndex } from "../../lib/api";
import { formatNumber } from "../../lib/format";
import { EmptyState } from "../ui/empty-state";
import { buildFileTree, defaultExpanded, flattenFileTree } from "./model";

/** Filter results shown at once; the count says how many matched. */
const MATCH_LIMIT = 200;

/**
 * Read-only browser of one canonical tree from its R2 file index (paths only). Directories open
 * and close in place; a filter switches to a flat list of matching paths. Rows use the tree-list
 * dress: mono 12px with box-drawing prefixes in `subtle`.
 */
export function FileBrowser({
  index,
  onOpen,
  selected,
}: {
  index: WorkspaceFileIndex;
  /** Makes files openable (Code page). Without it, file rows are plain text as before. */
  onOpen?: (path: string) => void;
  selected?: string | undefined;
}) {
  const root = useMemo(() => buildFileTree(index.files), [index.files]);
  const [expanded, setExpanded] = useState(() => defaultExpanded(root));
  const [filter, setFilter] = useState("");
  const rows = useMemo(() => flattenFileTree(root, expanded), [root, expanded]);
  const query = filter.trim().toLowerCase();
  const matches = useMemo(
    () => (query ? index.files.filter((p) => p.toLowerCase().includes(query)) : []),
    [index.files, query],
  );

  const toggle = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  if (!index.indexed) {
    return (
      <EmptyState
        what="No file index for this tree yet."
        how="The integration Worker writes it when the canonical commit lands on main."
      />
    );
  }
  if (index.files.length === 0) {
    return <EmptyState what="The canonical tree has no files." />;
  }

  return (
    <div className="grid min-w-0 gap-3">
      <div className="max-w-80">
        <Input
          label="Filter paths"
          className="font-mono"
          placeholder="src/wishlist"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="min-w-0 overflow-auto rule-ink bg-kumo-elevated" style={{ maxHeight: 420 }}>
        {query ? (
          <>
            <p
              role="status"
              className="border-b border-kumo-rule px-3 py-1.5 font-mono text-[10px] text-kumo-subtle"
            >
              {formatNumber(matches.length)} of {formatNumber(index.files.length)} paths match
              {matches.length > MATCH_LIMIT ? ` · first ${formatNumber(MATCH_LIMIT)} shown` : ""}
            </p>
            <ul aria-label="Matching files" className="py-1 font-mono text-[12px] leading-[1.7]">
              {matches.slice(0, MATCH_LIMIT).map((path) =>
                onOpen ? (
                  <li key={path}>
                    <OpenButton path={path} selected={path === selected} onOpen={onOpen}>
                      <span className="min-w-0 truncate">{path}</span>
                    </OpenButton>
                  </li>
                ) : (
                  <li key={path} className="truncate px-3" title={path}>
                    {path}
                  </li>
                ),
              )}
            </ul>
          </>
        ) : (
          <ul aria-label="Canonical files" className="py-1 font-mono text-[12px] leading-[1.7]">
            {rows.map((row) => (
              <li key={row.path}>
                {row.isDir ? (
                  <button
                    type="button"
                    aria-expanded={row.expanded}
                    onClick={() => toggle(row.path)}
                    className="flex min-h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 px-3 text-left transition-colors duration-(--rh-dur-ui) hover:bg-kumo-row-hover focus-visible:outline-offset-[-2px] pointer-coarse:min-h-11"
                  >
                    <TreePrefix prefix={row.prefix} />
                    {row.expanded ? (
                      <CaretDown size={12} aria-hidden className="shrink-0" />
                    ) : (
                      <CaretRight size={12} aria-hidden className="shrink-0" />
                    )}
                    <span className="min-w-0 truncate font-semibold">{row.name}/</span>
                    <span className="ml-auto shrink-0 pl-3 text-kumo-subtle tabular-nums">
                      {formatNumber(row.files)} {row.files === 1 ? "file" : "files"}
                    </span>
                  </button>
                ) : onOpen ? (
                  <OpenButton path={row.path} selected={row.path === selected} onOpen={onOpen}>
                    <TreePrefix prefix={row.prefix} />
                    <span className="min-w-0 truncate">{row.name}</span>
                  </OpenButton>
                ) : (
                  <span className="flex min-w-0 items-center gap-1.5 px-3" title={row.path}>
                    <TreePrefix prefix={row.prefix} />
                    <span className="min-w-0 truncate">{row.name}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
FileBrowser.displayName = "FileBrowser";

/** An openable file row: the tree-list dress with the selected-row fill and accent bar. */
function OpenButton({
  path,
  selected,
  onOpen,
  children,
}: {
  path: string;
  selected: boolean;
  onOpen: (path: string) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={path}
      aria-current={selected || undefined}
      onClick={() => onOpen(path)}
      className={cn(
        "flex min-h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 px-3 text-left transition-colors duration-(--rh-dur-ui) hover:bg-kumo-row-hover focus-visible:outline-offset-[-2px] pointer-coarse:min-h-11",
        selected && "bg-kumo-faint font-semibold shadow-[inset_2px_0_0_var(--color-accent-500)]",
      )}
    >
      {children}
    </button>
  );
}

function TreePrefix({ prefix }: { prefix: string }) {
  return (
    <span aria-hidden className="shrink-0 whitespace-pre text-kumo-subtle">
      {prefix}
    </span>
  );
}
