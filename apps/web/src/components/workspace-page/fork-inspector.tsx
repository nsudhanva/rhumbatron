import { buttonVariants, cn } from "@cloudflare/kumo";
import { ArrowRight } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
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

function Heading({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-kumo-rule pb-1.5">
      <h3 className="text-[14px] font-semibold">{children}</h3>
      {meta}
    </div>
  );
}

/** Internal IDs and hashes, closed by default (spec rule 9). */
function TechnicalDetails({ children }: { children: ReactNode }) {
  return (
    <details>
      <summary className="w-fit cursor-pointer text-[13px] text-kumo-link">
        Technical details
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

/**
 * Detail of the selected working copy or version, beside the lists. A working copy (task fork)
 * shows its files changed; a version (Candidate fork) shows the tasks whose code it combines and
 * links to the version page. Internal IDs sit under "Technical details".
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
    return <EmptyState what="Nothing selected." how="Select a row to see its files changed." />;
  }

  if (row.kind === "workspace") {
    const { fork } = row;
    return (
      <div className="grid min-w-0 gap-4">
        <div className="grid gap-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[15px] font-semibold">
              {fork.taskTitle ?? fork.taskKey ?? "Task"}
            </span>
            <StatusPill
              status={row.status}
              {...(row.statusLabel ? { label: row.statusLabel } : {})}
            />
          </div>
          <p className="text-[13px] text-kumo-subtle">Working copy for one task.</p>
        </div>
        <KeyValue
          items={[
            { label: "Based on", value: generation(fork.baseGeneration) },
            { label: "Attempt", value: fork.attempt && fork.attempt > 1 ? fork.attempt : null },
            { label: "Started", value: time(fork.startedAt) },
            { label: "Ended", value: time(fork.endedAt) },
          ]}
        />
        <section className="grid gap-2" aria-label="Files changed">
          <Heading>Files changed</Heading>
          {fork.changeSet ? (
            <DiffSummary changeSet={fork.changeSet} />
          ) : (
            <EmptyState
              what="No files changed yet."
              how={
                fork.runStatus === "running"
                  ? "The agent is still editing. The files appear when it finishes."
                  : fork.runStatus === "completed"
                    ? "The agent finished without changing any file."
                    : "The agent stopped before it saved its work."
              }
            />
          )}
        </section>
        <TechnicalDetails>
          <KeyValue
            items={[
              { label: "Fork", value: fork.fork, mono: true },
              { label: "Task key", value: fork.taskKey, mono: true },
              { label: "Run", value: fork.runId, mono: true },
              { label: "ChangeSet", value: fork.changeSet?.id, mono: true },
              { label: "Commit", value: fork.changeSet?.commit, mono: true },
            ]}
          />
        </TechnicalDetails>
      </div>
    );
  }

  const { fork } = row;
  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-[15px] font-semibold">{row.label}</span>
          <StatusPill status={fork.status} />
        </div>
        {fork.statusReason && <p className="text-[13px]">{fork.statusReason}</p>}
      </div>
      <KeyValue
        items={[
          { label: "Based on", value: generation(fork.baseGeneration) },
          {
            label: "Shipped as",
            value: fork.promotedGeneration === null ? null : generation(fork.promotedGeneration),
          },
          { label: "Updated", value: time(fork.updatedAt) },
        ]}
      />
      <section className="grid gap-2" aria-label="Code it combines">
        <Heading
          meta={
            <AddsDels
              adds={row.adds}
              dels={row.dels}
              className="font-mono text-[12px]"
              title={
                row.complete
                  ? "Sum of the combined task changes"
                  : "Sum of the combined task changes that are listed here"
              }
            />
          }
        >
          Code from {fork.changeSetIds.length} {fork.changeSetIds.length === 1 ? "task" : "tasks"}
        </Heading>
        {fork.changeSetIds.length === 0 ? (
          <p className="text-[13px] text-kumo-subtle">
            No task code. This is {generation(fork.baseGeneration)} as it was, for comparison.
          </p>
        ) : (
          <ul className="grid">
            {fork.changeSetIds.map((id) => {
              const owner = row.composes
                .map((key) => rowsByKey.get(key))
                .find((r) => r?.kind === "workspace" && r.fork.changeSet?.id === id);
              const title =
                owner?.kind === "workspace"
                  ? (owner.fork.taskTitle ?? owner.fork.taskKey ?? owner.name)
                  : null;
              return (
                <li key={id} className="border-b border-kumo-rule">
                  {owner ? (
                    <button
                      type="button"
                      onClick={() => onSelect(owner.key)}
                      className="flex w-full cursor-pointer items-baseline justify-between gap-3 rounded-md px-1 py-1.5 text-left text-[13px] transition-colors duration-150 hover:bg-kumo-row-hover focus-visible:outline-offset-[-2px]"
                    >
                      <span className="min-w-0 truncate">{title}</span>
                      <AddsDels
                        adds={owner.adds}
                        dels={owner.dels}
                        className="font-mono text-[12px]"
                      />
                    </button>
                  ) : (
                    <span className="flex justify-between gap-3 px-1 py-1.5 text-[13px]">
                      <span className="min-w-0 truncate text-kumo-subtle">
                        A task outside the loaded changes
                      </span>
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
          Open {row.label}
          <ArrowRight size={16} aria-hidden />
        </Link>
      </div>
      <TechnicalDetails>
        <KeyValue
          items={[
            { label: "Candidate", value: fork.id, mono: true },
            { label: "Fork", value: fork.fork, mono: true },
            { label: "Commit", value: fork.composedCommit, mono: true },
            { label: "Tree", value: fork.composedTree, mono: true },
            { label: "ChangeSets", value: fork.changeSetIds.join(", "), mono: true },
          ]}
        />
      </TechnicalDetails>
    </div>
  );
}
ForkInspector.displayName = "ForkInspector";
