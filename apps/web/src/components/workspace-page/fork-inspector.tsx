import { buttonVariants, cn } from "@cloudflare/kumo";
import { ArrowRight } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { EMPTY, formatAge, generation } from "../../lib/format";
import { EmptyState } from "../ui/empty-state";
import { KeyValue } from "../ui/key-value";
import { StatusPill } from "../ui/status-pill";
import { DiffSummary } from "./diff-summary";
import { AddsDels } from "./fork-tree";
import type { ForkRow } from "./model";

const time = (iso: string | null) =>
  iso ? (
    <time dateTime={iso} title={iso}>
      {formatAge(iso)}
    </time>
  ) : null;

/**
 * Detail of the selected fork, beside the tree (DESIGN.md 10: one selection per context, and the
 * inspector repeats it as text). A Task fork shows its ChangeSet diff summary; a Candidate fork
 * shows the ChangeSets it composes and links to the Candidate page.
 */
export function ForkInspector({
  row,
  rowsByKey,
  onSelect,
}: {
  row: ForkRow | undefined;
  rowsByKey: Map<string, ForkRow>;
  onSelect: (key: string) => void;
}) {
  if (!row) {
    return (
      <EmptyState what="No fork selected." how="Select a fork in the tree to see its changes." />
    );
  }

  if (row.kind === "workspace") {
    const { fork } = row;
    return (
      <div className="grid min-w-0 gap-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-[13px] font-semibold">{fork.fork}</span>
          <StatusPill
            status={row.status}
            {...(row.statusLabel ? { label: row.statusLabel } : {})}
          />
        </div>
        <KeyValue
          items={[
            { label: "Task", value: fork.taskTitle },
            { label: "Task key", value: fork.taskKey, mono: true },
            { label: "Run", value: fork.runId, mono: true },
            { label: "Base", value: generation(fork.baseGeneration), mono: true },
            { label: "ChangeSet", value: fork.changeSet?.id, mono: true },
            { label: "Started", value: time(fork.startedAt) },
            { label: "Ended", value: time(fork.endedAt) },
          ]}
        />
        {fork.changeSet ? (
          <DiffSummary changeSet={fork.changeSet} />
        ) : (
          <EmptyState
            what="No ChangeSet."
            how={
              fork.runStatus === "running"
                ? "The run is still editing this fork. The diff appears when it publishes."
                : fork.runStatus === "completed"
                  ? "The run finished without changing any file."
                  : "The run ended before it published a commit."
            }
          />
        )}
      </div>
    );
  }

  const { fork } = row;
  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[15px] font-extrabold">{row.label}</span>
        <span className="font-mono text-[12px] text-kumo-subtle">{fork.fork}</span>
        <StatusPill status={fork.status} />
      </div>
      {fork.statusReason && <p className="text-[13px]">{fork.statusReason}</p>}
      <KeyValue
        items={[
          { label: "Candidate", value: fork.id, mono: true },
          { label: "Base", value: generation(fork.baseGeneration), mono: true },
          { label: "Commit", value: fork.composedCommit, mono: true },
          { label: "Tree", value: fork.composedTree, mono: true },
          {
            label: "Promoted",
            value: fork.promotedGeneration === null ? null : generation(fork.promotedGeneration),
            mono: true,
          },
          { label: "Updated", value: time(fork.updatedAt) },
        ]}
      />
      <section className="grid gap-2" aria-label="Composed ChangeSets">
        <div className="flex items-baseline justify-between gap-3 border-b-2 border-kumo-divider pb-1.5">
          <h3 className="type-h6">Composes</h3>
          <AddsDels
            adds={row.adds}
            dels={row.dels}
            className="font-mono text-[12px]"
            title={
              row.complete
                ? "Sum of the composed ChangeSets"
                : "Sum of the composed ChangeSets that are listed here"
            }
          />
        </div>
        {fork.changeSetIds.length === 0 ? (
          <p className="text-[13px] text-kumo-subtle">
            No ChangeSets. This is the canonical baseline at {generation(fork.baseGeneration)}.
          </p>
        ) : (
          <ul className="grid">
            {fork.changeSetIds.map((id) => {
              const owner = row.composes
                .map((key) => rowsByKey.get(key))
                .find((r) => r?.kind === "workspace" && r.fork.changeSet?.id === id);
              return (
                <li key={id} className="border-b border-kumo-rule">
                  {owner ? (
                    <button
                      type="button"
                      onClick={() => onSelect(owner.key)}
                      className="flex w-full cursor-pointer items-baseline justify-between gap-3 py-1.5 text-left font-mono text-[12px] transition-colors duration-(--rh-dur-ui) hover:bg-kumo-row-hover focus-visible:outline-offset-[-2px]"
                    >
                      <span className="min-w-0 truncate">
                        {id} <span className="text-kumo-subtle">· {owner.name}</span>
                      </span>
                      <AddsDels adds={owner.adds} dels={owner.dels} />
                    </button>
                  ) : (
                    <span className="flex justify-between gap-3 py-1.5 font-mono text-[12px]">
                      <span className="min-w-0 truncate">{id}</span>
                      <span className="text-kumo-subtle">{EMPTY}</span>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <div>
        <Link
          to="/candidates/$candidateId"
          params={{ candidateId: fork.id }}
          className={cn(buttonVariants({ variant: "secondary" }), "gap-1.5")}
        >
          Open Candidate
          <ArrowRight size={16} aria-hidden />
        </Link>
      </div>
    </div>
  );
}
ForkInspector.displayName = "ForkInspector";
