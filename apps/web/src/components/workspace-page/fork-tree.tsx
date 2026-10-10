import { cn } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { EMPTY, formatNumber, generation } from "../../lib/format";
import { StatusPill } from "../ui/status-pill";
import { Tag } from "../ui/tag";
import type { ForkRow } from "./model";
import { shortSha } from "./model";

const MINUS = "−";

/** name · base · short hash · +adds −dels · state text · pill (DESIGN.md 9.11). */
const COLUMNS =
  "grid grid-cols-[minmax(180px,1.3fr)_64px_84px_112px_minmax(140px,1fr)_minmax(96px,auto)] items-center gap-x-3";

/** `+42 −3` with green and red counts. Missing values render as an em dash. */
export function AddsDels({
  adds,
  dels,
  title,
  className,
}: {
  adds: number | null;
  dels: number | null;
  title?: string | undefined;
  className?: string | undefined;
}) {
  if (adds === null && dels === null) {
    return <span className={cn("text-kumo-subtle", className)}>{EMPTY}</span>;
  }
  return (
    <span title={title} className={cn("whitespace-nowrap tabular-nums", className)}>
      <span className="text-kumo-success">+{formatNumber(adds ?? 0)}</span>{" "}
      <span className="text-kumo-danger">
        {MINUS}
        {formatNumber(dels ?? 0)}
      </span>
    </span>
  );
}
AddsDels.displayName = "AddsDels";

function TreeRowFrame({
  prefix,
  name,
  base,
  hash,
  stat,
  state,
  pill,
  strong,
}: {
  prefix: string;
  name: ReactNode;
  base: ReactNode;
  hash: ReactNode;
  stat: ReactNode;
  state: ReactNode;
  pill: ReactNode;
  strong?: boolean;
}) {
  return (
    <>
      <span className={cn("flex min-w-0 items-baseline", strong && "font-semibold")}>
        <span aria-hidden className="shrink-0 whitespace-pre text-kumo-subtle">
          {prefix}
        </span>
        <span className="min-w-0 truncate">{name}</span>
      </span>
      <span className="text-kumo-subtle tabular-nums">{base}</span>
      <span className="tabular-nums">{hash}</span>
      <span className="text-right">{stat}</span>
      <span className="min-w-0 truncate text-kumo-subtle">{state}</span>
      <span className="flex justify-end">{pill}</span>
    </>
  );
}

/**
 * Tree list of the live code (canonical Artifact) and its forks, shown behind "Show as tree" on
 * the Code page: mono 12px rows with box-drawing prefixes. Each fork row is a button; the whole
 * row is the target, and the selected row carries the faint fill and a 2px accent bar. Scrolls
 * sideways when narrow.
 */
export function ForkTree({
  root,
  rows,
  selectedKey,
  onSelect,
}: {
  root: { name: string; generation: number; hash: string | null };
  rows: ForkRow[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <div className="min-w-[760px] font-mono text-[12px]">
        <div
          aria-hidden
          className={cn(
            COLUMNS,
            "border-b border-kumo-rule px-2 pb-2 font-sans text-[12px] text-kumo-subtle",
          )}
        >
          <span>Repo</span>
          <span>Base</span>
          <span>Commit</span>
          <span className="text-right">Lines</span>
          <span>State</span>
          <span className="text-right">Status</span>
        </div>
        <ul aria-label="Live code and its copies">
          <li className={cn(COLUMNS, "border-b border-kumo-rule px-2 py-2")}>
            <TreeRowFrame
              strong
              prefix=""
              name={<span title={root.name}>{root.name}</span>}
              base={generation(root.generation)}
              hash={shortSha(root.hash) ?? <span className="text-kumo-subtle">{EMPTY}</span>}
              stat={<span className="text-kumo-subtle">{EMPTY}</span>}
              state="live code"
              pill={<Tag>Live</Tag>}
            />
          </li>
          {rows.map((row, index) => {
            const selected = row.key === selectedKey;
            const last = index === rows.length - 1;
            return (
              <li key={row.key} className="border-b border-kumo-rule">
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(row.key)}
                  className={cn(
                    COLUMNS,
                    "w-full cursor-pointer px-2 py-2 text-left transition-colors duration-150 hover:bg-kumo-row-hover focus-visible:outline-offset-[-2px]",
                    selected && "bg-kumo-faint shadow-[inset_2px_0_0_var(--color-accent-500)]",
                  )}
                >
                  <TreeRowFrame
                    strong={selected}
                    prefix={last ? "└─ " : "├─ "}
                    name={<span title={row.name}>{row.name}</span>}
                    base={generation(row.fork.baseGeneration)}
                    hash={shortSha(row.commit) ?? <span className="text-kumo-subtle">{EMPTY}</span>}
                    stat={
                      <AddsDels
                        adds={row.adds}
                        dels={row.dels}
                        {...(row.kind === "candidate"
                          ? {
                              title: row.complete
                                ? "Sum of the composed ChangeSets"
                                : "Sum of the composed ChangeSets that are listed here",
                            }
                          : {})}
                      />
                    }
                    state={<span title={row.state}>{row.state || EMPTY}</span>}
                    pill={
                      <StatusPill
                        status={row.status}
                        {...(row.kind === "workspace" && row.statusLabel
                          ? { label: row.statusLabel }
                          : {})}
                      />
                    }
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
ForkTree.displayName = "ForkTree";
