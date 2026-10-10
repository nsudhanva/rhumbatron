import { Show } from "@clerk/tanstack-react-start";
import { Button, buttonVariants } from "@cloudflare/kumo";
import { useQueries, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Banner } from "../components/candidate/banner";
import {
  type ComparedCandidate,
  ComparisonMatrix,
  resultSentence,
} from "../components/candidate/comparison-matrix";
import { candidateLabels, checkRows, isActive } from "../components/candidate/model";
import { CandidateSkeleton } from "../components/candidate/skeleton";
import { usePageMeta } from "../components/shell/page-meta";
import { EmptyState } from "../components/ui/empty-state";
import { Page, PageTitle, Section } from "../components/ui/page";
import { Term } from "../components/ui/term";
import { getChange, listCandidateEvidence, listCandidates } from "../lib/api";
import { formatNumber, generation, timeAgo, truncate } from "../lib/format";

/**
 * Compare versions of one Change (AGENTS.md section 38.4; spec B.2, B.3). Every version runs the
 * same checks, so a reader sees in under a minute which version the check results select and why.
 */
export const Route = createFileRoute("/compare/$changeId")({ component: ComparePage });

const POLL_MS = 10_000;

function ComparePage() {
  usePageMeta({ trail: [{ label: "Compare versions" }] });
  return (
    <Page>
      <Show when="signed-in">
        <CompareView />
      </Show>
      <Show when="signed-out">
        <EmptyState
          what="Sign in to compare versions."
          how="Versions belong to a project you are a member of."
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

  const title = (intro?: string) => (
    <PageTitle
      size="detail"
      title="Compare versions"
      meta={
        <>
          {change.data && (
            <Link
              to="/changes/$changeId"
              params={{ changeId }}
              title={change.data.goal}
              className="text-kumo-link hover:underline"
            >
              {truncate(change.data.goal, 90)}
            </Link>
          )}
          {change.data && (
            <>
              <span aria-hidden>·</span>
              <span>
                <Term k="basedOn" plain /> {generation(change.data.baseGeneration)}
              </span>
            </>
          )}
          {intro && <p className="basis-full pt-1 text-[14px] text-kumo-default">{intro}</p>}
        </>
      }
      actions={
        <Link
          to="/changes/$changeId"
          params={{ changeId }}
          className={buttonVariants({ variant: "secondary" })}
        >
          Back to the change
        </Link>
      }
    />
  );

  if (!candidates.data) {
    if (candidates.isError) {
      return (
        <>
          {title()}
          <Banner
            family="danger"
            title="Versions did not load"
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
    return <CandidateSkeleton label="Loading versions" rows={8} />;
  }

  if (list.length < 2) {
    return (
      <>
        {title()}
        <EmptyState
          what={
            list.length === 0
              ? "This change has no versions yet, so there is nothing to compare."
              : "This change has one version, so there is nothing to compare yet."
          }
          how="A second version appears when two agents choose different approaches and Rhumbatron builds both."
          action={
            <Link
              to="/changes/$changeId"
              params={{ changeId }}
              className={buttonVariants({ variant: "secondary" })}
            >
              Back to the change
            </Link>
          }
        />
      </>
    );
  }

  const labels = candidateLabels(list);
  const items: ComparedCandidate[] = list.map((candidate, index) => ({
    candidate,
    label: labels.get(candidate.id) ?? candidate.id,
    rows: checkRows(candidate, evidence[index]?.data ?? []),
  }));
  const loading = evidence.some((q) => q.isPending);
  const failed = evidence.some((q) => q.isError) || candidates.isError;
  const checking = list.filter(isActive).length;

  return (
    <>
      {title(loading ? undefined : resultSentence(items))}
      {checking > 0 && (
        <Banner
          family="progress"
          title={`${formatNumber(checking)} of ${formatNumber(list.length)} versions still being checked`}
        >
          Results fill in as checks finish. A check without a result never shows as passed.
        </Banner>
      )}
      <Section
        label={<Term k="checks" />}
        meta={
          failed ? (
            <span>
              Couldn't refresh · updated {timeAgo(new Date(candidates.dataUpdatedAt).toISOString())}
            </span>
          ) : loading ? (
            <span>Loading check results…</span>
          ) : (
            <span>{formatNumber(list.length)} versions</span>
          )
        }
      >
        <ComparisonMatrix items={items} />
        <p className="text-[12px] text-kumo-subtle">
          Decided by check results, never by model confidence.
        </p>
      </Section>
    </>
  );
}
