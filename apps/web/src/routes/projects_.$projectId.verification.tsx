import { Show } from "@clerk/tanstack-react-start";
import { Button, buttonVariants } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Banner } from "../components/candidate/banner";
import { isActive } from "../components/candidate/model";
import { CandidateSkeleton } from "../components/candidate/skeleton";
import { EmptyState } from "../components/ui/empty-state";
import { Mono } from "../components/ui/mono";
import { Page, PageTitle, Section } from "../components/ui/page";
import { StatusPill } from "../components/ui/status-pill";
import { CandidateTable } from "../components/verification-page/candidate-table";
import { HeatGrid } from "../components/verification-page/heat-grid";
import {
  buildModel,
  GRID_COLUMNS,
  kindsOf,
  type Stage,
  stagesOf,
  stats,
} from "../components/verification-page/model";
import { PipelineStrip, type StageCount } from "../components/verification-page/pipeline-strip";
import { VerificationStats } from "../components/verification-page/verification-stats";
import { getProject, getProjectVerification } from "../lib/api";
import { formatNumber, timeAgo } from "../lib/format";
import { loadOnServer, prefetch, prefetchProjectShell } from "../lib/ssr-data";

/**
 * Project-wide verification (AGENTS.md sections 34, 35, 38): how recent Candidates fared against
 * their required checks. Every verdict uses the Candidate model's gate rules, so a check without
 * `checked_supported` pass Evidence is a gap and never counts as met.
 */
export const Route = createFileRoute("/projects_/$projectId/verification")({
  // Server render: the stats, heat grid and Candidate table are in the first HTML.
  loader: ({ context: { queryClient }, params: { projectId } }) =>
    loadOnServer(queryClient, () =>
      Promise.all([
        prefetchProjectShell(queryClient, projectId),
        prefetch(queryClient, ["project-verification", projectId], () =>
          getProjectVerification({ data: projectId }),
        ),
      ]),
    ),
  component: VerificationPage,
});

const POLL_MS = 10_000;

const STAGE_NAMES: Record<Stage, string> = {
  composing: "Composing",
  verifying: "Verifying",
  verified: "Verified",
  rejected: "Rejected",
  promoted: "Promoted",
};

function VerificationPage() {
  return (
    <Page>
      <Show when="signed-in">
        <VerificationView />
      </Show>
      <Show when="signed-out">
        <PageTitle kicker="Verification" title="Verification" />
        <EmptyState
          what="Sign in to view verification."
          how="Candidates and their Evidence are visible to members of the Project's organization."
        />
      </Show>
    </Page>
  );
}

