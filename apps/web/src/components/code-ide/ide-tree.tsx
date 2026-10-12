import { Button, cn, Input } from "@cloudflare/kumo";
import { CaretDown, CaretRight, FilePlus, PencilSimple, Trash } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type { CodeSessionFile } from "../../lib/api-code-session";
import { formatNumber } from "../../lib/format";
import { buildFileTree, defaultExpanded, flattenFileTree } from "../workspace-page/model";
import { dirOf, parentDirs, pathProblem } from "./model";

type Mode = { kind: "new" | "rename" | "delete"; value: string } | null;

/**
 * File tree of an edit session (DESIGN.md 9.11 tree-list dress): mono 12px rows with box-drawing
 * prefixes, a changed marker (square accent dot and the word in the row's name) on each file
 * that differs from the base, and New file / Rename / Delete in a toolbar that acts on the
 * selected file. Forms open inline under the toolbar; errors show next to the field.
 */
export function IdeTree({
  files,
  selected,
  onOpen,
  onCreate,
  onRename,
  onDelete,
}: {
  files: CodeSessionFile[];
  selected: string | null;
  onOpen: (path: string) => void;
  /** Resolve to an error message, or null when it worked. */
  onCreate: (path: string) => Promise<string | null>;
  onRename: (from: string, to: string) => Promise<string | null>;
  onDelete: (path: string) => Promise<string | null>;
}) {
  const paths = useMemo(() => files.map((f) => f.path), [files]);
  const changed = useMemo(
    () => new Set(files.filter((f) => f.changed).map((f) => f.path)),
    [files],
  );
  const root = useMemo(() => buildFileTree(paths), [paths]);
  const [expanded, setExpanded] = useState(() => defaultExpanded(root));
  const rows = useMemo(() => flattenFileTree(root, expanded), [root, expanded]);
  const [mode, setMode] = useState<Mode>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedIsFile = !!selected && paths.includes(selected);

  // The selected file's folders open, so a file opened from quick open or created shows.
  useEffect(() => {
    if (!selected) return;
    const dirs = parentDirs(selected);
    if (dirs.every((d) => expanded.has(d))) return;
    setExpanded((current) => new Set([...current, ...dirs]));
  }, [selected, expanded]);

  const toggle = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const start = (kind: "new" | "rename" | "delete") => {
    setError(null);
    setMode({ kind, value: kind === "new" ? dirOf(selected) : (selected ?? "") });
  };

  const submit = async () => {
    if (!mode || busy) return;
    const value = mode.value.trim();
    if (mode.kind !== "delete") {
      const problem = pathProblem(value);
      if (problem) return setError(problem);
      if (paths.includes(value) && value !== selected) return setError(`${value} exists already.`);
    }
    setBusy(true);
    const result =
      mode.kind === "new"
        ? await onCreate(value)
        : mode.kind === "rename"
          ? value === selected
            ? null
            : await onRename(selected ?? "", value)
          : await onDelete(selected ?? "");
    setBusy(false);
    if (result) return setError(result);
    setMode(null);
    setError(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b border-kumo-rule py-1 pr-1 pl-3">
        <span className="type-label text-kumo-subtle">
          Files <span className="font-mono tabular-nums">{formatNumber(files.length)}</span>
        </span>
        <span className="flex items-center gap-0.5">
          <Button
            size="sm"
            variant="ghost"
            shape="square"
            icon={<FilePlus size={16} aria-hidden />}
            aria-label="New file"
            title="New file"
            onClick={() => start("new")}
          />
          <Button
            size="sm"
            variant="ghost"
            shape="square"
            icon={<PencilSimple size={16} aria-hidden />}
            aria-label="Rename the selected file"
            title={selectedIsFile ? `Rename ${selected}` : "Open a file to rename it"}
            disabled={!selectedIsFile}
            onClick={() => start("rename")}
          />
          <Button
            size="sm"
            variant="ghost"
            shape="square"
            icon={<Trash size={16} aria-hidden />}
            aria-label="Delete the selected file"
            title={selectedIsFile ? `Delete ${selected}` : "Open a file to delete it"}
            disabled={!selectedIsFile}
            onClick={() => start("delete")}
          />
        </span>
      </div>

      {mode && (
        <form
          className="grid shrink-0 gap-2 border-b border-kumo-rule bg-kumo-base px-3 py-2"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setMode(null);
              setError(null);
            }
          }}
        >
          {mode.kind === "delete" ? (
            <p className="text-[13px]">
              Delete <span className="font-mono break-all">{selected}</span>? You can submit the
              deletion or discard the session.
            </p>
          ) : (
            <Input
              label={mode.kind === "new" ? "New file path" : "New path"}
              className="font-mono"
              autoFocus
              value={mode.value}
              placeholder="src/new-file.ts"
              {...(error ? { error } : {})}
              onChange={(event) => {
                setMode({ ...mode, value: event.target.value });
                setError(null);
              }}
            />
          )}
          {mode.kind === "delete" && error && (
            <p role="alert" className="text-[12px] text-kumo-danger">
              {error}
            </p>
          )}
          <span className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="xs"
              variant={mode.kind === "delete" ? "destructive" : "secondary"}
              loading={busy}
            >
              {mode.kind === "new" ? "Create" : mode.kind === "rename" ? "Rename" : "Delete"}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                setMode(null);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </span>
        </form>
      )}

      <ul
        aria-label="Session files"
        className="min-h-0 flex-1 overflow-auto py-1 font-mono text-[12px] leading-[1.7]"
      >
        {rows.length === 0 && (
          <li className="px-3 py-2 font-sans text-[13px] text-kumo-subtle">
            No files yet. Create one with New file.
          </li>
        )}
        {rows.map((row) => (
          <li key={row.path}>
            {row.isDir ? (
              <button
                type="button"
                aria-expanded={row.expanded}
                onClick={() => toggle(row.path)}
                className="flex min-h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 px-3 text-left transition-colors duration-(--rh-dur-ui) hover:bg-kumo-row-hover focus-visible:outline-offset-[-2px] pointer-coarse:min-h-11"
              >
                <Prefix prefix={row.prefix} />
                {row.expanded ? (
                  <CaretDown size={12} aria-hidden className="shrink-0" />
                ) : (
                  <CaretRight size={12} aria-hidden className="shrink-0" />
                )}
                <span className="min-w-0 truncate font-semibold">{row.name}/</span>
              </button>
            ) : (
              <button
                type="button"
                title={changed.has(row.path) ? `${row.path} (changed)` : row.path}
                aria-current={row.path === selected || undefined}
                onClick={() => onOpen(row.path)}
                className={cn(
                  "flex min-h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 px-3 text-left transition-colors duration-(--rh-dur-ui) hover:bg-kumo-row-hover focus-visible:outline-offset-[-2px] pointer-coarse:min-h-11",
                  row.path === selected &&
                    "bg-kumo-faint font-semibold shadow-[inset_2px_0_0_var(--color-accent-500)]",
                )}
              >
                <Prefix prefix={row.prefix} />
                <span className="min-w-0 truncate">{row.name}</span>
                {changed.has(row.path) && (
                  <span className="ml-auto flex shrink-0 items-center gap-1 pl-2 text-[11px] text-kumo-subtle">
                    <span aria-hidden className="size-1.5 bg-kumo-brand" />
                    <span aria-hidden>M</span>
                    <span className="sr-only">changed</span>
                  </span>
                )}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
IdeTree.displayName = "IdeTree";

function Prefix({ prefix }: { prefix: string }) {
  return (
    <span aria-hidden className="shrink-0 whitespace-pre text-kumo-subtle">
      {prefix}
    </span>
  );
}
