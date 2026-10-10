import { Collapsible } from "@cloudflare/kumo";
import { CaretRight } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import {
  type ChangeSetAttribution,
  getCandidateDiff,
  getChangeSetDiff,
  listChangeSets,
} from "../../lib/api";
import { formatNumber } from "../../lib/format";
import { SectionError, SkeletonBar } from "../project/feedback";
import { EmptyState } from "../ui/empty-state";
import { Mono } from "../ui/mono";
import { Section } from "../ui/page";
import { DiffFiles } from "./diff-files";

const NO_PATCH = "No diff recorded for this ChangeSet.";
const OLDER = "ChangeSets published before diffs were stored keep only their file list.";

function Loading() {
  return (
    <div className="grid gap-2 py-2" aria-busy>
      <SkeletonBar height={12} className="w-2/3" />
      <SkeletonBar height={12} className="w-1/2" />
    </div>
  );
}

/** One ChangeSet's stored diff, fetched when its row opens. */
function ChangeSetDiff({ changeSet }: { changeSet: ChangeSetAttribution }) {
  const diff = useQuery({
    queryKey: ["changeset-diff", changeSet.id],
    queryFn: () => getChangeSetDiff({ data: changeSet.id }),
    enabled: changeSet.patchRecorded,
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (!changeSet.patchRecorded) return <EmptyState what={NO_PATCH} how={OLDER} />;
  if (diff.isError) {
    return (
      <SectionError
        message={`The diff could not load. ${diff.error.message}`}
        onRetry={() => diff.refetch()}
        retrying={diff.isFetching}
      />
    );
  }
  if (!diff.data) return <Loading />;
  return <DiffFiles diff={diff.data.diff} changeSets={[changeSet]} emptyHow={NO_PATCH} />;
}

/**
 * Files changed on the Change page (P16-18): each ChangeSet with its agent, Task and Intent
 * summary; its per-file diff opens in place.
 */
export function ChangeFilesChanged({ changeId }: { changeId: string }) {
  const sets = useQuery({
    queryKey: ["changesets", changeId],
    queryFn: () => listChangeSets({ data: changeId }),
  });
  return (
    <Section
      label="Files changed"
      meta={
        sets.data && (
          <Mono subtle>
            {formatNumber(sets.data.length)} {sets.data.length === 1 ? "ChangeSet" : "ChangeSets"}
          </Mono>
        )
      }
    >
      {sets.isError ? (
        <SectionError
          message={`ChangeSets could not load. ${sets.error.message}`}
          onRetry={() => sets.refetch()}
          retrying={sets.isFetching}
        />
      ) : !sets.data ? (
        <Loading />
      ) : sets.data.length === 0 ? (
        <EmptyState
          what="No ChangeSets yet."
          how="A ChangeSet appears when an agent publishes its code changes."
        />
      ) : (
        <div className="min-w-0 border-t border-kumo-rule">
          {sets.data.map((set) => (
            <Collapsible.Root key={set.id} className="border-b border-kumo-rule">
              <Collapsible.Trigger className="group grid w-full cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto] items-baseline gap-x-2 py-2 text-left text-[13px] transition-colors duration-(--rh-dur-ui) hover:bg-kumo-row-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500">
                <CaretRight
                  size={14}
                  aria-hidden
                  className="self-center text-kumo-subtle transition-transform duration-(--rh-dur-ui) group-data-[panel-open]:rotate-90"
                />
                <span className="grid min-w-0 gap-0.5">
                  <span className="min-w-0 truncate font-semibold">
                    {set.summary || set.taskTitle || set.id}
                  </span>
                  <span className="flex min-w-0 flex-wrap gap-x-2 font-mono text-[12px] text-kumo-subtle">
                    <span>
                      {set.agentRole ?? "agent"} {set.agentId}
                    </span>
                    {set.taskKey && <span>· {set.taskKey}</span>}
                    <span>· {set.id}</span>
                  </span>
                </span>
                <Mono subtle>
                  {formatNumber(set.files.length)} {set.files.length === 1 ? "file" : "files"}
                </Mono>
              </Collapsible.Trigger>
              <Collapsible.Panel className="pb-3 pl-6">
                <ChangeSetDiff changeSet={set} />
              </Collapsible.Panel>
            </Collapsible.Root>
          ))}
        </div>
      )}
    </Section>
  );
}
ChangeFilesChanged.displayName = "ChangeFilesChanged";

/** Files changed on the Candidate page: the composed diff against the base generation. */
export function CandidateFilesChanged({ candidateId }: { candidateId: string }) {
  const diff = useQuery({
    queryKey: ["candidate-diff", candidateId],
    queryFn: () => getCandidateDiff({ data: candidateId }),
  });
  return (
    <Section label="Files changed">
      {diff.isError ? (
        <SectionError
          message={`The diff could not load. ${diff.error.message}`}
          onRetry={() => diff.refetch()}
          retrying={diff.isFetching}
        />
      ) : !diff.data ? (
        <Loading />
      ) : (
        <DiffFiles
          diff={diff.data.diff}
          changeSets={diff.data.changeSets}
          emptyHow="The diff is stored when the Candidate composes; Candidates composed earlier have none."
        />
      )}
    </Section>
  );
}
CandidateFilesChanged.displayName = "CandidateFilesChanged";