function VerificationView() {
  const { projectId } = Route.useParams();
  const [stage, setStage] = useState<Stage | null>(null);
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: projectId }),
  });
  const verification = useQuery({
    queryKey: ["project-verification", projectId],
    queryFn: () => getProjectVerification({ data: projectId }),
    refetchInterval: (query) =>
      !query.state.data || query.state.data.candidates.some(isActive) ? POLL_MS : false,
  });

  const data = verification.data;
  const items = useMemo(() => (data ? buildModel(data) : []), [data]);
  const summary = useMemo(() => stats(items), [items]);
  const kinds = useMemo(() => kindsOf(items.filter((i) => i.gridIndex !== null)), [items]);

  const title = (
    <PageTitle
      kicker={project.data?.name ?? "Project"}
      title="Verification"
      meta={
        <>
          <Mono>{projectId}</Mono>
          {data && (
            <span>
              {formatNumber(items.length)} recent Candidates · {formatNumber(data.changes.length)}{" "}
              Changes
            </span>
          )}
        </>
      }
      actions={
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          className={buttonVariants({ variant: "secondary" })}
        >
          Open the project
        </Link>
      }
    />
  );

  if (!data) {
    if (verification.isError) {
      return (
        <>
          {title}
          <Banner
            family="danger"
            title="Verification did not load"
            action={
              <Button
                size="sm"
                variant="secondary"
                className="ring-current"
                onClick={() => verification.refetch()}
              >
                Retry
              </Button>
            }
          >
            {verification.error.message}
          </Banner>
        </>
      );
    }
    return <CandidateSkeleton label="Loading verification" rows={8} />;
  }

  if (items.length === 0) {
    return (
      <>
        {title}
        <Section label="Candidates">
          <EmptyState
            what="No Candidate has been verified in this Project yet."
            how="A Candidate appears when a Change composes its ChangeSets; its checks run here."
            action={
              <Link
                to="/projects/$projectId"
                params={{ projectId }}
                className={buttonVariants({ variant: "secondary" })}
              >
                Open the project
              </Link>
            }
          />
        </Section>
      </>
    );
  }

  const reached = (s: Stage) => items.filter((i) => stagesOf(i.candidate).has(s)).length;
  const now = (status: string[]) => items.filter((i) => status.includes(i.candidate.status)).length;
  const stages: StageCount[] = [
    {
      stage: "composing",
      name: STAGE_NAMES.composing,
      count: reached("composing"),
      description: `${formatNumber(now(["composing", "composed"]))} composing now`,
    },
    {
      stage: "verifying",
      name: STAGE_NAMES.verifying,
      count: reached("verifying"),
      description: `${formatNumber(now(["verifying"]))} verifying now`,
    },
    {
      stage: "verified",
      name: STAGE_NAMES.verified,
      count: reached("verified"),
      description: "passed every required check",
    },
    {
      stage: "rejected",
      name: STAGE_NAMES.rejected,
      count: reached("rejected"),
      description: "failed a check or a decision",
    },
    {
      stage: "promoted",
      name: STAGE_NAMES.promoted,
      count: reached("promoted"),
      description: "advanced the canonical state",
    },
  ];

  const filtered = stage ? items.filter((i) => stagesOf(i.candidate).has(stage)) : items;
  const inFlight = summary.inFlight;
  const stale = verification.isError;

  return (
    <>
      {title}
      {inFlight > 0 && (
        <Banner
          family="progress"
          title={`${formatNumber(inFlight)} of ${formatNumber(items.length)} Candidates still verifying`}
        >
          Cells fill in as Evidence lands. A check without Evidence is never shown as a pass.
        </Banner>
      )}
      {data.evidenceTruncated && (
        <Banner family="attention" title="Some Evidence is not shown">
          This page reads at most 1,000 Evidence records. Checks without a loaded record show as
          gaps here; open a Candidate for its full Evidence.
        </Banner>
      )}

      <VerificationStats stats={summary} />

      <Section
        label="Pipeline"
        meta={
          stale ? (
            <>
              <StatusPill status="stale" />
              <span>updated {timeAgo(new Date(verification.dataUpdatedAt).toISOString())}</span>
            </>
          ) : (
            <span>Candidates that reached each stage</span>
          )
        }
      >
        <PipelineStrip stages={stages} selected={stage} onSelect={setStage} />
        {summary.stale > 0 && (
          <p className="text-[12px] text-kumo-subtle">
            {formatNumber(summary.stale)} stale{" "}
            {summary.stale === 1 ? "Candidate stops" : "Candidates stop"} at verifying: the
            canonical state moved after composition, so they cannot be promoted as composed.
          </p>
        )}
      </Section>

      <Section
        label="Checks by Candidate"
        meta={
          <Mono subtle>
            {formatNumber(kinds.length)} kinds ×{" "}
            {formatNumber(Math.min(items.length, GRID_COLUMNS))} Candidates
          </Mono>
        }
      >
        {kinds.length === 0 ? (
          <EmptyState
            what="No verification plan has been built yet."
            how="Rows appear once a Candidate finishes composition and its checks are planned."
          />
        ) : (
          <HeatGrid items={items} kinds={kinds} />
        )}
        <p className="text-[12px] text-kumo-subtle">
          Columns are the {formatNumber(GRID_COLUMNS)} most recent Candidates, oldest on the left;
          the number matches the # column below. A pass needs supported Evidence; a missing,
          skipped, timed-out or no-signal check is a gap.
        </p>
      </Section>

      <Section
        label="Recent Candidates"
        meta={
          <>
            {stage && (
              <Button size="sm" variant="ghost" onClick={() => setStage(null)}>
                Show all
              </Button>
            )}
            <Mono subtle>
              {stage
                ? `${formatNumber(filtered.length)} of ${formatNumber(items.length)} · ${STAGE_NAMES[stage].toLowerCase()}`
                : `1–${formatNumber(items.length)} of ${formatNumber(items.length)} · last ${formatNumber(data.limit)}`}
            </Mono>
          </>
        }
      >
        {filtered.length === 0 ? (
          <EmptyState
            what={`No recent Candidate reached ${STAGE_NAMES[stage ?? "composing"].toLowerCase()}.`}
            how="Choose another stage in the pipeline, or show all Candidates."
            action={
              <Button size="sm" variant="secondary" onClick={() => setStage(null)}>
                Show all
              </Button>
            }
          />
        ) : (
          <CandidateTable items={filtered} />
        )}
      </Section>
    </>
  );
}
