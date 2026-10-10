import { cn } from "@cloudflare/kumo";
import type { WorkspaceChangeSet, WorkspaceFileStat } from "../../lib/api";
import { EMPTY, formatNumber } from "../../lib/format";
import { LogWell } from "../ui/log-well";
import { AddsDels } from "./fork-tree";
import { shortSha } from "./model";

const MINUS = "−";

/** Sign column: `+` only additions, `−` only removals, `±` both, `B` binary. */
function sign(stat: WorkspaceFileStat) {
  if (stat.binary) return { text: "B", className: "text-kumo-subtle" };
  if ((stat.adds ?? 0) > 0 && (stat.dels ?? 0) === 0)
    return { text: "+", className: "text-kumo-success" };
  if ((stat.dels ?? 0) > 0 && (stat.adds ?? 0) === 0)
    return { text: MINUS, className: "text-kumo-danger" };
  return { text: "±", className: "text-kumo-subtle" };
}

/** Fallback when `--stat` lines did not parse: the `--name-only` paths without counts. */
function statsOf(changeSet: WorkspaceChangeSet): WorkspaceFileStat[] {
  if (changeSet.fileStats.length > 0) return changeSet.fileStats;
  return changeSet.files.map((path) => ({
    path,
    changes: null,
    adds: null,
    dels: null,
    exact: true,
    binary: false,
  }));
}

/**
 * "Files changed" for one code change (ChangeSet): a header with the file count and `+N −M`,
 * then one row per changed file with an index gutter, sign column, path, and the file's
 * green/red counts with a proportional bar. The fork and commits sit in the header's tooltip.
 * Line-level hunks are not stored, so the raw `git diff --stat` is one click away instead.
 */
export function DiffSummary({ changeSet }: { changeSet: WorkspaceChangeSet }) {
  const stats = statsOf(changeSet);
  const widest = Math.max(1, ...stats.map((s) => s.changes ?? 0));
  const estimated = stats.some((s) => !s.exact);
  const digits = Math.max(2, String(stats.length).length);
  return (
    <div className="grid min-w-0 gap-3">
      <figure className="min-w-0 overflow-hidden rounded-lg border border-kumo-rule bg-kumo-base">
        <figcaption
          title={`${changeSet.fork} @ ${shortSha(changeSet.commit)} from ${shortSha(changeSet.baseCommit)}`}
          className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-kumo-rule px-3 py-2 text-[13px]"
        >
          <span className="font-semibold">
            {formatNumber(stats.length)} {stats.length === 1 ? "file" : "files"} changed
          </span>
          <AddsDels
            adds={changeSet.insertions}
            dels={changeSet.deletions}
            className="font-mono text-[12px]"
          />
        </figcaption>
        {stats.length === 0 ? (
          <p className="px-3 py-2 text-[12px] text-kumo-subtle">No files recorded.</p>
        ) : (
          <ol
            aria-label="Changed files"
            className="overflow-x-auto py-1 font-mono text-[12px] leading-[1.7]"
          >
            {stats.map((stat, index) => {
              const s = sign(stat);
              const adds = stat.adds ?? 0;
              const dels = stat.dels ?? 0;
              return (
                <li
                  key={stat.path}
                  className="grid min-w-[420px] grid-cols-[40px_16px_minmax(0,1fr)_auto_64px] items-center gap-x-1.5 pr-3"
                >
                  <span aria-hidden className="text-right text-kumo-subtle select-none">
                    {String(index + 1).padStart(digits, "0")}
                  </span>
                  <span aria-hidden className={cn("text-center", s.className)}>
                    {s.text}
                  </span>
                  <span className="min-w-0 truncate" title={stat.path}>
                    {stat.path}
                  </span>
                  <span className="text-right">
                    {stat.binary ? (
                      <span className="text-kumo-subtle">binary</span>
                    ) : stat.adds === null ? (
                      <span className="text-kumo-subtle">{EMPTY}</span>
                    ) : (
                      <AddsDels
                        adds={adds}
                        dels={dels}
                        {...(stat.exact
                          ? {}
                          : { title: "Split estimated from the scaled stat bar" })}
                        className={stat.exact ? undefined : "italic"}
                      />
                    )}
                  </span>
                  <span aria-hidden className="flex h-2 bg-kumo-recessed">
                    <span
                      className="h-full bg-kumo-success"
                      style={{ width: `${(adds / widest) * 100}%` }}
                    />
                    <span
                      className="h-full bg-kumo-danger"
                      style={{ width: `${(dels / widest) * 100}%` }}
                    />
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </figure>
      <p className="text-[12px] text-kumo-subtle">
        Totals are exact from git.
        {estimated && " Italic per-file counts are estimated from a scaled stat bar."} Line-by-line
        changes are not stored here; the saved commit holds them.
      </p>
      {changeSet.diffStat && (
        <details className="group">
          <summary className="w-fit cursor-pointer text-[12px] text-kumo-link">
            Raw diff stat
          </summary>
          <LogWell
            className="mt-2"
            title={`git diff --stat ${shortSha(changeSet.baseCommit)} ${shortSha(changeSet.commit)}`}
            lines={changeSet.diffStat}
            maxHeight={240}
          />
        </details>
      )}
    </div>
  );
}
DiffSummary.displayName = "DiffSummary";
