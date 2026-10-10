import { Input } from "@cloudflare/kumo";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import type { WorkspaceFileIndex } from "../../lib/api";
import { formatNumber } from "../../lib/format";
import { EmptyState } from "../ui/empty-state";
import { buildFileTree, defaultExpanded, flattenFileTree } from "./model";

/** Filter results shown at once; the count says how many matched. */
const MATCH_LIMIT = 200;

/**
 * Read-only browser of one canonical tree from its R2 file index (paths only). Directories open
 * and close in place; a filter switches to a flat list of matching paths. Rows use the tree-list
 * dress (DESIGN.md 9.11): mono 12px with box-drawing prefixes in `subtle`.
 */
export function FileBrowser({ index }: { index: WorkspaceFileIndex }) {
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
              {matches.slice(0, MATCH_LIMIT).map((path) => (
                <li key={path} className="truncate px-3" title={path}>
                  {path}
                </li>
              ))}
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
                    className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 px-3 text-left transition-colors duration-(--rh-dur-ui) hover:bg-kumo-row-hover focus-visible:outline-offset-[-2px] pointer-coarse:min-h-11"
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

function TreePrefix({ prefix }: { prefix: string }) {
  return (
    <span aria-hidden className="shrink-0 whitespace-pre text-kumo-subtle">
      {prefix}
    </span>
  );
}
