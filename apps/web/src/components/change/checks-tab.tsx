import { cn } from "@cloudflare/kumo";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { type CheckVerdict, isFinished, versionWord } from "../candidate/model";
import { StatusPill } from "../ui/status-pill";
import { CheckItem } from "./check-list";
import type { VersionView } from "./headline";

/**
 * The Checks tab (docs/ux/research-2026-10-09.md 7.4 tabs): every check of every version, with
 * filters. Same rows as the Checks step, so a row reads the same in both places.
 */

type Filter = "pass" | "fail" | "gap";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "pass", label: "Passed" },
  { value: "fail", label: "Failed" },
  { value: "gap", label: "Not run" },
];

const matches = (filter: Filter | null, verdict: CheckVerdict) =>
  filter === null || filter === verdict;

export function ChecksTab({ versions }: { versions: VersionView[] }) {
  const [filter, setFilter] = useState<Filter | null>(null);
  if (versions.length === 0) {
    return (
      <p className="text-[14px] text-kumo-subtle">
        No checks yet. They run once every task is done and a version is built.
      </p>
    );
  }
  const all = versions.flatMap((v) => v.rows);
  return (
    <div className="grid gap-4">
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">Show checks</legend>
        {FILTERS.map((f) => {
          const count = all.filter((r) => r.verdict === f.value).length;
          const on = filter === f.value;
          return (
            <button
              key={f.value}
              type="button"
              aria-pressed={on}
              onClick={() => setFilter(on ? null : f.value)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-[13px] tabular-nums transition-colors duration-150",
                on
                  ? "border-kumo-info bg-kumo-info-tint text-kumo-info"
                  : "border-kumo-rule hover:bg-kumo-row-hover",
              )}
            >
              {f.label} {count}
            </button>
          );
        })}
      </fieldset>
      {versions.map((v) => {
        const rows = v.rows.filter((r) => matches(filter, r.verdict));
        return (
          <section key={v.candidate.id} className="grid gap-2">
            <h3 className="flex flex-wrap items-center gap-2 text-[16px] font-semibold">
              {v.label}
              <StatusPill status={v.candidate.status} label={versionWord(v.candidate.status)} />
              <Link
                to="/candidates/$candidateId"
                params={{ candidateId: v.candidate.id }}
                className="ml-auto text-[13px] font-normal text-kumo-link hover:underline"
              >
                {v.label} details
              </Link>
            </h3>
            {rows.length === 0 ? (
              <p className="text-[13px] text-kumo-subtle">No checks match this filter.</p>
            ) : (
              <ul className="grid rounded-lg border border-kumo-rule px-3">
                {rows.map((row) => (
                  <CheckItem
                    key={row.checkId}
                    row={row}
                    candidate={v.candidate}
                    finished={isFinished(v.candidate)}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
ChecksTab.displayName = "ChecksTab";
