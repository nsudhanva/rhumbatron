import { Show } from "@clerk/tanstack-react-start";
import { Button, buttonVariants } from "@cloudflare/kumo";
import { useQueries, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Banner } from "../components/candidate/banner";
import {
  type ComparedCandidate,
  ComparisonMatrix,
} from "../components/candidate/comparison-matrix";
import { candidateLabels, checkRows, isActive } from "../components/candidate/model";
import { CandidateSkeleton } from "../components/candidate/skeleton";
import { EmptyState } from "../components/ui/empty-state";
import { Mono } from "../components/ui/mono";
import { Page, PageTitle, Section } from "../components/ui/page";
import { StatusPill } from "../components/ui/status-pill";
import { getChange, listCandidateEvidence, listCandidates } from "../lib/api";
import { changeLabel, formatNumber, generation, timeAgo } from "../lib/format";
import { loadChange, loadOnServer, prefetch } from "../lib/ssr-data";

/**
 * Candidate comparison for one Change. Shows every
 * Candidate against the same criteria so a reader sees in under a minute which future the
 * Evidence selects and why.
 */
export const Route = createFileRoute("/compare/$changeId")({
  // Server render: the title and the Evidence matrix are in the first HTML (lib/ssr-data.ts).
  // Same keys and server functions as the queries below.
  loader: ({ context: { queryClient }, params: { changeId } }) =>
    loadOnServer(queryClient, () =>
      Promise.allSettled([
        loadChange(queryClient, changeId),
        queryClient
          .ensureQueryData({
            queryKey: ["candidates", changeId],
            queryFn: () => listCandidates({ data: changeId }),
          })
          .then((candidates) =>
            Promise.all(
              candidates.map((c) =>
                prefetch(queryClient, ["candidate-evidence", c.id], () =>
                  listCandidateEvidence({ data: c.id }),
                ),
              ),
            ),
          ),
      ]),
    ),
  component: ComparePage,
});

const POLL_MS = 10_000;

function ComparePage() {
  return (
    <Page>
      <Show when="signed-in">
        <CompareView />
      </Show>
      <Show when="signed-out">
        <EmptyState
          what="Sign in to compare Candidates."
          how="Candidates belong to a Project you are a member of."
        />
      </Show>
    </Page>
  );
}

function CompareView() {
  const { changeId } = Route.useParams();
  const change = useQuery({
    queryKey: ["change", changeId],
    queryFn: () => getChange({ data: changeId }),
  });
  const candidates = useQuery({
    queryKey: ["candidates", changeId],
    queryFn: () => listCandidates({ data: changeId }),
    refetchInterval: (query) =>
      !query.state.data || query.state.data.some(isActive) ? POLL_MS : false,
  });
  const list = candidates.data ?? [];
  const evidence = useQueries({
    queries: list.map((c) => ({
      queryKey: ["candidate-evidence", c.id],
      queryFn: () => listCandidateEvidence({ data: c.id }),
      refetchInterval: isActive(c) ? POLL_MS : (false as const),
    })),
  });

  const title = (
    <PageTitle
      size="detail"
      kicker="Compare Candidates"
      title={change.data ? changeLabel(change.data) : "Candidate futures"}
      meta={
        <>
          <Mono>{changeId}</Mono>
          {change.data && (
            <span>
              base <Mono>{generation(change.data.baseGeneration)}</Mono>
            </span>
          )}
          {candidates.data && <span>{formatNumber(list.length)} Candidates</span>}
        </>
      }
      actions={
        <Link
          to="/changes/$changeId"
          params={{ changeId }}
          className={buttonVariants({ variant: "secondary" })}
        >
          Open the Change
        </Link>
      }
    />
  );

  if (!candidates.data) {
    if (candidates.isError) {
      return (
        <>
          {title}
          <Banner
            family="danger"
            title="Candidates did not load"
            action={
              <Button
                size="sm"
                variant="secondary"
                className="ring-current"
                onClick={() => candidates.refetch()}
              >
                Retry
              </Button>
            }
          >
            {candidates.error.message}
          </Banner>
        </>
      );
    }
    return <CandidateSkeleton label="Loading Candidates" rows={8} />;
  }

  const only = list.length === 1 ? list[0] : undefined;
  if (only) {
    const projectId = change.data?.projectId;
    return (
      <>
        {title}
        <Section label="Comparison">
          <EmptyState
            what="This change produced one candidate, so there is nothing to compare."
            how="A second Candidate appears when a design conflict forks the Change or another Candidate is composed."
            action={
              <div className="flex flex-wrap gap-2">
                <Link
                  to="/candidates/$candidateId"
                  params={{ candidateId: only.id }}
                  className={buttonVariants({ variant: "secondary" })}
                >
                  Open the Candidate
                </Link>
                {projectId && (
                  <Link
                    to="/projects/$projectId/verification"
                    params={{ projectId }}
                    className={buttonVariants({ variant: "secondary" })}
                  >
                    All Candidates of the Project
                  </Link>
                )}
              </div>
            }
          />
        </Section>
      </>
    );
  }

  if (list.length === 0) {
    return (
      <>
        {title}
        <Section label="Comparison">
          <EmptyState
            what="This Change has no Candidates yet, so there is nothing to compare."
            how="A second Candidate appears when a design conflict forks the Change or another Candidate is composed."
            action={
              <Link
                to="/changes/$changeId"
                params={{ changeId }}
                className={buttonVariants({ variant: "secondary" })}
              >
                Back to the Change
              </Link>
            }
          />
        </Section>
      </>
    );
  }

  const labels = candidateLabels(list);
  const items: ComparedCandidate[] = list.map((candidate, index) => {
    const records = evidence[index]?.data ?? [];
    return {
      candidate,
      label: labels.get(candidate.id) ?? candidate.id,
      rows: checkRows(candidate, records),
      evidenceCount: records.length,
    };
  });
  const evidenceLoading = evidence.some((q) => q.isPending);
  const failed = evidence.some((q) => q.isError) || candidates.isError;
  const verifying = list.filter(isActive).length;

  return (
    <>
      {title}
      {verifying > 0 && (
        <Banner
          family="progress"
          title={`${formatNumber(verifying)} of ${formatNumber(list.length)} Candidates still verifying`}
        >
          Cells fill in as Evidence lands. A check without Evidence is never shown as a pass.
        </Banner>
      )}
      <Section
        label="Evidence matrix"
        meta={
          failed ? (
            <>
              <StatusPill status="stale" />
              <span>updated {timeAgo(new Date(candidates.dataUpdatedAt).toISOString())}</span>
            </>
          ) : evidenceLoading ? (
            <span>Loading Evidence…</span>
          ) : (
            <Mono subtle>
              {formatNumber(items.reduce((n, i) => n + i.evidenceCount, 0))} Evidence records
            </Mono>
          )
        }
      >
        <ComparisonMatrix items={items} />
      </Section>
    </>
  );
}
